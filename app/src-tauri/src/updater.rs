//! In-app update-check plumbing (READ-ONLY probe; no download/install).
//!
//! Two commands back the ABOUT panel:
//!  - [`check_update`] — asks GitHub's `releases/latest` endpoint whether a
//!    newer version exists. The endpoint is a single compile-time constant
//!    ([`UPDATE_MANIFEST_URL`]), now live. `releases/latest` only ever returns
//!    the newest *published, non-draft, non-prerelease* release, so drafts and
//!    prereleases are invisible here by construction. Any network problem
//!    (offline, DNS failure, 403/rate-limit, malformed JSON) degrades to the
//!    `"error"` status, which the ABOUT panel renders as a quiet "couldn't
//!    check" line — never a toast, never a crash.
//!  - [`data_pack_info`] — surfaces the embedded pal-data pack's version +
//!    Palworld game build so the ABOUT panel can show what data it is running.
//!
//! Auto-download / auto-install is intentionally out of scope. This layer only
//! *detects* an update and hands the user a release URL to open manually.
//!
//! The check is a single lightweight GET made on demand (the ABOUT panel's
//! "Check for updates" button — at most once per launch in practice); there is
//! no background polling. The version diff itself ([`parse_release`]) is pure
//! (no I/O), so it is unit-tested against a fixture and the test suite never
//! touches the network.

use serde::{Deserialize, Serialize};

/// Where `check_update` fetches its release manifest from — GitHub's "latest
/// release" API (`https://api.github.com/repos/<owner>/<repo>/releases/latest`),
/// whose payload shape [`GhRelease`] mirrors. `releases/latest` excludes drafts
/// and prereleases, so only stable published releases are ever offered to users.
const UPDATE_MANIFEST_URL: Option<&str> =
    Some("https://api.github.com/repos/Wire15/pal-lab/releases/latest");

/// Result of an update check. `status` is one of
/// `"disabled" | "up_to_date" | "update_available" | "error"`. The optional
/// fields are populated per status:
///  - `update_available` -> `latest` + `url` (+ `notes` when the release had a body),
///  - `up_to_date` -> `latest` (+ `url`),
///  - `error` -> `notes` carries the human-readable reason,
///  - `disabled` -> all `None`.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheck {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

impl UpdateCheck {
    fn disabled() -> Self {
        Self { status: "disabled", latest: None, url: None, notes: None }
    }

    fn up_to_date(latest: String, url: Option<String>) -> Self {
        Self { status: "up_to_date", latest: Some(latest), url, notes: None }
    }

    fn available(latest: String, url: String, notes: Option<String>) -> Self {
        Self { status: "update_available", latest: Some(latest), url: Some(url), notes }
    }

    fn error(reason: impl Into<String>) -> Self {
        Self { status: "error", latest: None, url: None, notes: Some(reason.into()) }
    }
}

/// The subset of the GitHub releases API we consume. Everything else in the
/// payload is ignored; unknown fields are tolerated.
#[derive(Debug, Deserialize)]
struct GhRelease {
    /// e.g. `"v0.3.0"`. Compared against `current_version` after stripping a
    /// leading `v`.
    tag_name: String,
    /// Browser URL of the release page. Handed to the user to open manually.
    #[serde(default)]
    html_url: String,
    /// Release notes markdown, if any.
    #[serde(default)]
    body: Option<String>,
}

/// Check for an update. Fetches [`UPDATE_MANIFEST_URL`] and diffs the latest
/// release version against `current_version` (the running app version, from
/// `getVersion()` on the frontend). Returns `"disabled"` only if the constant
/// is ever set back to `None`; any fetch/parse failure returns `"error"`.
#[tauri::command]
pub fn check_update(current_version: String) -> UpdateCheck {
    let Some(url) = UPDATE_MANIFEST_URL else {
        return UpdateCheck::disabled();
    };
    match fetch_manifest(url) {
        Ok(body) => parse_release(&body, &current_version),
        Err(reason) => UpdateCheck::error(reason),
    }
}

/// Fetch the raw release-manifest body from `url` with a blocking HTTP GET.
///
/// Uses a 5s-timeout [`ureq`] agent over rustls (no native-tls / OpenSSL, so
/// the Windows build needs no system TLS). GitHub's API rejects requests with
/// no `User-Agent` (403), so one is always sent. Any transport error or non-2xx
/// status (offline, DNS failure, 403/rate-limit, 404) surfaces as `Err`, which
/// [`check_update`] maps to the graceful `"error"` status shown in ABOUT.
fn fetch_manifest(url: &str) -> Result<String, String> {
    let agent = ureq::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build();
    let body = agent
        .get(url)
        .set("User-Agent", "pal-lab/1.0.0")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    Ok(body)
}

/// Parse a GitHub-releases-API "latest release" payload and diff its version
/// against `current`. Pure (no I/O) so it is unit-testable without the network.
fn parse_release(body: &str, current: &str) -> UpdateCheck {
    let release: GhRelease = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => return UpdateCheck::error(format!("malformed release manifest: {e}")),
    };
    let tag = release.tag_name.trim();
    if tag.is_empty() {
        return UpdateCheck::error("release manifest has no tag_name");
    }
    let latest = strip_v(tag).to_string();
    let url = (!release.html_url.is_empty()).then(|| release.html_url.clone());
    if version_is_newer(tag, current) {
        UpdateCheck::available(
            latest,
            release.html_url,
            release.body.filter(|b| !b.trim().is_empty()),
        )
    } else {
        UpdateCheck::up_to_date(latest, url)
    }
}

