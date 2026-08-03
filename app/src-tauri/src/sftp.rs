//! SFTP dedicated-server save loading. READ-ONLY: this module NEVER writes to
//! the remote server — it opens a russh SFTP session, downloads the `.sav`
//! parts into memory, and parses them through the SAME pipeline as folder / Xbox
//! saves (`pal_save::read_save_from_parts`).
//!
//! A save-source *sentinel* string `sftp://<user>@<host>:<port>#<remote_world_dir>`
//! (see [`parse_sentinel`]) lets the rest of the app treat a remote world like a
//! folder path: [`load_save_data`] / [`read_world_options`] are the seams the
//! Solver / IV Lab route through, so they work against SFTP saves unchanged.
//!
//! A single live connection lives in the managed [`SftpManager`] state. The
//! commands ([`sftp_connect`], [`sftp_load_save`], [`sftp_watch`],
//! [`sftp_unwatch`], [`sftp_disconnect`]) drive the desktop SFTP flow;
//! [`load_save_data`] bridges the async session into the synchronous solver via
//! Tauri's runtime (spawn + block-on-channel), never a nested runtime.

#![allow(async_fn_in_trait)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{async_runtime, AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use russh::client::{self, AuthResult, Handle, Handler};
use russh::keys::ssh_key::PublicKey;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;

use crate::save::{to_summary, SaveSummary};

/// Sentinel scheme marking a save source as a remote SFTP world rather than a
/// local folder: `sftp://<user>@<host>:<port>#<remote_world_dir>`.
const SFTP_SENTINEL_PREFIX: &str = "sftp://";

/// Known-hosts store filename under the Tauri app config dir. Maps `host:port`
/// to a pinned SHA256 host-key fingerprint. Secrets NEVER touch this file.
const KNOWN_HOSTS_FILE: &str = "pal-lab.sftp.knownHosts.json";

/// TCP + SSH handshake budget for [`sftp_connect`].
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Skip `LocalData.sav` above this size (bytes) — a runaway map blob must not
/// stall every reload. Emitted as a log warning when skipped.
const MAX_LOCAL_DATA: u64 = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Wire types (serde snake_case, matching the pinned cross-slice contract).
// ---------------------------------------------------------------------------

/// Connection profile sent by the UI. NO secrets — persisted TS-side in
/// localStorage and used to prefill the connect modal / boot-restore.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// `"password"` or `"key"`.
    pub auth: String,
    /// Path to the private key file, for `auth == "key"`.
    pub key_path: Option<String>,
    /// Remote dir to scan: a world dir, a `SaveGames` dir, or a server base dir.
    pub root: String,
}

/// Secret material for a connect attempt. Held in memory only, NEVER written to
/// disk and never serialized back to the UI.
#[derive(Clone, Deserialize)]
pub struct SftpSecret {
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
}

/// One discovered remote world, for the picker UI.
#[derive(Debug, Clone, Serialize)]
pub struct SftpWorld {
    /// Absolute remote path of the folder containing `Level.sav`.
    pub world_dir: String,
    /// World name from `LevelMeta.sav`, or `None` when absent/unreadable.
    pub world_name: Option<String>,
    /// Human player-save count (`Players/<uid>.sav`, excludes `_dps`).
    pub players: u32,
    /// `Level.sav` mtime as unix milliseconds.
    pub mtime_ms: u64,
}

/// Result of [`sftp_connect`].
#[derive(Debug, Clone, Serialize)]
pub struct SftpConnectInfo {
    /// SHA256 host-key fingerprint (`"SHA256:<base64>"`).
    pub fingerprint: String,
    /// True only when the presented fingerprint MATCHED a prior stored entry;
    /// false when this host was first-seen (fingerprint stored this call).
    pub known: bool,
    pub worlds: Vec<SftpWorld>,
}

// ---------------------------------------------------------------------------
// Sentinel parse / format.
// ---------------------------------------------------------------------------

/// A parsed SFTP sentinel: the connection authority plus the remote world dir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SftpTarget {
    pub user: String,
    pub host: String,
    pub port: u16,
    /// Absolute remote path of the folder containing `Level.sav`.
    pub world_dir: String,
}

/// Whether `s` is an SFTP save-source sentinel.
pub fn is_sentinel(s: &str) -> bool {
    s.starts_with(SFTP_SENTINEL_PREFIX)
}

/// Build a sentinel string from its parts.
/// (Built TS-side per the pinned contract; retained + tested for round-trip
/// symmetry with [`parse_sentinel`].)
#[allow(dead_code)]
pub fn format_sentinel(user: &str, host: &str, port: u16, world_dir: &str) -> String {
    format!("{SFTP_SENTINEL_PREFIX}{user}@{host}:{port}#{world_dir}")
}

