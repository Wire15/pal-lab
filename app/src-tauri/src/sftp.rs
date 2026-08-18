//! Dedicated-server save loading. READ-ONLY: this module NEVER writes to the
//! remote server — it opens an SFTP or FTP(S) session, downloads the `.sav`
//! parts into memory, and parses them through the SAME pipeline as folder / Xbox
//! saves (`pal_save::read_save_from_parts`).
//!
//! A save-source *sentinel* string `<protocol>://<user>@<host>:<port>#<remote_world_dir>`
//! (see [`parse_sentinel`]) lets the rest of the app treat a remote world like a
//! folder path: [`load_save_data`] / [`read_world_options`] are the seams the
//! Solver / IV Lab route through, so they work against SFTP saves unchanged.
//!
//! A single live connection lives in the managed [`SftpManager`] state. The
//! commands ([`sftp_connect`], [`sftp_load_save`], [`sftp_watch`],
//! [`sftp_unwatch`], [`sftp_disconnect`]) drive the desktop remote flow;
//! [`load_save_data`] bridges the async session into the synchronous solver via
//! Tauri's runtime (spawn + block-on-channel), never a nested runtime.

#![allow(async_fn_in_trait)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{async_runtime, AppHandle, Emitter, Manager, State};
use parking_lot::Mutex as PlMutex;
use tokio::sync::Mutex;

use russh::client::{self, AuthResult, Handle, Handler};
use russh::keys::ssh_key::PublicKey;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use suppaftp::list::File as FtpListFile;
use suppaftp::native_tls::TlsConnector;
use suppaftp::types::FileType;
use suppaftp::{FtpStream, NativeTlsConnector, NativeTlsFtpStream};

use crate::save::{to_summary, SaveSummary};

/// Sentinel scheme marking a save source as a remote SFTP world rather than a
/// local folder.
const SFTP_SENTINEL_PREFIX: &str = "sftp://";
const FTP_SENTINEL_PREFIX: &str = "ftp://";
const FTPS_SENTINEL_PREFIX: &str = "ftps://";

/// Known-hosts store filename under the Tauri app config dir. Maps `host:port`
/// to a pinned SHA256 host-key fingerprint. Secrets NEVER touch this file.
const KNOWN_HOSTS_FILE: &str = "pal-lab.sftp.knownHosts.json";

/// TCP + SSH handshake budget for [`sftp_connect`].
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// FTP/FTPS LIST / SIZE / MDTM / RETR budget. FTP libraries cannot cancel a
/// blocked socket cleanly, but surfacing a timeout is still better than leaving
/// the load modal spinning with no diagnosis.
const FTP_OP_TIMEOUT: Duration = Duration::from_secs(90);

/// Skip `LocalData.sav` above this size (bytes) — a runaway map blob must not
/// stall every reload. Emitted as a log warning when skipped.
const MAX_LOCAL_DATA: u64 = 32 * 1024 * 1024;

/// Keepalive for long-lived watch sessions: after this much silence russh pings
/// the server; [`KEEPALIVE_MAX`] consecutive unanswered pings tear the
/// connection down. Keeps a watch alive behind NAT / server idle timeouts.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const KEEPALIVE_MAX: usize = 3;

/// Backoff before the single fresh re-dial when the first connect died with a
/// disconnect-class channel error — gives a host that caps concurrent sessions a
/// beat to reap the previous session before we log in again.
const RECONNECT_BACKOFF: Duration = Duration::from_millis(1500);

/// Bound on the best-effort graceful disconnect at process exit, so a wedged
/// socket can never hang app shutdown.
const EXIT_DISCONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// Shown when even a fresh re-dial dies disconnect-class: the overwhelmingly
/// likely cause is a host still holding the previous (un-goodbyed) SFTP session.
const SESSION_LIMIT_HINT: &str = "server closed the session — your host may limit \
concurrent SFTP sessions; wait ~a minute for the old session to expire and try again";

// ---------------------------------------------------------------------------
// Wire types (serde snake_case, matching the pinned cross-slice contract).
// ---------------------------------------------------------------------------

/// Connection profile sent by the UI. NO secrets — persisted TS-side in
/// localStorage and used to prefill the connect modal / boot-restore.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpProfile {
    /// `"sftp"`, `"ftp"`, or `"ftps"`. Omitted profiles are legacy SFTP.
    #[serde(default)]
    pub protocol: RemoteProtocol,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// `"password"` or `"key"`.
    pub auth: String,
    /// Path to the private key file, for `auth == "key"`.
    pub key_path: Option<String>,
    /// Remote dir to scan: a world dir, a `SaveGames` dir, or a server base dir.
    pub root: String,
    /// Opt-in flag: the user asked to remember this endpoint's secret in the OS
    /// vault (see `sftp_vault`). Non-secret, persisted TS-side. `#[serde(default)]`
    /// so older persisted/prefill payloads that omit it decode as `false`.
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteProtocol {
    Sftp,
    Ftp,
    Ftps,
}

impl Default for RemoteProtocol {
    fn default() -> Self {
        RemoteProtocol::Sftp
    }
}

impl RemoteProtocol {
    pub(crate) fn scheme(self) -> &'static str {
        match self {
            RemoteProtocol::Sftp => "sftp",
            RemoteProtocol::Ftp => "ftp",
            RemoteProtocol::Ftps => "ftps",
        }
    }
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
    pub protocol: RemoteProtocol,
    pub user: String,
    pub host: String,
    pub port: u16,
    /// Absolute remote path of the folder containing `Level.sav`.
    pub world_dir: String,
}

/// Whether `s` is an SFTP save-source sentinel.
pub fn is_sentinel(s: &str) -> bool {
    s.starts_with(SFTP_SENTINEL_PREFIX)
        || s.starts_with(FTP_SENTINEL_PREFIX)
        || s.starts_with(FTPS_SENTINEL_PREFIX)
}

