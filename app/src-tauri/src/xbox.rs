//! Xbox / Game Pass (WGS) save import. READ-ONLY: parses the Windows Gaming
//! Services container store in memory and loads it through the SAME pipeline as
//! folder saves (`pal_save::read_save_from_parts`). Nothing is written and no
//! save is converted on disk.
//!
//! Three commands drive the desktop Xbox flow:
//!  - [`detect_xbox_stores`] finds the local Game Pass save store(s),
//!  - [`list_xbox_worlds`] lists the worlds inside one store,
//!  - [`load_xbox_save`] extracts one world and summarizes it for the UI.
//!
//! A save-source *sentinel* string `xbox://<wgs_dir>#<save_id>` (see
//! [`parse_sentinel`]) lets the rest of the app treat an Xbox world like a
//! folder path: [`load_save_data`] is the one seam every roster-reading command
//! routes through, so the Solver / IV Lab work against Xbox saves unchanged.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::save::{to_summary, SaveSummary};

/// FILETIME epoch offset in milliseconds: the gap between 1601-01-01 and
/// 1970-01-01 (134774 days), expressed in ms (11_644_473_600 s).
const FILETIME_UNIX_OFFSET_MS: u64 = 11_644_473_600_000;

/// The install-package prefix Palworld's Game Pass build uses under `Packages`.
const PACKAGE_PREFIX: &str = "PocketpairInc.Palworld_";

/// Sentinel scheme marking a save source as an Xbox WGS world rather than a
/// filesystem folder: `xbox://<wgs_dir>#<save_id>`.
const XBOX_SENTINEL_PREFIX: &str = "xbox://";

/// A discovered Xbox WGS save store on this PC (one per Xbox user).
#[derive(Debug, Clone, Serialize)]
pub struct XboxStore {
    /// Absolute path to the per-user `wgs` dir (holds `containers.index`).
    pub wgs_dir: String,
    /// The 16-hex user id (the dir-name prefix before `_`).
    pub user_id: String,
}

/// One world inside an Xbox store, for the picker UI.
#[derive(Debug, Clone, Serialize)]
pub struct XboxWorld {
    /// Uppercase dashless 32-hex world-folder GUID (the WGS `SaveID`).
    pub save_id: String,
    /// World name from `LevelMeta.sav`, or `None` when it is absent/corrupt.
    pub world_name: Option<String>,
    /// Last-write time as unix milliseconds (converted from FILETIME ticks).
    pub mtime_ms: u64,
    /// Player-save count (excludes `_dps` dimensional-storage containers).
    pub player_count: u32,
}

/// Convert a Windows FILETIME (100ns ticks since 1601-01-01 UTC) to unix
/// milliseconds. Saturates at 0 so a zero/garbage tick never underflows.
fn filetime_ticks_to_unix_ms(ticks: u64) -> u64 {
    (ticks / 10_000).saturating_sub(FILETIME_UNIX_OFFSET_MS)
}

/// A WGS per-user dir name is exactly 16 hex + `_` + 32 hex (49 chars). This
/// strict shape inherently excludes the `t` scratch dir and any `*backup*` dir.
fn is_wgs_user_dir_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 49
        && bytes[16] == b'_'
        && bytes[..16].iter().all(u8::is_ascii_hexdigit)
        && bytes[17..].iter().all(u8::is_ascii_hexdigit)
}

/// Candidate `wgs` store roots to scan. The `PAL_LAB_WGS_ROOT` env var (the test
/// seam) points DIRECTLY at one `wgs` dir and, when set, replaces the real
/// `%LOCALAPPDATA%/Packages/PocketpairInc.Palworld_*/SystemAppData/wgs` scan.
fn candidate_wgs_roots() -> Vec<PathBuf> {
    if let Some(root) = std::env::var_os("PAL_LAB_WGS_ROOT") {
        let p = PathBuf::from(root);
        return if p.is_dir() { vec![p] } else { vec![] };
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return vec![];
    };
    let packages = Path::new(&local).join("Packages");
    let Ok(entries) = std::fs::read_dir(&packages) else {
        return vec![];
    };
    let mut roots = Vec::new();
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(PACKAGE_PREFIX)
        {
            let wgs = entry.path().join("SystemAppData").join("wgs");
            if wgs.is_dir() {
                roots.push(wgs);
            }
        }
    }
    roots
}

/// Detect the local Xbox / Game Pass Palworld save store(s). Read-only; returns
/// an empty vec when none exist. See [`candidate_wgs_roots`] for the env seam.
#[tauri::command]
pub fn detect_xbox_stores() -> Vec<XboxStore> {
    let mut stores = Vec::new();
    for root in candidate_wgs_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Skip the `t` scratch dir and any backup dir explicitly; the strict
            // 16hex_32hex check below already excludes them, but be defensive.
            if name.eq_ignore_ascii_case("t") || name.to_ascii_lowercase().contains("backup") {
                continue;
            }
            if !is_wgs_user_dir_name(&name) {
                continue;
            }
            // A real store holds a `containers.index`; skip empty/partial dirs.
            if !entry.path().join("containers.index").is_file() {
                continue;
            }
            let Some(user_id) = name.get(..16) else {
                continue;
            };
            stores.push(XboxStore {
                wgs_dir: entry.path().to_string_lossy().into_owned(),
                user_id: user_id.to_string(),
            });
        }
    }
    stores
}

