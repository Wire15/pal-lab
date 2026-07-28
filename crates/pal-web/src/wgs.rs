//! WGS (Xbox / Game Pass) manifest bridge for the browser build.
//!
//! The desktop app reads the on-disk WGS container store directly; a browser
//! can't, so the web layer collects `containers.index` + every `container.<seq>`
//! file from the dropped store into memory and hands them here as a
//! `(paths, bytes)` bundle (store-root-relative, forward slashes). This wraps
//! [`pal_save::wgs::manifest`] with a read-closure over the in-memory map and
//! returns a JSON manifest describing which on-disk blob file backs each logical
//! save file (`Level.sav`, `Players/<UID>.sav`, …) per world.
//!
//! The heavy final load then reuses `load_save_bundle` UNCHANGED — the web layer
//! reads the chosen world's blob files by `blob_path`, keys them by
//! `target_path`, and feeds the standard bundle path. CNK decompression lives in
//! `pal_save::compress`, so every consumer inherits it automatically.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

/// One logical save file within a world and the on-disk blob backing it. Mirrors
/// `pal_save::wgs::WgsFileRef`; serialized snake_case to match the other web
/// summary DTOs (see `save::SaveSummary`).
#[derive(Serialize)]
pub struct WgsFileDto {
    /// Bundle-relative role path, e.g. `"Level.sav"` or `"Players/<UID>.sav"`.
    pub target_path: String,
    /// Store-root-relative on-disk path `"<CONTAINER_DIR_HEX>/<BLOB_HEX>"`.
    pub blob_path: String,
    pub size: u64,
}

/// One world (save slot) resolved from the store index.
#[derive(Serialize)]
pub struct WgsWorldDto {
    pub save_id: String,
    /// Max FILETIME (100ns ticks) across the world's containers.
    pub mtime_ticks: u64,
    pub files: Vec<WgsFileDto>,
}

/// The store manifest: every world plus any non-fatal skip warnings.
#[derive(Serialize)]
pub struct WgsManifestDto {
    pub worlds: Vec<WgsWorldDto>,
    pub warnings: Vec<String>,
}

impl From<pal_save::wgs::WgsManifest> for WgsManifestDto {
    fn from(m: pal_save::wgs::WgsManifest) -> Self {
        WgsManifestDto {
            worlds: m
                .worlds
                .into_iter()
                .map(|w| WgsWorldDto {
                    save_id: w.save_id,
                    mtime_ticks: w.mtime_ticks,
                    files: w
                        .files
                        .into_iter()
                        .map(|f| WgsFileDto {
                            target_path: f.target_path,
                            blob_path: f.blob_path,
                            size: f.size,
                        })
                        .collect(),
                })
                .collect(),
            warnings: m.warnings,
        }
    }
}

/// The buffer-oriented core of `wgs_manifest`, separated so native tests can
/// drive it without constructing `js_sys::Uint8Array`s.
///
/// `paths`/`buffers` are the `containers.index` + every `container.<seq>` file
/// (store-root-relative) with real bytes — the core parses these. `present_paths`
/// is every store-relative path in the store: the core PROBES each blob's
/// existence (`file_guid` then `cloud_guid`) through the read closure and DROPS a
/// world whose Level blob probes absent, so blob paths must resolve to `Some`.
/// Blob bytes aren't supplied (read later in JS by `blob_path`), so a probed-but-
/// unprovided path yields an empty `Vec` — present for the probe, size comes from
/// the index. A path in neither map nor present set returns `None` (skip-warning).
pub fn manifest_core(
    paths: Vec<String>,
    buffers: Vec<Vec<u8>>,
    present_paths: Vec<String>,
) -> Result<String, String> {
    if paths.len() != buffers.len() {
        return Err(format!(
            "WGS bundle mismatch: {} paths but {} buffers",
            paths.len(),
            buffers.len()
        ));
    }
    let map: HashMap<String, Vec<u8>> = paths.into_iter().zip(buffers).collect();
    let present: HashSet<String> = present_paths.into_iter().collect();
    let mut read = |p: &str| {
        map.get(p)
            .cloned()
            .or_else(|| present.contains(p).then(Vec::new))
    };
    let manifest = pal_save::wgs::manifest(&mut read).map_err(|e| e.to_string())?;
    let dto: WgsManifestDto = manifest.into();
    serde_json::to_string(&dto).map_err(|e| e.to_string())
}

/// Decompress a `LevelMeta.sav` blob and pull out the world's display name.
/// Returns `None` when the blob is absent, corrupt, or carries no name — the
/// caller falls back to the save-id label. Reuses the same seams the native
/// `list_worlds` path uses, so CNK/PlZ/PlM1 blobs all decode here.
pub fn world_name_core(level_meta_sav: &[u8]) -> Option<String> {
    let decompressed = pal_save::compress::decompress_sav(level_meta_sav).ok()?;
    pal_save::characters::parse_world_name(&decompressed)
        .ok()
        .flatten()
}