/// Build a sentinel string from its parts.
/// (Built TS-side per the pinned contract; retained + tested for round-trip
/// symmetry with [`parse_sentinel`].)
#[allow(dead_code)]
pub fn format_sentinel(user: &str, host: &str, port: u16, world_dir: &str) -> String {
    format_remote_sentinel(RemoteProtocol::Sftp, user, host, port, world_dir)
}

#[allow(dead_code)]
pub fn format_remote_sentinel(
    protocol: RemoteProtocol,
    user: &str,
    host: &str,
    port: u16,
    world_dir: &str,
) -> String {
    format!("{}://{user}@{host}:{port}#{world_dir}", protocol.scheme())
}

/// Parse `sftp://<user>@<host>:<port>#<remote_world_dir>` into an [`SftpTarget`],
/// or `None` when `s` is not a well-formed SFTP sentinel. The `#` split takes
/// the LAST `#` so a world dir that itself contains `#` still resolves. The
/// authority `host:port` split takes the LAST `:` so the user (before `@`) is
/// isolated first.
pub fn parse_sentinel(s: &str) -> Option<SftpTarget> {
    let (protocol, rest) = if let Some(rest) = s.strip_prefix(SFTP_SENTINEL_PREFIX) {
        (RemoteProtocol::Sftp, rest)
    } else if let Some(rest) = s.strip_prefix(FTPS_SENTINEL_PREFIX) {
        (RemoteProtocol::Ftps, rest)
    } else if let Some(rest) = s.strip_prefix(FTP_SENTINEL_PREFIX) {
        (RemoteProtocol::Ftp, rest)
    } else {
        return None;
    };
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
        protocol,
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

enum FtpClient {
    Plain(FtpStream),
    Secure(NativeTlsFtpStream),
}

impl FtpClient {
    fn set_common_options(&mut self) -> Result<(), String> {
        match self {
            FtpClient::Plain(c) => {
                c.set_passive_nat_workaround(true);
                c.transfer_type(FileType::Binary).map_err(|e| e.to_string())
            }
            FtpClient::Secure(c) => {
                c.set_passive_nat_workaround(true);
                c.transfer_type(FileType::Binary).map_err(|e| e.to_string())
            }
        }
    }

    fn login(&mut self, user: &str, password: &str) -> Result<(), String> {
        match self {
            FtpClient::Plain(c) => c.login(user, password),
            FtpClient::Secure(c) => c.login(user, password),
        }
        .map_err(|e| e.to_string())
    }

    fn list_entries(&mut self, path: &str) -> Result<Vec<RemoteEntry>, String> {
        let lines = match self {
            FtpClient::Plain(c) => c.list(Some(path)),
            FtpClient::Secure(c) => c.list(Some(path)),
        }
        .map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for line in lines {
            let Ok(f) = FtpListFile::from_str(line.as_str()) else {
                continue;
            };
            entries.push(RemoteEntry {
                name: f.name().rsplit('/').next().unwrap_or(f.name()).to_string(),
                is_dir: f.is_directory(),
            });
        }
        Ok(entries)
    }

    fn stat_file(&mut self, path: &str) -> Result<RemoteStat, String> {
        let size = match self {
            FtpClient::Plain(c) => c.size(path),
            FtpClient::Secure(c) => c.size(path),
        }
        .map_err(|e| e.to_string())?;
        let mtime_ms = match self {
            FtpClient::Plain(c) => c.mdtm(path),
            FtpClient::Secure(c) => c.mdtm(path),
        }
        .map(|t| t.and_utc().timestamp_millis().max(0) as u64)
        .unwrap_or(0);
        Ok(RemoteStat {
            size: size as u64,
            mtime_ms,
        })
    }

    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, String> {
        match self {
            FtpClient::Plain(c) => c.retr_as_buffer(path),
            FtpClient::Secure(c) => c.retr_as_buffer(path),
        }
        .map(|b| b.into_inner())
        .map_err(|e| e.to_string())
    }

    fn quit(&mut self) {
        match self {
            FtpClient::Plain(c) => {
                let _ = c.quit();
            }
            FtpClient::Secure(c) => {
                let _ = c.quit();
            }
        }
    }
}

#[derive(Clone)]
struct FtpFs {
    inner: Arc<PlMutex<FtpClient>>,
}

impl FtpFs {
    async fn connect(profile: SftpProfile, secret: SftpSecret) -> Result<Arc<Self>, String> {
        let host = profile.host.clone();
        let port = profile.port;
        tokio::time::timeout(CONNECT_TIMEOUT, tokio::task::spawn_blocking(move || {
            connect_ftp_blocking(&profile, &secret)
        }))
        .await
        .map_err(|_| {
            format!(
                "connection to {}:{} timed out after {}s",
                host,
                port,
                CONNECT_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("ftp worker failed: {e}"))?
        .map(|client| Arc::new(FtpFs {
            inner: Arc::new(PlMutex::new(client)),
        }))
    }

    async fn with_client<R, F>(&self, label: String, op: F) -> Result<R, String>
    where
        R: Send + 'static,
        F: FnOnce(&mut FtpClient) -> Result<R, String> + Send + 'static,
    {
        let inner = self.inner.clone();
        let timeout_label = label.clone();
        let task = tokio::task::spawn_blocking(move || {
            eprintln!("ftp: {label} start");
            let started = std::time::Instant::now();
            let mut client = inner.lock();
            let result = op(&mut client);
            match &result {
                Ok(_) => eprintln!("ftp: {label} ok in {:?}", started.elapsed()),
                Err(e) => eprintln!("ftp: {label} failed in {:?}: {e}", started.elapsed()),
            }
            result
        });
        tokio::time::timeout(FTP_OP_TIMEOUT, task)
            .await
            .map_err(|_| {
                format!(
                    "FTP operation timed out after {}s: {timeout_label}",
                    FTP_OP_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("ftp worker failed: {e}"))?
    }

    async fn quit(&self) {
        let inner = self.inner.clone();
        let _ = tokio::task::spawn_blocking(move || inner.lock().quit()).await;
    }
}

fn connect_ftp_blocking(profile: &SftpProfile, secret: &SftpSecret) -> Result<FtpClient, String> {
    let password = secret
        .password
        .as_deref()
        .ok_or_else(|| "password required for FTP/FTPS auth".to_string())?;
    let addr = format!("{}:{}", profile.host, profile.port);
    eprintln!("ftp: connecting via {} to {addr}", profile.protocol.scheme());
    let mut client = match profile.protocol {
        RemoteProtocol::Ftp => FtpClient::Plain(
            FtpStream::connect(addr.as_str()).map_err(|e| format!("ftp connect failed: {e}"))?,
        ),
        RemoteProtocol::Ftps => {
            let connector = NativeTlsConnector::from(
                TlsConnector::new().map_err(|e| format!("creating TLS connector: {e}"))?,
            );
            let stream = NativeTlsFtpStream::connect(addr.as_str())
                .map_err(|e| format!("ftps connect failed: {e}"))?
                .into_secure(connector, &profile.host)
                .map_err(|e| format!("ftps AUTH TLS failed: {e}"))?;
            FtpClient::Secure(stream)
        }
        RemoteProtocol::Sftp => return Err("internal error: FTP connector received SFTP profile".into()),
    };
    client.login(&profile.user, password)?;
    eprintln!("ftp: authenticated as {}", profile.user);
    client.set_common_options()?;
    eprintln!("ftp: binary transfer mode enabled");
    Ok(client)
}

impl RemoteFs for FtpFs {
    async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
        let path = path.to_string();
        self.with_client(format!("LIST {path}"), move |c| {
            let entries = c.list_entries(&path)?;
            eprintln!("ftp: LIST {path} -> {} entries", entries.len());
            Ok(entries)
        })
        .await
    }

    async fn stat(&self, path: &str) -> Result<RemoteStat, String> {
        let path = path.to_string();
        self.with_client(format!("STAT {path}"), move |c| c.stat_file(&path))
            .await
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        let path = path.to_string();
        self.with_client(format!("RETR {path}"), move |c| {
            let bytes = c.read_file(&path)?;
            eprintln!("ftp: RETR {path} -> {} bytes", bytes.len());
            Ok(bytes)
        })
        .await
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

/// Max directory depth explored by [`scan_worlds`] (root = 0). Deep enough to
/// reach a world jailed at `/Pal/Saved/SaveGames/<id>/<world>` from `/`, but
/// bounded so a hostile/huge remote tree can't be walked forever.
const MAX_SCAN_DEPTH: usize = 6;

/// Hard cap on `fs.list()` calls per [`scan_worlds`]. The remote FS is slow and
/// possibly enormous; once spent the scan stops expanding and returns whatever
/// it found. Priority ordering (see [`is_hot_dir`]) spends the budget on the
/// dirs most likely to hold a Palworld world first.
const MAX_SCAN_LIST_CALLS: usize = 400;

/// Case-insensitive: is `name` a directory we expand FIRST at each depth because
/// it's on the well-known path to a Palworld world? Covers the fixed segment
/// names plus all-digit dirs (Steam ids like `0`) and 32-hex dirs (world guids).
fn is_hot_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "pal" | "palserver"
            | "saved"
            | "savegames"
            | "steamapps"
            | "common"
            | "config"
            | "server"
            | "data"
    ) {
        return true;
    }
    // All-digit (steam ids) or 32-char hex (world guids).
    (!name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()))
        || (name.len() == 32 && name.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Case-insensitive: is `name` a directory we NEVER descend into? Backup/log
/// spam and dotfiles can't hold the live world and only burn budget.
fn is_skip_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name.to_ascii_lowercase().as_str(),
        "backup" | "backups" | "logs" | "log" | "crashes" | "node_modules" | ".git"
    )
}

/// The last `/`-separated component of a remote path (for hotness ranking).
fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or("")
}

/// Discover worlds under `root` via a budgeted, prioritized breadth-first walk.
///
/// A directory that directly contains `Level.sav` IS a world; we record it and
/// do NOT descend into it (its `Players` / `backup` subdirs are never worlds).
/// Otherwise we enqueue its child dirs, expanding [`is_hot_dir`] names before
/// the rest at each depth so a jailed root buried in noise still finds the world
/// within [`MAX_SCAN_LIST_CALLS`]. Traversal stops at [`MAX_SCAN_DEPTH`] and
/// when the list budget is exhausted (returning what was found so far, no
/// error). [`is_skip_dir`] names are never descended into.
///
/// For each world: best-effort name (`LevelMeta.sav`), human player count
/// (excluding `_dps`), and `Level.sav` mtime.
async fn scan_worlds<F: RemoteFs>(fs: &F, root: &str) -> Result<Vec<SftpWorld>, String> {
    let root = root.trim_end_matches('/');
    let root = if root.is_empty() { "/" } else { root };

    let mut world_dirs: Vec<String> = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    visited.insert(root.to_string());
    let mut frontier: Vec<String> = vec![root.to_string()];
    let mut depth = 0usize;
    let mut list_calls = 0usize;

    'walk: while !frontier.is_empty() && depth <= MAX_SCAN_DEPTH {
        // Hot dirs first at this depth; stable otherwise so noise keeps its
        // listing order and the budget lands on promising dirs first.
        frontier.sort_by_key(|p| !is_hot_dir(base_name(p)));
        let mut next: Vec<String> = Vec::new();
        for dir in &frontier {
            if list_calls >= MAX_SCAN_LIST_CALLS {
                break 'walk;
            }
            list_calls += 1;
            let entries = match fs.list(dir).await {
                Ok(e) => e,
                Err(_) => continue,
            };
            if entries.iter().any(|e| !e.is_dir && e.name == "Level.sav") {
                world_dirs.push(dir.clone());
                continue; // A found world's subdirs are never worlds.
            }
            if depth < MAX_SCAN_DEPTH {
                for e in entries.iter().filter(|e| e.is_dir) {
                    if is_skip_dir(&e.name) {
                        continue;
                    }
                    let child = join(dir, &e.name);
                    if visited.insert(child.clone()) {
                        next.push(child);
                    }
                }
            }
        }
        frontier = next;
        depth += 1;
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
    let base_entries = fs.list(base).await.unwrap_or_default();
    let has_file = |name: &str| base_entries.iter().any(|e| !e.is_dir && e.name == name);

    let level = fs
        .read(&join(base, "Level.sav"))
        .await
        .map_err(|e| format!("Level.sav: {e}"))?;
    let level_meta = if has_file("LevelMeta.sav") {
        fs.read(&join(base, "LevelMeta.sav")).await.ok()
    } else {
        None
    };
    let world_option = if has_file("WorldOption.sav") {
        fs.read(&join(base, "WorldOption.sav")).await.ok()
    } else {
        None
    };

    let local_path = join(base, "LocalData.sav");
    let local_data = if has_file("LocalData.sav") {
        match fs.stat(&local_path).await {
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
        }
    } else {
        None
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
/// ever sent to an unverified server. Also captures the server's stated
/// SSH_MSG_DISCONNECT reason (e.g. "Too many logins for 'user'") so channel
/// failures can surface WHY the host hung up instead of a bare "Disconnected".
struct ClientHandler {
    fingerprint: Arc<PlMutex<Option<String>>>,
    /// The server's disconnect message, when it sent one before hanging up.
    server_bye: Arc<PlMutex<Option<String>>>,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        *self.fingerprint.lock() = Some(fp);
        Ok(true)
    }

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        match reason {
            client::DisconnectReason::ReceivedDisconnect(info) => {
                let msg = info.message.trim().to_string();
                if !msg.is_empty() {
                    *self.server_bye.lock() = Some(msg);
                }
                Ok(())
            }
            client::DisconnectReason::Error(e) => Err(e),
        }
    }
}

/// A [`do_connect`] failure plus whether a completely fresh dial might recover.
/// Only a disconnect-class transport failure at channel / subsystem open is
/// retryable — bad credentials or a changed host key never are (a retry can't
/// fix them and would only re-send secrets).
struct ConnectError {
    message: String,
    retryable: bool,
    /// The server's stated disconnect reason, when it sent one.
    server_bye: Option<String>,
}

impl From<String> for ConnectError {
    /// Every `?`-propagated stage error (timeout, host key, auth) is fatal.
    fn from(message: String) -> Self {
        ConnectError {
            message,
            retryable: false,
            server_bye: None,
        }
    }
}

/// Disconnect-class transport errors: the SSH session/transport is gone, so a
/// fresh dial (new TCP + auth) may succeed once the server reaps the old
/// session. This is the reconnect-after-restart symptom — a host that caps
/// concurrent SFTP sessions rejects the new channel by disconnecting while it
/// still holds the previous (un-goodbyed) session.
fn is_disconnect_class(e: &russh::Error) -> bool {
    matches!(
        e,
        russh::Error::Disconnect
            | russh::Error::HUP
            | russh::Error::SendError
            | russh::Error::RecvError
            | russh::Error::ChannelOpenFailure(_)
            | russh::Error::KeepaliveTimeout
            | russh::Error::InactivityTimeout
            | russh::Error::ConnectionTimeout
    )
}

/// Send a graceful SSH disconnect so the server reaps the session NOW. Merely
/// dropping the [`Handle`] only shuts the TCP socket (russh emits no
/// `SSH_MSG_DISCONNECT` on that path), which a host that caps concurrent
/// sessions treats as a lingering session and refuses the next login's channel
/// against until its own reap window expires. Best-effort: a dead transport
/// just means the goodbye can't be delivered, which is fine.
async fn graceful_bye(handle: &Handle<ClientHandler>) {
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "pal-lab: session closed", "")
        .await;
}

/// Open a TCP + SSH connection, verify the host key, authenticate, and open the
/// SFTP subsystem. Returns the live handle, an `Arc`-shared SFTP session, the
/// host-key fingerprint, and whether the host was already known.
async fn do_connect(
    app: &AppHandle,
    profile: &SftpProfile,
    secret: &SftpSecret,
) -> Result<(Handle<ClientHandler>, Arc<SftpSession>, String, bool), ConnectError> {
    // Keepalive keeps a long-lived watch session alive behind NAT / idle
    // timeouts; defaults otherwise.
    let config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVE_MAX,
        ..Default::default()
    });
    let fp_slot: Arc<PlMutex<Option<String>>> = Arc::new(PlMutex::new(None));
    let bye_slot: Arc<PlMutex<Option<String>>> = Arc::new(PlMutex::new(None));
    let handler = ClientHandler {
        fingerprint: fp_slot.clone(),
        server_bye: bye_slot.clone(),
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
        other => return Err(format!("unknown auth method: {other} (expected password|key)").into()),
    };
    if !matches!(auth, AuthResult::Success) {
        return Err("authentication failed (bad credentials or method not allowed)".to_string().into());
    }

    // Channel / subsystem open is where the reconnect-after-restart collision
    // surfaces: a disconnect-class error here is retryable with a fresh dial.
    // `with_bye` names the server's own disconnect reason when it sent one —
    // e.g. "Too many logins for 'user'" — turning a bare "Disconnected" into a
    // diagnosis.
    let with_bye = |stage: &str, e: russh::Error| {
        let bye = bye_slot.lock().clone();
        ConnectError {
            retryable: is_disconnect_class(&e),
            message: match &bye {
                Some(b) => format!("{stage}: {e} — server said: \"{b}\""),
                None => format!("{stage}: {e}"),
            },
            server_bye: bye,
        }
    };
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| with_bye("opening ssh channel", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| with_bye("requesting sftp subsystem", e))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("initializing sftp: {e}"))?;

    Ok((handle, Arc::new(sftp), fingerprint, known))
}