/// Parse `sftp://<user>@<host>:<port>#<remote_world_dir>` into an [`SftpTarget`],
/// or `None` when `s` is not a well-formed SFTP sentinel. The `#` split takes
/// the LAST `#` so a world dir that itself contains `#` still resolves. The
/// authority `host:port` split takes the LAST `:` so the user (before `@`) is
/// isolated first.
pub fn parse_sentinel(s: &str) -> Option<SftpTarget> {
    let rest = s.strip_prefix(SFTP_SENTINEL_PREFIX)?;
    let (authority, world_dir) = rest.rsplit_once('#')?;
    if world_dir.is_empty() {
        return None;
    }
    let (user, host_port) = authority.split_once('@')?;
    let (host, port) = host_port.rsplit_once(':')?;
    if user.is_empty() || host.is_empty() {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    Some(SftpTarget {
        user: user.to_string(),
        host: host.to_string(),
        port,
        world_dir: world_dir.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Remote filesystem abstraction (testable without a live server).
// ---------------------------------------------------------------------------

/// One directory entry from a remote listing.
#[derive(Debug, Clone)]
struct RemoteEntry {
    name: String,
    is_dir: bool,
}

/// A remote file's stat: byte size + mtime as unix milliseconds.
#[derive(Debug, Clone, Copy)]
struct RemoteStat {
    size: u64,
    mtime_ms: u64,
}

/// Minimal remote-FS seam the scan / bundle / watch logic runs against. The
/// russh impl ([`SftpFs`]) is a thin wrapper; tests drive a pure in-memory mock.
trait RemoteFs {
    async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, String>;
    async fn stat(&self, path: &str) -> Result<RemoteStat, String>;
    async fn read(&self, path: &str) -> Result<Vec<u8>, String>;
}

/// Join a remote absolute base with a child name using `/` (SFTP paths).
fn join(base: &str, child: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), child)
}

/// Thin [`RemoteFs`] over a live russh-sftp session.
struct SftpFs<'a>(&'a SftpSession);

impl RemoteFs for SftpFs<'_> {
    async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
        let rd = self.0.read_dir(path).await.map_err(|e| e.to_string())?;
        Ok(rd
            .map(|e| RemoteEntry {
                name: e.file_name(),
                is_dir: e.file_type().is_dir(),
            })
            .collect())
    }

    async fn stat(&self, path: &str) -> Result<RemoteStat, String> {
        let m = self.0.metadata(path).await.map_err(|e| e.to_string())?;
        Ok(RemoteStat {
            size: m.size.unwrap_or(0),
            // SFTP v3 mtime is whole unix seconds.
            mtime_ms: m.mtime.map(|s| s as u64 * 1000).unwrap_or(0),
        })
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        self.0.read(path).await.map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Scan + bundle logic (over the RemoteFs seam).
// ---------------------------------------------------------------------------

/// The in-memory `.sav` parts of one downloaded world.
#[derive(Debug)]
struct Bundle {
    level: Vec<u8>,
    level_meta: Option<Vec<u8>>,
    world_option: Option<Vec<u8>>,
    /// Fetched per contract (< 32 MiB); no summary seam consumes it yet.
    #[allow(dead_code)]
    local_data: Option<Vec<u8>>,
    /// Regular per-player saves, labelled `"<uid>.sav"`.
    players: Vec<(String, Vec<u8>)>,
    /// `*_dps.sav` dimensional-storage files.
    dps: Vec<(String, Vec<u8>)>,
}

/// Discover worlds under `root`: if `root` itself holds `Level.sav` it is the
/// single world; otherwise scan depth <= 2 for dirs containing `Level.sav`
/// (covers `SaveGames/<id>/<world>`). For each world, best-effort world name
/// (from `LevelMeta.sav`), human player count, and `Level.sav` mtime.
async fn scan_worlds<F: RemoteFs>(fs: &F, root: &str) -> Result<Vec<SftpWorld>, String> {
    let root = root.trim_end_matches('/');
    let root = if root.is_empty() { "/" } else { root };

    let mut world_dirs: Vec<String> = Vec::new();
    if fs.stat(&join(root, "Level.sav")).await.is_ok() {
        world_dirs.push(root.to_string());
    } else {
        let level1 = fs
            .list(root)
            .await
            .map_err(|e| format!("listing {root}: {e}"))?;
        for d1 in level1.iter().filter(|e| e.is_dir) {
            let p1 = join(root, &d1.name);
            if fs.stat(&join(&p1, "Level.sav")).await.is_ok() {
                world_dirs.push(p1);
                continue;
            }
            // depth 2
            if let Ok(level2) = fs.list(&p1).await {
                for d2 in level2.iter().filter(|e| e.is_dir) {
                    let p2 = join(&p1, &d2.name);
                    if fs.stat(&join(&p2, "Level.sav")).await.is_ok() {
                        world_dirs.push(p2);
                    }
                }
            }
        }
    }

    let mut out = Vec::with_capacity(world_dirs.len());
    for wd in world_dirs {
        let level_stat = fs
            .stat(&join(&wd, "Level.sav"))
            .await
            .map_err(|e| format!("stat Level.sav in {wd}: {e}"))?;
        let world_name = match fs.read(&join(&wd, "LevelMeta.sav")).await {
            Ok(bytes) => pal_save::compress::decompress_sav(&bytes)
                .ok()
                .and_then(|blob| pal_save::characters::parse_world_name(&blob).ok().flatten()),
            Err(_) => None,
        };
        let players = match fs.list(&join(&wd, "Players")).await {
            Ok(entries) => entries
                .iter()
                .filter(|e| {
                    !e.is_dir && e.name.ends_with(".sav") && !e.name.ends_with("_dps.sav")
                })
                .count() as u32,
            Err(_) => 0,
        };
        out.push(SftpWorld {
            world_dir: wd,
            world_name,
            players,
            mtime_ms: level_stat.mtime_ms,
        });
    }
    Ok(out)
}

/// Download every `.sav` part of `world_dir` into memory. `Level.sav` is
/// required; `LevelMeta` / `WorldOption` / `LocalData` are optional. `LocalData`
/// above [`MAX_LOCAL_DATA`] is skipped with a log warning.
async fn download_bundle<F: RemoteFs>(fs: &F, world_dir: &str) -> Result<Bundle, String> {
    let base = world_dir.trim_end_matches('/');

    let level = fs
        .read(&join(base, "Level.sav"))
        .await
        .map_err(|e| format!("Level.sav: {e}"))?;
    let level_meta = fs.read(&join(base, "LevelMeta.sav")).await.ok();
    let world_option = fs.read(&join(base, "WorldOption.sav")).await.ok();

    let local_path = join(base, "LocalData.sav");
    let local_data = match fs.stat(&local_path).await {
        Ok(s) if s.size <= MAX_LOCAL_DATA => fs.read(&local_path).await.ok(),
        Ok(s) => {
            eprintln!(
                "sftp: skipping LocalData.sav ({} bytes > {} MiB cap) in {base}",
                s.size,
                MAX_LOCAL_DATA / (1024 * 1024)
            );
            None
        }
        Err(_) => None,
    };

    let mut players = Vec::new();
    let mut dps = Vec::new();
    if let Ok(entries) = fs.list(&join(base, "Players")).await {
        for e in entries {
            if e.is_dir || !e.name.ends_with(".sav") {
                continue;
            }
            let p = join(&join(base, "Players"), &e.name);
            let Ok(bytes) = fs.read(&p).await else { continue };
            if e.name.ends_with("_dps.sav") {
                dps.push((e.name, bytes));
            } else {
                players.push((e.name, bytes));
            }
        }
    }

    Ok(Bundle {
        level,
        level_meta,
        world_option,
        local_data,
        players,
        dps,
    })
}

// ---------------------------------------------------------------------------
// Known-hosts store.
// ---------------------------------------------------------------------------

/// Read the known-hosts map (`host:port` -> fingerprint). Best-effort: a missing
/// or corrupt file yields an empty map.
fn load_known_hosts(path: &Path) -> HashMap<String, String> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Persist the known-hosts map, creating the parent config dir if needed.
fn save_known_hosts(path: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("creating config dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("writing known hosts: {e}"))
}

/// Verify a presented host-key fingerprint against the store at `path`.
/// - matches stored  => `Ok(true)`  (known host)
/// - first-ever-seen => store it, `Ok(false)`
/// - CHANGED         => `Err(..)` naming both fingerprints (honest MITM warning)
fn verify_against_store(
    path: &Path,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<bool, String> {
    let key = format!("{host}:{port}");
    let mut map = load_known_hosts(path);
    match map.get(&key) {
        Some(stored) if stored == fingerprint => Ok(true),
        Some(stored) => Err(format!(
            "SSH host key MISMATCH for {key}: stored fingerprint {stored} but the server presented \
             {fingerprint}. Refusing to connect — this can indicate a man-in-the-middle attack. If \
             you intentionally rotated the server's host key, remove the {key} entry from {}.",
            path.display()
        )),
        None => {
            map.insert(key, fingerprint.to_string());
            save_known_hosts(path, &map)?;
            Ok(false)
        }
    }
}

/// Resolve the known-hosts file path under the Tauri app config dir.
fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolving app config dir: {e}"))?;
    Ok(dir.join(KNOWN_HOSTS_FILE))
}

// ---------------------------------------------------------------------------
// russh client handler + connect.
// ---------------------------------------------------------------------------

/// russh client handler. Captures the server's SHA256 host-key fingerprint into
/// a shared slot; the known-hosts decision is made AFTER the handshake (before
/// auth) so a mismatch error can name both fingerprints and no credentials are
/// ever sent to an unverified server.
struct ClientHandler {
    fingerprint: Arc<std::sync::Mutex<Option<String>>>,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        *self.fingerprint.lock().unwrap() = Some(fp);
        Ok(true)
    }
}

/// Open a TCP + SSH connection, verify the host key, authenticate, and open the
/// SFTP subsystem. Returns the live handle, an `Arc`-shared SFTP session, the
/// host-key fingerprint, and whether the host was already known.
async fn do_connect(
    app: &AppHandle,
    profile: &SftpProfile,
    secret: &SftpSecret,
) -> Result<(Handle<ClientHandler>, Arc<SftpSession>, String, bool), String> {
    let config = Arc::new(client::Config::default());
    let fp_slot: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler {
        fingerprint: fp_slot.clone(),
    };

    let connect = client::connect(config, (profile.host.as_str(), profile.port), handler);
    let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| {
            format!(
                "connection to {}:{} timed out after {}s",
                profile.host,
                profile.port,
                CONNECT_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("ssh connect failed: {e}"))?;

    let fingerprint = fp_slot
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "server presented no host key".to_string())?;

    // Host-key decision before any credential leaves this process.
    let path = known_hosts_path(app)?;
    let known = verify_against_store(&path, &profile.host, profile.port, &fingerprint)?;

    let auth = match profile.auth.as_str() {
        "password" => {
            let pw = secret
                .password
                .as_deref()
                .ok_or_else(|| "password required for password auth".to_string())?;
            handle
                .authenticate_password(profile.user.as_str(), pw)
                .await
                .map_err(|e| format!("auth error: {e}"))?
        }
        "key" => {
            let kp = profile
                .key_path
                .as_deref()
                .ok_or_else(|| "key_path required for key auth".to_string())?;
            let key = load_secret_key(kp, secret.key_passphrase.as_deref())
                .map_err(|e| format!("loading key {kp}: {e}"))?;
            // None hash-alg: correct for Ed25519/ECDSA; russh negotiates the RSA
            // hash if needed.
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle
                .authenticate_publickey(profile.user.as_str(), key)
                .await
                .map_err(|e| format!("auth error: {e}"))?
        }
        other => return Err(format!("unknown auth method: {other} (expected password|key)")),
    };
    if !matches!(auth, AuthResult::Success) {
        return Err("authentication failed (bad credentials or method not allowed)".to_string());
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("opening ssh channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("requesting sftp subsystem: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("initializing sftp: {e}"))?;

    Ok((handle, Arc::new(sftp), fingerprint, known))
}

// ---------------------------------------------------------------------------
// Managed connection state.
// ---------------------------------------------------------------------------

/// The one live SFTP connection.
struct Active {
    /// Kept alive to hold the SSH connection open; dropping it disconnects.
    #[allow(dead_code)]
    handle: Handle<ClientHandler>,
    sftp: Arc<SftpSession>,
    profile: SftpProfile,
    /// In-memory only, for potential reconnect; NEVER persisted.
    #[allow(dead_code)]
    secret: SftpSecret,
}

/// A cached download, keyed by world dir and validated by `Level.sav` mtime.
struct Cached {
    level_mtime_ms: u64,
    bundle: Arc<Bundle>,
}

#[derive(Default)]
struct Inner {
    session: Option<Active>,
    cache: HashMap<String, Cached>,
    watch: Option<async_runtime::JoinHandle<()>>,
}

/// Managed Tauri state: the single active SFTP connection, its download cache,
/// and the live mtime-poll watch task.
pub struct SftpManager {
    inner: Mutex<Inner>,
}

impl SftpManager {
    fn new() -> Self {
        SftpManager {
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Connect (atomically replacing any prior connection and aborting any prior
    /// watch), then scan `profile.root` for worlds.
    async fn connect(
        &self,
        app: &AppHandle,
        profile: SftpProfile,
        secret: SftpSecret,
    ) -> Result<SftpConnectInfo, String> {
        // Tear down any prior connection + watch first (clean world A->B switch).
        {
            let mut inner = self.inner.lock().await;
            if let Some(h) = inner.watch.take() {
                h.abort();
            }
            inner.session = None;
            inner.cache.clear();
        }

        let (handle, sftp, fingerprint, known) = do_connect(app, &profile, &secret).await?;
        let worlds = scan_worlds(&SftpFs(&sftp), &profile.root).await?;

        let mut inner = self.inner.lock().await;
        inner.session = Some(Active {
            handle,
            sftp,
            profile,
            secret,
        });
        Ok(SftpConnectInfo {
            fingerprint,
            known,
            worlds,
        })
    }

    /// Load (or reuse the cached) bundle for `target`, requiring an active
    /// connection whose authority matches the sentinel. Caches by `Level.sav`
    /// mtime; a matching mtime reuses the cached bundle with no re-download.
    async fn load_bundle(&self, target: &SftpTarget) -> Result<Arc<Bundle>, String> {
        // Snapshot the session + any cached bundle, then do network I/O unlocked.
        let (sftp, cached) = {
            let inner = self.inner.lock().await;
            let active = inner.session.as_ref().ok_or("Not connected")?;
            require_authority_match(&active.profile, target)?;
            let cached = inner
                .cache
                .get(&target.world_dir)
                .map(|c| (c.level_mtime_ms, c.bundle.clone()));
            (active.sftp.clone(), cached)
        };

        let level_path = join(&target.world_dir, "Level.sav");
        let stat = SftpFs(&sftp).stat(&level_path).await?;

        if let Some((mtime, bundle)) = cached {
            if mtime == stat.mtime_ms {
                return Ok(bundle);
            }
        }

        let bundle = Arc::new(download_bundle(&SftpFs(&sftp), &target.world_dir).await?);

        // Re-lock to publish the cache entry (only if the session still matches,
        // so a concurrent reconnect doesn't get polluted with a stale entry).
        let mut inner = self.inner.lock().await;
        if inner
            .session
            .as_ref()
            .is_some_and(|a| require_authority_match(&a.profile, target).is_ok())
        {
            inner.cache.insert(
                target.world_dir.clone(),
                Cached {
                    level_mtime_ms: stat.mtime_ms,
                    bundle: bundle.clone(),
                },
            );
        }
        Ok(bundle)
    }

    /// Start (or replace) a poll-based watch on the sentinel's `Level.sav`,
    /// emitting `save-changed` `{ save_dir: sentinel }` on each mtime change.
    async fn watch(
        self: Arc<Self>,
        app: AppHandle,
        sentinel: String,
        interval_secs: u32,
    ) -> Result<(), String> {
        let target = parse_sentinel(&sentinel).ok_or("malformed sftp sentinel")?;
        let interval = Duration::from_secs(interval_secs.clamp(15, 600) as u64);
        let level_path = join(&target.world_dir, "Level.sav");

        // Replace any prior watch; snapshot the live session for the baseline.
        let sftp = {
            let mut inner = self.inner.lock().await;
            if let Some(h) = inner.watch.take() {
                h.abort();
            }
            let active = inner.session.as_ref().ok_or("Not connected")?;
            require_authority_match(&active.profile, &target)?;
            active.sftp.clone()
        };

        let mut last_mtime = SftpFs(&sftp)
            .stat(&level_path)
            .await
            .map(|s| s.mtime_ms)
            .unwrap_or(0);

        let me = self.clone();
        let handle = async_runtime::spawn(async move {
            let mut logged_fail = false;
            loop {
                tokio::time::sleep(interval).await;
                // Re-fetch the current session each tick (it may be replaced or
                // dropped); a gone session stops the watch.
                let sftp = {
                    let inner = me.inner.lock().await;
                    match inner.session.as_ref() {
                        Some(a) => a.sftp.clone(),
                        None => break,
                    }
                };
                match SftpFs(&sftp).stat(&level_path).await {
                    Ok(s) => {
                        logged_fail = false;
                        if last_mtime != 0 && s.mtime_ms != last_mtime {
                            let _ = app.emit(
                                "save-changed",
                                SaveChanged {
                                    save_dir: sentinel.clone(),
                                },
                            );
                        }
                        last_mtime = s.mtime_ms;
                    }
                    Err(e) => {
                        // Transient server restarts must not kill the watch:
                        // log once, keep polling (no event on failure).
                        if !logged_fail {
                            eprintln!("sftp watch: stat failed ({e}); continuing to poll");
                            logged_fail = true;
                        }
                    }
                }
            }
        });

        self.inner.lock().await.watch = Some(handle);
        Ok(())
    }

    /// Stop the active watch, if any. Idempotent.
    async fn unwatch(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(h) = inner.watch.take() {
            h.abort();
        }
    }

    /// Drop the connection + watch + cache. Idempotent.
    async fn disconnect(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(h) = inner.watch.take() {
            h.abort();
        }
        inner.session = None;
        inner.cache.clear();
    }
}

/// Error out when the active session's authority doesn't match the sentinel's.
fn require_authority_match(profile: &SftpProfile, target: &SftpTarget) -> Result<(), String> {
    if profile.host == target.host && profile.port == target.port && profile.user == target.user {
        Ok(())
    } else {
        Err(format!(
            "Not connected: active session is {}@{}:{}, but sentinel wants {}@{}:{} — reconnect first",
            profile.user, profile.host, profile.port, target.user, target.host, target.port
        ))
    }
}

/// Payload for the `save-changed` event — identical shape to the folder
/// watcher's ([`crate::save`]) so the frontend reload path is untouched.
#[derive(Clone, Serialize)]
struct SaveChanged {
    save_dir: String,
}

/// Process-wide singleton, so the synchronous solver seams
/// ([`load_save_data`] / [`read_world_options`]) reach the same live connection
/// as the Tauri commands (which also receive it via managed [`State`]).
pub fn manager() -> Arc<SftpManager> {
    static M: OnceLock<Arc<SftpManager>> = OnceLock::new();
    M.get_or_init(|| Arc::new(SftpManager::new())).clone()
}

// ---------------------------------------------------------------------------
// Sync <-> async bridge for the solver seams.
// ---------------------------------------------------------------------------

/// Run an async task to completion from a synchronous context WITHOUT a nested
/// runtime: spawn it onto Tauri's (tokio) runtime and block the caller on a std
/// channel. Safe from `spawn_blocking` (the solver) and sync commands
/// (`get_world_options`) alike — neither is a runtime worker thread, so blocking
/// them never starves the executor.
fn block_bridge<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    async_runtime::spawn(async move {
        let _ = tx.send(fut.await);
    });
    rx.recv().expect("sftp bridge task panicked")
}

/// Load a [`pal_save::SaveData`] from an SFTP sentinel through the live
/// connection. The one seam `crate::xbox::load_save_data` routes SFTP sources
/// through, so the solver reads remote saves unchanged.
pub fn load_save_data(sentinel: &str) -> Result<pal_save::SaveData, String> {
    let target = parse_sentinel(sentinel).ok_or_else(|| "malformed sftp sentinel".to_string())?;
    let mgr = manager();
    let bundle = block_bridge(async move { mgr.load_bundle(&target).await })?;
    pal_save::read_save_from_parts(
        &bundle.level,
        bundle.level_meta.as_deref(),
        &bundle.players,
        &bundle.dps,
    )
    .map_err(|e| e.to_string())
}

/// Read `WorldOption.sav` for an SFTP world from the cached bundle (downloading
/// it if needed). `Ok(None)` when the world ships no `WorldOption` — fail-soft
/// to vanilla defaults, exactly like a folder save with none.
pub fn read_world_options(sentinel: &str) -> Result<Option<pal_save::WorldOptions>, String> {
    let target = parse_sentinel(sentinel).ok_or_else(|| "malformed sftp sentinel".to_string())?;
    let mgr = manager();
    let bundle = block_bridge(async move { mgr.load_bundle(&target).await })?;
    match &bundle.world_option {
        Some(bytes) => pal_save::parse_world_options_sav(bytes).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (implement the pinned contract).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_connect(
    app: AppHandle,
    state: State<'_, Arc<SftpManager>>,
    profile: SftpProfile,
    secret: SftpSecret,
) -> Result<SftpConnectInfo, String> {
    state.connect(&app, profile, secret).await
}

#[tauri::command]
pub async fn sftp_load_save(
    state: State<'_, Arc<SftpManager>>,
    sentinel: String,
) -> Result<SaveSummary, String> {
    let target = parse_sentinel(&sentinel).ok_or("malformed sftp sentinel")?;
    let bundle = state.load_bundle(&target).await?;
    let save = pal_save::read_save_from_parts(
        &bundle.level,
        bundle.level_meta.as_deref(),
        &bundle.players,
        &bundle.dps,
    )
    .map_err(|e| e.to_string())?;
    Ok(to_summary(save))
}

#[tauri::command]
pub async fn sftp_watch(
    app: AppHandle,
    state: State<'_, Arc<SftpManager>>,
    sentinel: String,
    interval_secs: u32,
) -> Result<(), String> {
    let mgr = state.inner().clone();
    mgr.watch(app, sentinel, interval_secs).await
}

#[tauri::command]
pub async fn sftp_unwatch(state: State<'_, Arc<SftpManager>>) -> Result<(), String> {
    state.unwatch().await;
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect(state: State<'_, Arc<SftpManager>>) -> Result<(), String> {
    state.disconnect().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- sentinel round-trip ------------------------------------------------

    #[test]
    fn sentinel_round_trip() {
        let s = format_sentinel("root", "10.0.0.5", 2022, "/srv/pal/SaveGames/0/ABC123");
        assert_eq!(s, "sftp://root@10.0.0.5:2022#/srv/pal/SaveGames/0/ABC123");
        let t = parse_sentinel(&s).expect("parse");
        assert_eq!(t.user, "root");
        assert_eq!(t.host, "10.0.0.5");
        assert_eq!(t.port, 2022);
        assert_eq!(t.world_dir, "/srv/pal/SaveGames/0/ABC123");
    }

    #[test]
    fn sentinel_hash_in_world_dir_is_unsupported() {
        // The contract mandates rsplit_once('#'). The authority never contains
        // '#', so a world dir that DOES contain '#' is not representable — it
        // fails to parse rather than silently truncating.
        assert!(parse_sentinel("sftp://u@h:22#/weird#dir/world").is_none());
    }

    #[test]
    fn sentinel_rejects_non_sftp_and_malformed() {
        assert!(parse_sentinel("C:/plain/save/path").is_none());
        assert!(parse_sentinel("xbox://wgs#id").is_none());
        assert!(parse_sentinel("sftp://no-hash").is_none());
        assert!(parse_sentinel("sftp://u@h:22#").is_none()); // empty world dir
        assert!(parse_sentinel("sftp://@h:22#/w").is_none()); // empty user
        assert!(parse_sentinel("sftp://u@h:notaport#/w").is_none()); // bad port
        assert!(parse_sentinel("sftp://u-no-at:22#/w").is_none()); // no '@'
        assert!(!is_sentinel("xbox://x#y"));
        assert!(is_sentinel("sftp://u@h:22#/w"));
    }

    // -- known-hosts store --------------------------------------------------

    fn scratch_file(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("pal-lab-sftp-test-{tag}-{n}/known.json"))
    }

    #[test]
    fn known_hosts_first_seen_then_known_then_mismatch() {
        let path = scratch_file("kh");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        // First-ever-seen: stored, known == false.
        let known = verify_against_store(&path, "host.example", 22, "SHA256:AAA").expect("store");
        assert!(!known, "first-seen host is not 'known'");
        assert!(path.is_file(), "store file written");

        // Re-verify same fingerprint: matched prior entry, known == true.
        let known = verify_against_store(&path, "host.example", 22, "SHA256:AAA").expect("match");
        assert!(known, "matching a prior entry is 'known'");

        // Different port is a distinct host entry: first-seen again.
        let known = verify_against_store(&path, "host.example", 2222, "SHA256:BBB").expect("store2");
        assert!(!known);

        // CHANGED fingerprint for a stored host: hard error naming both.
        let err = verify_against_store(&path, "host.example", 22, "SHA256:CHANGED")
            .expect_err("mismatch must error");
        assert!(err.contains("SHA256:AAA"), "names stored fp: {err}");
        assert!(err.contains("SHA256:CHANGED"), "names presented fp: {err}");
        assert!(err.contains("MISMATCH"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn known_hosts_corrupt_file_is_empty_map() {
        let path = scratch_file("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ this is not json").unwrap();
        // Corrupt file => empty map => treated as first-seen (no panic).
        let known = verify_against_store(&path, "h", 22, "SHA256:X").expect("recovers");
        assert!(!known);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // -- world scan (mock RemoteFs, no server) ------------------------------

    #[derive(Default)]
    struct MockFs {
        /// dir path -> child (name, is_dir) entries.
        dirs: HashMap<String, Vec<(String, bool)>>,
        /// file path -> (bytes, mtime_ms).
        files: HashMap<String, (Vec<u8>, u64)>,
    }

    impl MockFs {
        fn dir(&mut self, path: &str, children: &[(&str, bool)]) -> &mut Self {
            self.dirs.insert(
                path.trim_end_matches('/').to_string(),
                children.iter().map(|(n, d)| (n.to_string(), *d)).collect(),
            );
            self
        }
        fn file(&mut self, path: &str, bytes: &[u8], mtime_ms: u64) -> &mut Self {
            self.files.insert(path.to_string(), (bytes.to_vec(), mtime_ms));
            self
        }
    }

    impl RemoteFs for MockFs {
        async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
            self.dirs
                .get(path.trim_end_matches('/'))
                .map(|v| {
                    v.iter()
                        .map(|(n, d)| RemoteEntry {
                            name: n.clone(),
                            is_dir: *d,
                        })
                        .collect()
                })
                .ok_or_else(|| format!("no such dir: {path}"))
        }
        async fn stat(&self, path: &str) -> Result<RemoteStat, String> {
            if let Some((b, m)) = self.files.get(path) {
                return Ok(RemoteStat {
                    size: b.len() as u64,
                    mtime_ms: *m,
                });
            }
            if self.dirs.contains_key(path.trim_end_matches('/')) {
                return Ok(RemoteStat { size: 0, mtime_ms: 0 });
            }
            Err(format!("no such path: {path}"))
        }
        async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
            self.files
                .get(path)
                .map(|(b, _)| b.clone())
                .ok_or_else(|| format!("no such file: {path}"))
        }
    }

    #[tokio::test]
    async fn scan_root_is_single_world() {
        let mut fs = MockFs::default();
        fs.dir("/srv/world", &[("Players", true), ("Level.sav", false)])
            .dir("/srv/world/Players", &[("p1.sav", false), ("p1_dps.sav", false)])
            .file("/srv/world/Level.sav", b"x", 1_700_000_000_000)
            .file("/srv/world/Players/p1.sav", b"x", 0)
            .file("/srv/world/Players/p1_dps.sav", b"x", 0);

        let worlds = scan_worlds(&fs, "/srv/world").await.expect("scan");
        assert_eq!(worlds.len(), 1);
        assert_eq!(worlds[0].world_dir, "/srv/world");
        assert_eq!(worlds[0].players, 1, "excludes _dps");
        assert_eq!(worlds[0].mtime_ms, 1_700_000_000_000);
        assert_eq!(worlds[0].world_name, None, "no LevelMeta => no name");
    }

    #[tokio::test]
    async fn scan_savegames_layout_depth_two() {
        let mut fs = MockFs::default();
        // root/SaveGames -> 0 -> <world>/Level.sav  (depth 2)
        fs.dir("/srv/SaveGames", &[("0", true)])
            .dir("/srv/SaveGames/0", &[("ABCWORLD", true)])
            .dir(
                "/srv/SaveGames/0/ABCWORLD",
                &[("Players", true), ("Level.sav", false)],
            )
            .dir(
                "/srv/SaveGames/0/ABCWORLD/Players",
                &[("a.sav", false), ("b.sav", false), ("a_dps.sav", false)],
            )
            .file("/srv/SaveGames/0/ABCWORLD/Level.sav", b"x", 42_000);

        let worlds = scan_worlds(&fs, "/srv/SaveGames").await.expect("scan");
        assert_eq!(worlds.len(), 1);
        assert_eq!(worlds[0].world_dir, "/srv/SaveGames/0/ABCWORLD");
        assert_eq!(worlds[0].players, 2, "two human saves, _dps excluded");
        assert_eq!(worlds[0].mtime_ms, 42_000);
    }

    #[tokio::test]
    async fn scan_ignores_worlds_deeper_than_two() {
        let mut fs = MockFs::default();
        // Level.sav at depth 3 must NOT be discovered.
        fs.dir("/root", &[("a", true)])
            .dir("/root/a", &[("b", true)])
            .dir("/root/a/b", &[("c", true)])
            .dir("/root/a/b/c", &[("Level.sav", false)])
            .file("/root/a/b/c/Level.sav", b"x", 1);
        let worlds = scan_worlds(&fs, "/root").await.expect("scan");
        assert!(worlds.is_empty(), "depth-3 world is out of range");
    }

    #[tokio::test]
    async fn download_bundle_classifies_and_caps() {
        let mut fs = MockFs::default();
        fs.dir(
            "/w",
            &[("Players", true), ("Level.sav", false), ("WorldOption.sav", false)],
        )
        .dir("/w/Players", &[("p1.sav", false), ("p1_dps.sav", false)])
        .file("/w/Level.sav", b"level", 5)
        .file("/w/WorldOption.sav", b"wo", 5)
        .file("/w/Players/p1.sav", b"player", 5)
        .file("/w/Players/p1_dps.sav", b"dps", 5);

        let b = download_bundle(&fs, "/w").await.expect("bundle");
        assert_eq!(b.level, b"level");
        assert_eq!(b.world_option.as_deref(), Some(&b"wo"[..]));
        assert_eq!(b.level_meta, None);
        assert_eq!(b.players.len(), 1);
        assert_eq!(b.players[0].0, "p1.sav");
        assert_eq!(b.dps.len(), 1);
        assert_eq!(b.dps[0].0, "p1_dps.sav");
    }
}