/// Extract one world from a WGS store into raw (still-compressed) `.sav` bytes,
/// reading files lazily off disk relative to `wgs_dir` (store root).
fn extract(
    wgs_dir: &str,
    save_id: &str,
) -> Result<pal_save::wgs::ExtractedWorld, pal_save::SaveError> {
    let dir = PathBuf::from(wgs_dir);
    let mut read = |rel: &str| std::fs::read(dir.join(rel)).ok();
    pal_save::wgs::extract_world(&mut read, save_id)
}

/// List the worlds inside one Xbox store's `wgs_dir`. Read-only.
#[tauri::command]
pub fn list_xbox_worlds(wgs_dir: String) -> Result<Vec<XboxWorld>, String> {
    let dir = PathBuf::from(&wgs_dir);
    let mut read = |rel: &str| std::fs::read(dir.join(rel)).ok();
    let worlds = pal_save::wgs::list_worlds(&mut read).map_err(|e| e.to_string())?;
    Ok(worlds
        .into_iter()
        .map(|w| XboxWorld {
            save_id: w.save_id,
            world_name: w.world_name,
            mtime_ms: filetime_ticks_to_unix_ms(w.mtime_ticks),
            player_count: w.player_count,
        })
        .collect())
}

/// Load one Xbox world and summarize it for the UI, mirroring
/// [`crate::save::load_save`] exactly — extraction warnings are surfaced ahead
/// of the parser's own warnings.
#[tauri::command]
pub fn load_xbox_save(wgs_dir: String, save_id: String) -> Result<SaveSummary, String> {
    let extracted = extract(&wgs_dir, &save_id).map_err(|e| e.to_string())?;
    let warnings = extracted.warnings.clone();
    let save = pal_save::read_save_from_parts(
        &extracted.level,
        extracted.level_meta.as_deref(),
        &extracted.players,
        &extracted.dps,
    )
    .map_err(|e| e.to_string())?;
    let mut summary = to_summary(save);
    if !warnings.is_empty() {
        let mut combined = warnings;
        combined.extend(summary.warnings);
        summary.warnings = combined;
    }
    Ok(summary)
}

/// Parse an `xbox://<wgs_dir>#<save_id>` sentinel into `(wgs_dir, save_id)`, or
/// `None` when `s` is a plain folder path. The `#` split takes the LAST `#`
/// (mirroring the TS decoder) so a path that itself contains `#` still resolves
/// its trailing hex `save_id` correctly.
pub fn parse_sentinel(s: &str) -> Option<(String, String)> {
    let rest = s.strip_prefix(XBOX_SENTINEL_PREFIX)?;
    let (wgs_dir, save_id) = rest.rsplit_once('#')?;
    Some((wgs_dir.to_string(), save_id.to_string()))
}

/// Load a [`pal_save::SaveData`] from any save-source string: an Xbox sentinel
/// is extracted from the WGS store in memory and parsed through
/// [`pal_save::read_save_from_parts`]; anything else is a plain folder path read
/// via [`pal_save::read_save_dir`]. One seam so every command that reads the
/// owned roster transparently supports Xbox saves.
pub fn load_save_data(save_dir: &str) -> Result<pal_save::SaveData, pal_save::SaveError> {
    if crate::sftp::is_sentinel(save_dir) {
        return crate::sftp::load_save_data(save_dir).map_err(pal_save::SaveError::Layout);
    }
    if let Some((wgs_dir, save_id)) = parse_sentinel(save_dir) {
        let extracted = extract(&wgs_dir, &save_id)?;
        return pal_save::read_save_from_parts(
            &extracted.level,
            extracted.level_meta.as_deref(),
            &extracted.players,
            &extracted.dps,
        );
    }
    pal_save::read_save_dir(Path::new(save_dir))
}