/// [`do_connect`] with a single fresh re-dial when the first attempt died with a
/// disconnect-class channel error: the reconnect-after-restart case where a host
/// that caps concurrent SFTP sessions just needs a beat to reap the previous
/// (possibly zombie) session. The retry is a COMPLETELY fresh dial (new TCP +
/// auth), bounded to one extra attempt after [`RECONNECT_BACKOFF`]. A second
/// disconnect-class failure surfaces the actionable [`SESSION_LIMIT_HINT`] copy.
async fn dial_with_retry(
    app: &AppHandle,
    profile: &SftpProfile,
    secret: &SftpSecret,
) -> Result<(Handle<ClientHandler>, Arc<SftpSession>, String, bool), String> {
    match do_connect(app, profile, secret).await {
        Ok(v) => Ok(v),
        Err(e) if e.retryable => {
            eprintln!(
                "sftp connect: {} — retrying once after {}ms",
                e.message,
                RECONNECT_BACKOFF.as_millis()
            );
            tokio::time::sleep(RECONNECT_BACKOFF).await;
            do_connect(app, profile, secret).await.map_err(retry_failure_message)
        }
        Err(e) => Err(e.message),
    }
}

/// The message surfaced when a re-dial ALSO failed: a second disconnect-class
/// failure means the host is very likely still holding the old session, so we
/// return the actionable [`SESSION_LIMIT_HINT`] — plus the server's own stated
/// disconnect reason when it sent one, which usually names the exact limit
/// (e.g. "Too many logins for 'user'"). Any other failure keeps its own
/// message (bad creds, changed host key, etc.).
fn retry_failure_message(e: ConnectError) -> String {
    if e.retryable {
        match e.server_bye {
            Some(b) => format!("{SESSION_LIMIT_HINT} — server said: \"{b}\""),
            None => SESSION_LIMIT_HINT.to_string(),
        }
    } else {
        e.message
    }
}