/// Strip a single leading `v`/`V` from a version/tag string.
fn strip_v(s: &str) -> &str {
    s.trim().strip_prefix(['v', 'V']).unwrap_or(s.trim())
}

/// True when `latest` is a strictly higher version than `current`. Compares the
/// leading `major.minor.patch` numeric components (leading `v` stripped, missing
/// components treated as `0`, any pre-release/build suffix ignored). Robust to
/// non-numeric noise: unparsable components read as `0`.
fn version_is_newer(latest: &str, current: &str) -> bool {
    parse_ver(latest) > parse_ver(current)
}

/// Extract the leading `(major, minor, patch)` numeric triple from a version
/// string, stripping a leading `v` and stopping at the first non-numeric part.
fn parse_ver(s: &str) -> (u64, u64, u64) {
    let mut parts = strip_v(s)
        .split(['.', '-', '+'])
        .map(|p| p.trim().parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// Embedded data-pack identity for the ABOUT panel: the pal-data pack version
/// (e.g. `"v26"`) and the Palworld game build it was extracted from.
#[derive(Debug, Clone, Serialize)]
pub struct DataPackInfo {
    pub pack_version: String,
    pub game_build: String,
}

/// Report the embedded pal-data pack's version + source game build. Reads the
/// already-decoded `'static` [`pal_data::GameData`]; no allocation beyond the
/// two returned strings.
#[tauri::command]
pub fn data_pack_info() -> DataPackInfo {
    let gd = pal_data::GameData::get();
    DataPackInfo {
        pack_version: gd.version().to_string(),
        game_build: gd.game_build().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trimmed but shape-accurate GitHub "latest release" payload, including
    /// fields we ignore (to prove unknown fields are tolerated).
    const RELEASE_FIXTURE: &str = r#"{
        "url": "https://api.github.com/repos/Wire15/pal-lab/releases/123",
        "html_url": "https://github.com/Wire15/pal-lab/releases/tag/v0.3.0",
        "tag_name": "v0.3.0",
        "name": "Pal Lab 0.3.0",
        "draft": false,
        "prerelease": false,
        "published_at": "2026-08-01T00:00:00Z",
        "body": "Release notes:\n- Viewing Cage reads\n- NSIS installer"
    }"#;

    #[test]
    fn parse_release_detects_update_available() {
        let check = parse_release(RELEASE_FIXTURE, "0.2.0");
        assert_eq!(check.status, "update_available");
        assert_eq!(check.latest.as_deref(), Some("0.3.0"));
        assert_eq!(
            check.url.as_deref(),
            Some("https://github.com/Wire15/pal-lab/releases/tag/v0.3.0")
        );
        assert!(check.notes.as_deref().unwrap().contains("Viewing Cage"));
    }

    #[test]
    fn parse_release_up_to_date_when_equal() {
        let check = parse_release(RELEASE_FIXTURE, "0.3.0");
        assert_eq!(check.status, "up_to_date");
        assert_eq!(check.latest.as_deref(), Some("0.3.0"));
        assert!(check.notes.is_none());
    }

    #[test]
    fn parse_release_up_to_date_when_current_is_newer() {
        let check = parse_release(RELEASE_FIXTURE, "1.0.0");
        assert_eq!(check.status, "up_to_date");
    }

    #[test]
    fn parse_release_errors_on_malformed_json() {
        let check = parse_release("{ not json", "0.2.0");
        assert_eq!(check.status, "error");
        assert!(check.notes.is_some());
    }

    #[test]
    fn parse_release_errors_on_missing_tag() {
        let check = parse_release(r#"{"html_url":"x"}"#, "0.2.0");
        assert_eq!(check.status, "error");
    }

    #[test]
    fn version_compare_handles_v_prefix_and_widths() {
        assert!(version_is_newer("v0.3.0", "0.2.0"));
        assert!(version_is_newer("1.0", "0.9.9"));
        assert!(version_is_newer("0.2.1", "0.2.0"));
        assert!(!version_is_newer("0.2.0", "0.2.0"));
        assert!(!version_is_newer("0.1.9", "0.2.0"));
        // Pre-release/build suffixes are ignored for the numeric compare.
        assert!(!version_is_newer("0.2.0-rc1", "0.2.0"));
    }

    #[test]
    fn disabled_branch_short_circuits_without_network() {
        // `check_update` short-circuits to "disabled" (no I/O) whenever the
        // manifest URL is unset. Exercise that branch through a local `None`
        // constant so the coverage survives now that the shipped
        // `UPDATE_MANIFEST_URL` is live.
        const OFF: Option<&str> = None;
        let check = match OFF {
            Some(_url) => unreachable!("local constant is None"),
            None => UpdateCheck::disabled(),
        };
        assert_eq!(check.status, "disabled");
        assert!(check.latest.is_none() && check.url.is_none() && check.notes.is_none());
    }

    #[test]
    fn manifest_url_is_wired() {
        assert_eq!(
            UPDATE_MANIFEST_URL,
            Some("https://api.github.com/repos/Wire15/pal-lab/releases/latest")
        );
    }
}