/// Read `WorldOption.sav` for an Xbox world straight from the WGS store, parsed
/// via the byte-oriented pal-save fn. `Ok(None)` when the world ships no
/// `WorldOption` container — fail-soft to vanilla defaults, exactly like a
/// folder save with no `WorldOption.sav`.
pub fn read_world_options_xbox(
    wgs_dir: &str,
    save_id: &str,
) -> Result<Option<pal_save::worldoption::WorldOptions>, pal_save::SaveError> {
    let extracted = extract(wgs_dir, save_id)?;
    match extracted.world_option {
        Some(bytes) => pal_save::parse_world_options_sav(&bytes),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wgs_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/wgs1/0000000000000001_00000000000000000000000000000001")
    }

    fn wgs_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/wgs1")
    }

    fn steam_dir() -> String {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58")
            .to_string_lossy()
            .into_owned()
    }

    /// The fixture is generated by XboxCore; skip gracefully when it is absent
    /// so this test file never fails a checkout that lacks it.
    fn fixture_present() -> bool {
        let ok = wgs_dir().join("containers.index").is_file();
        if !ok {
            eprintln!("skip: wgs fixture missing at {}", wgs_dir().display());
        }
        ok
    }

    #[test]
    fn wgs_user_dir_name_matches_16_underscore_32_hex() {
        assert!(is_wgs_user_dir_name(
            "0000000000000001_00000000000000000000000000000001"
        ));
        assert!(!is_wgs_user_dir_name("t"));
        assert!(!is_wgs_user_dir_name(
            "0000000000000001-00000000000000000000000000000001"
        )); // wrong separator
        assert!(!is_wgs_user_dir_name(
            "000000000000000G_00000000000000000000000000000001"
        )); // non-hex
        assert!(!is_wgs_user_dir_name(
            "0000000000000001_0000000000000000000000000000000"
        )); // 31 hex tail
    }

    #[test]
    fn filetime_conversion_maps_epoch_to_zero() {
        // Unix epoch in FILETIME ticks: 11_644_473_600 s * 10^7 ticks/s.
        let epoch_ticks = 11_644_473_600u64 * 10_000_000;
        assert_eq!(filetime_ticks_to_unix_ms(epoch_ticks), 0);
        // One second past the unix epoch -> 1000 ms.
        assert_eq!(filetime_ticks_to_unix_ms(epoch_ticks + 10_000_000), 1000);
        // A pre-1970 / garbage tick saturates rather than underflows.
        assert_eq!(filetime_ticks_to_unix_ms(0), 0);
    }

    #[test]
    fn parse_sentinel_roundtrips() {
        assert_eq!(
            parse_sentinel("xbox://C:/foo/wgs/AAA_BBB#00000000000000000000000000000001"),
            Some((
                "C:/foo/wgs/AAA_BBB".to_string(),
                "00000000000000000000000000000001".to_string()
            ))
        );
        assert_eq!(parse_sentinel("C:/plain/save/path"), None);
        assert_eq!(parse_sentinel("xbox://no-hash"), None);
    }

    #[test]
    fn lists_the_fixture_world_with_its_name() {
        if !fixture_present() {
            return;
        }
        let worlds = list_xbox_worlds(wgs_dir().to_string_lossy().into_owned()).expect("list");
        assert_eq!(worlds.len(), 1, "expected exactly one world in the fixture");
        let w = &worlds[0];
        // The fixture is built from testdata/save1, so its LevelMeta yields the
        // same world name the folder load reports.
        let folder = crate::save::load_save(steam_dir()).expect("folder load");
        assert_eq!(
            w.world_name.as_deref(),
            Some(folder.world_name.as_str()),
            "world name should match the source save"
        );
        assert!(w.player_count >= 1, "expected at least one player");
        assert!(w.mtime_ms > 0, "expected a real last-write time");
    }

    #[test]
    fn xbox_load_matches_folder_load() {
        if !fixture_present() {
            return;
        }
        let worlds = list_xbox_worlds(wgs_dir().to_string_lossy().into_owned()).expect("list");
        let save_id = worlds[0].save_id.clone();
        let xbox = load_xbox_save(wgs_dir().to_string_lossy().into_owned(), save_id).expect("xbox");
        let folder = crate::save::load_save(steam_dir()).expect("folder");
        assert_eq!(
            xbox.pals.len(),
            folder.pals.len(),
            "xbox pal count must match the source folder save"
        );
        assert_eq!(xbox.players.len(), folder.players.len(), "player count");
        assert_eq!(xbox.world_name, folder.world_name, "world name");
    }

    #[test]
    fn load_save_data_seam_handles_both_sources() {
        if !fixture_present() {
            return;
        }
        let worlds = list_xbox_worlds(wgs_dir().to_string_lossy().into_owned()).expect("list");
        let sentinel = format!(
            "{XBOX_SENTINEL_PREFIX}{}#{}",
            wgs_dir().to_string_lossy(),
            worlds[0].save_id
        );
        let via_seam = load_save_data(&sentinel).expect("seam xbox load");
        let folder = pal_save::read_save_dir(std::path::Path::new(&steam_dir())).expect("folder");
        assert_eq!(via_seam.pals.len(), folder.pals.len(), "seam roster parity");
    }

    #[test]
    fn detect_via_env_override_finds_the_store() {
        if !fixture_present() {
            return;
        }
        std::env::set_var("PAL_LAB_WGS_ROOT", wgs_root());
        let stores = detect_xbox_stores();
        std::env::remove_var("PAL_LAB_WGS_ROOT");
        assert_eq!(stores.len(), 1, "one store under the override root");
        assert_eq!(stores[0].user_id, "0000000000000001");
        assert!(stores[0].wgs_dir.ends_with("0000000000000001_00000000000000000000000000000001"));
    }
}