// ---------------------------------------------------------------------------
// Managed connection state.
// ---------------------------------------------------------------------------

/// The one live remote connection.
struct Active {
    remote: ActiveRemote,
    profile: SftpProfile,
    /// In-memory only, for potential reconnect; NEVER persisted.
    #[allow(dead_code)]
    secret: SftpSecret,
}

enum ActiveRemote {
    /// Kept alive to hold the SSH connection open. On teardown we send a
    /// graceful SSH disconnect (see [`graceful_bye`]) instead of just dropping
    /// it, so a host that caps concurrent sessions reaps this one immediately.
    Sftp {
        handle: Handle<ClientHandler>,
        sftp: Arc<SftpSession>,
    },
    Ftp(Arc<FtpFs>),
}

#[derive(Clone)]
enum RemoteSnapshot {
    Sftp(Arc<SftpSession>),
    Ftp(Arc<FtpFs>),
}

impl ActiveRemote {
    fn snapshot(&self) -> RemoteSnapshot {
        match self {
            ActiveRemote::Sftp { sftp, .. } => RemoteSnapshot::Sftp(sftp.clone()),
            ActiveRemote::Ftp(ftp) => RemoteSnapshot::Ftp(ftp.clone()),
        }
    }
}

impl RemoteSnapshot {
    async fn stat(&self, path: &str) -> Result<RemoteStat, String> {
        match self {
            RemoteSnapshot::Sftp(sftp) => SftpFs(sftp).stat(path).await,
            RemoteSnapshot::Ftp(ftp) => ftp.stat(path).await,
        }
    }

    async fn download_bundle(&self, world_dir: &str) -> Result<Bundle, String> {
        match self {
            RemoteSnapshot::Sftp(sftp) => download_bundle(&SftpFs(sftp), world_dir).await,
            RemoteSnapshot::Ftp(ftp) => download_bundle(ftp.as_ref(), world_dir).await,
        }
    }
}

fn should_reconnect_ftp(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("connection error")
        || lower.contains("connection reset")
        || lower.contains("forcibly closed")
        || lower.contains("broken pipe")
        || lower.contains("not connected")
        || lower.contains("timed out")
        || lower.contains("os error 10054")
}

async fn scan_remote(remote: &ActiveRemote, root: &str) -> Result<Vec<SftpWorld>, String> {
    match remote {
        ActiveRemote::Sftp { sftp, .. } => scan_worlds(&SftpFs(sftp), root).await,
        ActiveRemote::Ftp(ftp) => scan_worlds(ftp.as_ref(), root).await,
    }
}

async fn close_active(active: Active) {
    match active.remote {
        ActiveRemote::Sftp { handle, .. } => graceful_bye(&handle).await,
        ActiveRemote::Ftp(ftp) => ftp.quit().await,
    }
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

/// Managed Tauri state: the single active remote connection, its download cache,
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
        // Take the old session out under the lock, then say a graceful SSH
        // goodbye UNLOCKED so the server reaps it before we dial the replacement
        // (else the replacement can collide with the still-live old session).
        let previous = {
            let mut inner = self.inner.lock().await;
            if let Some(h) = inner.watch.take() {
                h.abort();
            }
            inner.cache.clear();
            inner.session.take()
        };
        if let Some(active) = previous {
            close_active(active).await;
        }

        let (remote, fingerprint, known) = match profile.protocol {
            RemoteProtocol::Sftp => {
                let (handle, sftp, fingerprint, known) = dial_with_retry(app, &profile, &secret).await?;
                (ActiveRemote::Sftp { handle, sftp }, fingerprint, known)
            }
            RemoteProtocol::Ftp | RemoteProtocol::Ftps => {
                let ftp = FtpFs::connect(profile.clone(), secret.clone()).await?;
                (ActiveRemote::Ftp(ftp), String::new(), true)
            }
        };
        let worlds = scan_remote(&remote, &profile.root).await?;

        let mut inner = self.inner.lock().await;
        inner.session = Some(Active {
            remote,
            profile,
            secret,
        });
        Ok(SftpConnectInfo {
            fingerprint,
            known,
            worlds,
        })
    }

    async fn reconnect_ftp(&self, target: &SftpTarget, reason: &str) -> Result<RemoteSnapshot, String> {
        if !matches!(target.protocol, RemoteProtocol::Ftp | RemoteProtocol::Ftps) {
            return Err(reason.to_string());
        }

        let (profile, secret) = {
            let inner = self.inner.lock().await;
            let active = inner.session.as_ref().ok_or("Not connected")?;
            require_authority_match(&active.profile, target)?;
            (active.profile.clone(), active.secret.clone())
        };

        eprintln!(
            "ftp: reconnecting {}://{}@{}:{} after: {reason}",
            profile.protocol.scheme(),
            profile.user,
            profile.host,
            profile.port
        );
        let new_ftp = FtpFs::connect(profile.clone(), secret).await.map_err(|e| {
            format!("{reason}; reconnect failed for {}://{}@{}:{}: {e}", profile.protocol.scheme(), profile.user, profile.host, profile.port)
        })?;

        let old_ftp = {
            let mut inner = self.inner.lock().await;
            let active = inner.session.as_mut().ok_or("Not connected")?;
            require_authority_match(&active.profile, target)?;
            match std::mem::replace(&mut active.remote, ActiveRemote::Ftp(new_ftp.clone())) {
                ActiveRemote::Ftp(old) => Some(old),
                ActiveRemote::Sftp { .. } => None,
            }
        };
        if let Some(old) = old_ftp {
            old.quit().await;
        }
        Ok(RemoteSnapshot::Ftp(new_ftp))
    }

    /// Load (or reuse the cached) bundle for `target`, requiring an active
    /// connection whose authority matches the sentinel. Caches by `Level.sav`
    /// mtime; a matching mtime reuses the cached bundle with no re-download.
    async fn load_bundle(&self, target: &SftpTarget) -> Result<Arc<Bundle>, String> {
        // Snapshot the session + any cached bundle, then do network I/O unlocked.
        let (mut remote, cached) = {
            let inner = self.inner.lock().await;
            let active = inner.session.as_ref().ok_or("Not connected")?;
            require_authority_match(&active.profile, target)?;
            let cached = inner
                .cache
                .get(&target.world_dir)
                .map(|c| (c.level_mtime_ms, c.bundle.clone()));
            (active.remote.snapshot(), cached)
        };

        let level_path = join(&target.world_dir, "Level.sav");
        let mut stat = match remote.stat(&level_path).await {
            Ok(stat) => stat,
            Err(e) if should_reconnect_ftp(&e) => {
                remote = self.reconnect_ftp(target, &e).await?;
                remote
                    .stat(&level_path)
                    .await
                    .map_err(|retry| format!("{e}; reconnect retry failed: {retry}"))?
            }
            Err(e) => return Err(e),
        };

        if let Some((mtime, bundle)) = cached {
            if mtime == stat.mtime_ms {
                return Ok(bundle);
            }
        }

        let bundle = match remote.download_bundle(&target.world_dir).await {
            Ok(bundle) => Arc::new(bundle),
            Err(e) if should_reconnect_ftp(&e) => {
                remote = self.reconnect_ftp(target, &e).await?;
                stat = remote
                    .stat(&level_path)
                    .await
                    .map_err(|retry| format!("{e}; reconnect stat retry failed: {retry}"))?;
                Arc::new(
                    remote
                        .download_bundle(&target.world_dir)
                        .await
                        .map_err(|retry| format!("{e}; reconnect download retry failed: {retry}"))?,
                )
            }
            Err(e) => return Err(e),
        };

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
        let target = parse_sentinel(&sentinel).ok_or("malformed remote sentinel")?;
        let interval = Duration::from_secs(interval_secs.clamp(15, 600) as u64);
        let level_path = join(&target.world_dir, "Level.sav");

        // Replace any prior watch; snapshot the live session for the baseline.
        let remote = {
            let mut inner = self.inner.lock().await;
            if let Some(h) = inner.watch.take() {
                h.abort();
            }
            let active = inner.session.as_ref().ok_or("Not connected")?;
            require_authority_match(&active.profile, &target)?;
            active.remote.snapshot()
        };

        let mut last_mtime = remote
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
                let remote = {
                    let inner = me.inner.lock().await;
                    match inner.session.as_ref() {
                        Some(a) => a.remote.snapshot(),
                        None => break,
                    }
                };
                match remote.stat(&level_path).await {
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
                    Err(e) if should_reconnect_ftp(&e) => {
                        match me.reconnect_ftp(&target, &e).await {
                            Ok(remote) => match remote.stat(&level_path).await {
                                Ok(s) => {
                                    logged_fail = false;
                                    last_mtime = s.mtime_ms;
                                }
                                Err(retry) if !logged_fail => {
                                    eprintln!("sftp watch: stat failed after reconnect ({retry}); continuing to poll");
                                    logged_fail = true;
                                }
                                Err(_) => {}
                            },
                            Err(reconnect) if !logged_fail => {
                                eprintln!("sftp watch: reconnect failed ({reconnect}); continuing to poll");
                                logged_fail = true;
                            }
                            Err(_) => {}
                        }
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

    /// Drop the connection + watch + cache. SFTP sends a graceful SSH goodbye;
    /// FTP(S) sends QUIT. Idempotent.
    async fn disconnect(&self) {
        let previous = {
            let mut inner = self.inner.lock().await;
            if let Some(h) = inner.watch.take() {
                h.abort();
            }
            inner.cache.clear();
            inner.session.take()
        };
        if let Some(active) = previous {
            close_active(active).await;
        }
    }
}

/// Error out when the active session's authority doesn't match the sentinel's.
fn require_authority_match(profile: &SftpProfile, target: &SftpTarget) -> Result<(), String> {
    if profile.protocol == target.protocol
        && profile.host == target.host
        && profile.port == target.port
        && profile.user == target.user
    {
        Ok(())
    } else {
        Err(format!(
            "Not connected: active session is {}://{}@{}:{}, but sentinel wants {}://{}@{}:{} — reconnect first",
            profile.protocol.scheme(),
            profile.user,
            profile.host,
            profile.port,
            target.protocol.scheme(),
            target.user,
            target.host,
            target.port
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

/// Best-effort graceful disconnect of the live session at process exit, bounded
/// by [`EXIT_DISCONNECT_TIMEOUT`] so app shutdown can NEVER hang. Runs the async
/// teardown on Tauri's runtime and blocks the (main-thread) caller on a std
/// channel with a hard ceiling, so even a wedged socket or a runtime already
/// tearing down cannot stall exit. Wire this to `RunEvent::ExitRequested`.
pub fn disconnect_on_exit() {
    let (tx, rx) = std::sync::mpsc::channel();
    async_runtime::spawn(async move {
        let mgr = manager();
        let _ = tokio::time::timeout(EXIT_DISCONNECT_TIMEOUT, mgr.disconnect()).await;
        let _ = tx.send(());
    });
    // Never wait past the budget (+ a small margin), even if the runtime is gone.
    let _ = rx.recv_timeout(EXIT_DISCONNECT_TIMEOUT + Duration::from_millis(500));
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
        /// Count of `list()` calls, for budget assertions.
        list_calls: std::cell::Cell<usize>,
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
        /// Insert an owned dir listing (for programmatically-built wide trees).
        fn dir_owned(&mut self, path: &str, children: Vec<(String, bool)>) -> &mut Self {
            self.dirs
                .insert(path.trim_end_matches('/').to_string(), children);
            self
        }
    }

    impl RemoteFs for MockFs {
        async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
            self.list_calls.set(self.list_calls.get() + 1);
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
    async fn scan_finds_world_at_depth_three() {
        let mut fs = MockFs::default();
        // Level.sav at depth 3 IS now within the depth-6 cap.
        fs.dir("/root", &[("a", true)])
            .dir("/root/a", &[("b", true)])
            .dir("/root/a/b", &[("c", true)])
            .dir("/root/a/b/c", &[("Level.sav", false)])
            .file("/root/a/b/c/Level.sav", b"x", 1);
        let worlds = scan_worlds(&fs, "/root").await.expect("scan");
        assert_eq!(worlds.len(), 1);
        assert_eq!(worlds[0].world_dir, "/root/a/b/c");
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

    #[tokio::test]
    async fn hosting_layout_from_jail_root() {
        // Jailed SFTP: world lives at /Pal/Saved/SaveGames/0/<guid>/Level.sav
        // (depth 5) and must be found scanning from "/".
        let guid = "0123456789abcdef0123456789abcdef"; // 32 hex
        let mut fs = MockFs::default();
        fs.dir("/", &[("Pal", true), ("etc", true)])
            .dir("/Pal", &[("Saved", true)])
            .dir("/Pal/Saved", &[("SaveGames", true)])
            .dir("/Pal/Saved/SaveGames", &[("0", true)])
            .dir("/Pal/Saved/SaveGames/0", &[(guid, true)])
            .dir(
                &format!("/Pal/Saved/SaveGames/0/{guid}"),
                &[("Level.sav", false)],
            )
            .file(&format!("/Pal/Saved/SaveGames/0/{guid}/Level.sav"), b"x", 99);

        let worlds = scan_worlds(&fs, "/").await.expect("scan");
        assert_eq!(worlds.len(), 1);
        assert_eq!(worlds[0].world_dir, format!("/Pal/Saved/SaveGames/0/{guid}"));
        assert_eq!(worlds[0].mtime_ms, 99);
    }

    #[tokio::test]
    async fn depth_seven_not_found() {
        // World dir at depth 7 (root=0) is beyond the depth-6 cap.
        let mut fs = MockFs::default();
        fs.dir("/s", &[("a", true)])
            .dir("/s/a", &[("b", true)])
            .dir("/s/a/b", &[("c", true)])
            .dir("/s/a/b/c", &[("d", true)])
            .dir("/s/a/b/c/d", &[("e", true)])
            .dir("/s/a/b/c/d/e", &[("f", true)])
            .dir("/s/a/b/c/d/e/f", &[("g", true)])
            .dir("/s/a/b/c/d/e/f/g", &[("Level.sav", false)])
            .file("/s/a/b/c/d/e/f/g/Level.sav", b"x", 1);
        let worlds = scan_worlds(&fs, "/s").await.expect("scan");
        assert!(worlds.is_empty(), "depth-7 world is beyond the cap");
    }

    #[tokio::test]
    async fn budget_exhaustion_stops() {
        // A wide tree: 500 non-hot junk dirs at depth 1, each empty.
        let junk: Vec<(String, bool)> = (0..500).map(|i| (format!("junk{i:04}"), true)).collect();

        // Case A: the ONLY world is under a late non-hot dir (junk0499),
        // reached only after the list budget is spent -> not found, NO error.
        let mut late = MockFs::default();
        let mut late_root = junk.clone();
        late_root.push(("junk0499_world".to_string(), true));
        late.dir_owned("/j", late_root);
        for i in 0..500 {
            late.dir_owned(&format!("/j/junk{i:04}"), Vec::new());
        }
        late.dir("/j/junk0499_world", &[("Level.sav", false)])
            .file("/j/junk0499_world/Level.sav", b"x", 1);
        let worlds = scan_worlds(&late, "/j").await.expect("scan (no error)");
        assert!(worlds.is_empty(), "late world beyond budget not found");
        assert!(
            late.list_calls.get() <= MAX_SCAN_LIST_CALLS,
            "budget honored: {} <= {MAX_SCAN_LIST_CALLS}",
            late.list_calls.get()
        );

        // Case B: same wide junk tree, but the world sits under an EARLY hot
        // dir ("Pal") -> hot-first ordering finds it despite the 500 junk dirs.
        let mut early = MockFs::default();
        let mut early_root = junk.clone();
        early_root.push(("Pal".to_string(), true));
        early.dir_owned("/j", early_root);
        for i in 0..500 {
            early.dir_owned(&format!("/j/junk{i:04}"), Vec::new());
        }
        early.dir("/j/Pal", &[("Level.sav", false)])
            .file("/j/Pal/Level.sav", b"x", 7);
        let worlds = scan_worlds(&early, "/j").await.expect("scan");
        assert_eq!(worlds.len(), 1, "hot dir expanded before junk");
        assert_eq!(worlds[0].world_dir, "/j/Pal");
    }

    #[tokio::test]
    async fn skip_list_dirs_not_descended() {
        // A world buried under a skip-list dir (backup/) is never descended into.
        let mut fs = MockFs::default();
        fs.dir("/r", &[("backup", true)])
            .dir("/r/backup", &[("w", true)])
            .dir("/r/backup/w", &[("Level.sav", false)])
            .file("/r/backup/w/Level.sav", b"x", 1);
        let worlds = scan_worlds(&fs, "/r").await.expect("scan");
        assert!(worlds.is_empty(), "backup/ is never descended into");
    }

    #[tokio::test]
    async fn found_world_subdirs_not_scanned() {
        // A found world's subdirs are never treated as worlds, even if one holds
        // its own Level.sav (e.g. a nested backup copy).
        let mut fs = MockFs::default();
        fs.dir("/r", &[("W", true)])
            .dir("/r/W", &[("Level.sav", false), ("nested", true)])
            .dir("/r/W/nested", &[("Level.sav", false)])
            .file("/r/W/Level.sav", b"x", 5)
            .file("/r/W/nested/Level.sav", b"x", 6);
        let worlds = scan_worlds(&fs, "/r").await.expect("scan");
        assert_eq!(worlds.len(), 1, "only the outer world is discovered");
        assert_eq!(worlds[0].world_dir, "/r/W");
    }

    // -- reconnect lifecycle: disconnect-class classification + retry decision --

    #[test]
    fn disconnect_class_covers_transport_death() {
        use russh::ChannelOpenFailure;
        // A dead/rejected transport at channel open — a fresh dial may recover.
        for e in [
            russh::Error::Disconnect,
            russh::Error::HUP,
            russh::Error::SendError,
            russh::Error::RecvError,
            russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited),
            russh::Error::KeepaliveTimeout,
            russh::Error::InactivityTimeout,
            russh::Error::ConnectionTimeout,
        ] {
            assert!(is_disconnect_class(&e), "should be disconnect-class: {e:?}");
        }
        // Credential / protocol errors a retry can NEVER fix — must not loop.
        for e in [
            russh::Error::NotAuthenticated,
            russh::Error::NoAuthMethod,
            russh::Error::RequestDenied,
            russh::Error::WrongChannel,
        ] {
            assert!(!is_disconnect_class(&e), "should NOT be disconnect-class: {e:?}");
        }
    }

    #[test]
    fn stage_errors_are_fatal_not_retryable() {
        // Every `?`-propagated stage error (timeout, host key, auth) is fatal:
        // From<String> must never mark a connect error retryable.
        let e: ConnectError = "auth error: bad password".to_string().into();
        assert!(!e.retryable);
        assert_eq!(e.message, "auth error: bad password");
    }

    #[test]
    fn retry_failure_uses_session_limit_hint_only_when_disconnect_class() {
        // A second disconnect-class failure => the actionable concurrent-session
        // hint (this is the reconnect-after-restart copy).
        let retryable = ConnectError {
            message: "opening ssh channel: Disconnected".to_string(),
            retryable: true,
            server_bye: None,
        };
        let msg = retry_failure_message(retryable);
        assert_eq!(msg, SESSION_LIMIT_HINT);
        assert!(msg.contains("concurrent SFTP sessions"));
        assert!(msg.contains("wait"));

        // When the server stated WHY it hung up, the hint names it verbatim —
        // that string usually identifies the exact limit (e.g. pam maxlogins).
        let with_reason = ConnectError {
            message: "opening ssh channel: Disconnected".to_string(),
            retryable: true,
            server_bye: Some("Too many logins for 'pal'".to_string()),
        };
        let msg = retry_failure_message(with_reason);
        assert!(msg.starts_with(SESSION_LIMIT_HINT));
        assert!(msg.contains("server said: \"Too many logins for 'pal'\""));

        // A non-disconnect failure keeps its own message (no misleading hint).
        let fatal = ConnectError {
            message: "auth error: bad password".to_string(),
            retryable: false,
            server_bye: None,
        };
        assert_eq!(retry_failure_message(fatal), "auth error: bad password");
    }
}
