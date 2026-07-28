//! Xbox / Game Pass **WGS** (Windows Gaming Services) container-store reader.
//!
//! Palworld's Game Pass build stores saves not as a `SaveGames/<id>/…` tree but
//! as a WGS *container store*: a `containers.index` manifest plus one
//! `<CONTAINER_DIR_HEX>/` directory per container, each holding a
//! `container.<seq>` file-list and one GUID-named blob (the actual `.sav`
//! payload, which may be PlZ, PlM or the Xbox `CNK` variant).
//!
//! This module parses that store **in memory** and re-assembles the raw,
//! still-compressed `.sav` blobs so they can be fed straight into
//! [`crate::read_save_from_parts`] — no on-disk conversion, no editing. All I/O
//! goes through a caller-supplied [`WgsRead`] closure keyed by store-relative
//! paths (forward slashes, relative to the directory that holds
//! `containers.index`), so the same reader serves the desktop filesystem and the
//! browser/wasm build.
//!
//! Format reference: `palworld-save-pal` (MIT), `palworld-save-tools` (MIT),
//! `XGP-save-extractor` (MIT). READ-ONLY, like the rest of this crate.

use std::collections::HashMap;
use std::fmt::Write as _;

use crate::compress;
use crate::SaveError;

/// `containers.index` format version written by current Palworld/WGS.
const CONTAINER_INDEX_VERSION: u32 = 0xE;
/// `container.<seq>` file-list format version.
const CONTAINER_FILE_LIST_VERSION: u32 = 4;

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

/// One reconstructed save file within a world: where it lands in a Steam-style
/// save tree ([`target_path`](Self::target_path)) and where its bytes live in
/// the WGS store ([`blob_path`](Self::blob_path), a `<DIR>/<BLOB>` store-relative
/// path).
#[derive(Debug, Clone)]
pub struct WgsFileRef {
    /// Steam-tree-relative destination, e.g. `"Level.sav"`, `"LevelMeta.sav"`,
    /// `"LocalData.sav"`, `"WorldOption.sav"`, `"Players/<UID>.sav"` or
    /// `"Players/<UID>_dps.sav"`.
    pub target_path: String,
    /// Store-relative blob location `"<CONTAINER_DIR_HEX>/<BLOB_HEX>"`.
    pub blob_path: String,
    /// Payload size in bytes (from the `containers.index` entry).
    pub size: u64,
}

/// A single world discovered in the store, with the blob references that make it
/// up.
#[derive(Debug, Clone)]
pub struct WgsWorldManifest {
    /// The world-folder GUID (32 uppercase hex), i.e. the container-name prefix.
    pub save_id: String,
    /// Newest FILETIME (100 ns ticks) across the world's chosen containers.
    pub mtime_ticks: u64,
    /// The files that make up this world (Level always present).
    pub files: Vec<WgsFileRef>,
}

/// Result of scanning a whole WGS store: every complete world plus any
/// non-fatal issues encountered (incomplete cloud sync, unknown container
/// names, dropped worlds…).
#[derive(Debug, Clone)]
pub struct WgsManifest {
    pub worlds: Vec<WgsWorldManifest>,
    pub warnings: Vec<String>,
}

/// Reader closure: given a store-relative path (forward slashes), return the
/// file's bytes, or `None` if it is absent. The store root is the directory
/// that contains `containers.index`.
pub type WgsRead<'a> = &'a mut dyn FnMut(&str) -> Option<Vec<u8>>;

/// Lightweight world summary for a save picker.
#[derive(Debug, Clone)]
pub struct WgsWorld {
    pub save_id: String,
    /// World display name from `LevelMeta.sav`; `None` when that blob is absent
    /// or unreadable.
    pub world_name: Option<String>,
    pub mtime_ticks: u64,
    /// Number of human player saves (`Players/<UID>.sav`), excluding `_dps`.
    pub player_count: u32,
}

/// The raw, still-compressed `.sav` bytes of one world, ready to hand to
/// [`crate::read_save_from_parts`].
#[derive(Debug, Clone)]
pub struct ExtractedWorld {
    /// `Level.sav` bytes (required).
    pub level: Vec<u8>,
    /// `LevelMeta.sav` bytes, if present.
    pub level_meta: Option<Vec<u8>>,
    /// Regular per-player saves, labelled `"<UID>.sav"`.
    pub players: Vec<(String, Vec<u8>)>,
    /// Dimensional-pal-storage saves, labelled `"<UID>_dps.sav"`.
    pub dps: Vec<(String, Vec<u8>)>,
    /// `WorldOption.sav` bytes, if present.
    pub world_option: Option<Vec<u8>>,
    /// `LocalData.sav` bytes, if present.
    pub local_data: Option<Vec<u8>>,
    /// Non-fatal issues (missing optional blobs, unexpected targets).
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// GUID on-disk naming
// ---------------------------------------------------------------------------

/// On-disk file/dir name for a WGS GUID: uppercase hex of the mixed-endian
/// `bytes_le` layout (Windows `System.Guid.ToByteArray()`), i.e. the raw 16
/// bytes reordered `[3,2,1,0, 5,4, 7,6, 8..16]`. A naive canonical hex would
/// produce the WRONG filename.
pub fn guid_file_name(raw: &[u8; 16]) -> String {
    const ORDER: [usize; 16] = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
    let mut s = String::with_capacity(32);
    for &i in &ORDER {
        let _ = write!(s, "{:02X}", raw[i]);
    }
    s
}

// ---------------------------------------------------------------------------
// Byte reader
// ---------------------------------------------------------------------------

struct ByteReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], SaveError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|&e| e <= self.buf.len())
            .ok_or_else(|| {
                SaveError::Layout(format!(
                    "WGS parse: need {n} bytes at offset {}, only {} available",
                    self.pos,
                    self.buf.len().saturating_sub(self.pos)
                ))
            })?;
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, SaveError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, SaveError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u64(&mut self) -> Result<u64, SaveError> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn guid(&mut self) -> Result<[u8; 16], SaveError> {
        let b = self.take(16)?;
        let mut g = [0u8; 16];
        g.copy_from_slice(b);
        Ok(g)
    }

    /// `u32` code-unit count followed by that many UTF-16LE units; trailing NULs
    /// stripped so writers that include a terminator round-trip identically.
    fn utf16_str(&mut self) -> Result<String, SaveError> {
        let count = self.u32()? as usize;
        let byte_len = count
            .checked_mul(2)
            .ok_or_else(|| SaveError::Layout("WGS parse: string length overflow".into()))?;
        let bytes = self.take(byte_len)?;
        Ok(decode_utf16(bytes))
    }
}

fn decode_utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .trim_end_matches('\0')
        .to_string()
}

// ---------------------------------------------------------------------------
// containers.index
// ---------------------------------------------------------------------------

/// Smallest possible on-disk size of one `containers.index` entry: three
/// UTF-16 strings at their empty-string minimum (u32 length each = 12) + seq u8
/// + flag u32 + 16B GUID + mtime u64 + reserved u64 + size u64 = 57 bytes. Used
/// only to cap `Vec::with_capacity` against a crafted `count`; the read loop is
/// the real bound.
const MIN_INDEX_ENTRY_BYTES: usize = 57;

struct IndexEntry {
    name: String,
    seq: u8,
    uuid: [u8; 16],
    mtime: u64,
    size: u64,
}

fn parse_index(buf: &[u8]) -> Result<Vec<IndexEntry>, SaveError> {
    let mut r = ByteReader::new(buf);
    let version = r.u32()?;
    if version != CONTAINER_INDEX_VERSION {
        return Err(SaveError::Layout(format!(
            "unsupported WGS containers.index version {version} (0x{version:X}); this reader \
             understands only version 0x{CONTAINER_INDEX_VERSION:X} (14) that current Palworld \
             writes. The save may be from a different game version."
        )));
    }
    let count = r.u32()?;
    let _flag1 = r.u32()?;
    let _package_name = r.utf16_str()?;
    let _mtime = r.u64()?;
    // Trailer (flag2 u32 + index_uuid string + reserved u64): consumed verbatim.
    let _flag2 = r.u32()?;
    let _index_uuid = r.utf16_str()?;
    let _reserved = r.u64()?;

    // Cap the presize against what the remaining buffer could possibly hold: a
    // crafted count (e.g. 0xFFFFFFFF) must not pre-allocate gigabytes and abort
    // the allocator / trap the wasm worker before the read loop even runs. Each
    // entry is at least MIN_INDEX_ENTRY_BYTES; the loop below still bounds the
    // real iteration and errors on a short buffer.
    let remaining = buf.len().saturating_sub(r.pos);
    let mut entries = Vec::with_capacity((count as usize).min(remaining / MIN_INDEX_ENTRY_BYTES));
    for _ in 0..count {
        let name = r.utf16_str()?;
        let _name_repeat = r.utf16_str()?;
        let _cloud_id = r.utf16_str()?;
        let seq = r.u8()?;
        let _flag = r.u32()?;
        let uuid = r.guid()?;
        let mtime = r.u64()?;
        let _reserved = r.u64()?;
        let size = r.u64()?;
        entries.push(IndexEntry {
            name,
            seq,
            uuid,
            mtime,
            size,
        });
    }
    Ok(entries)
}

// ---------------------------------------------------------------------------
// container.<seq>
// ---------------------------------------------------------------------------

/// Exact on-disk size of one `container.<seq>` record: 128B UTF-16 name +
/// 2×16B GUIDs. Used to cap `Vec::with_capacity` against a crafted `file_count`.
const CONTAINER_FILE_RECORD_BYTES: usize = 160;

struct FileRecord {
    cloud_guid: [u8; 16],
    file_guid: [u8; 16],
}

fn parse_container_file(buf: &[u8]) -> Result<Vec<FileRecord>, SaveError> {
    let mut r = ByteReader::new(buf);
    let version = r.u32()?;
    if version != CONTAINER_FILE_LIST_VERSION {
        return Err(SaveError::Layout(format!(
            "unsupported WGS container file version {version}; expected {CONTAINER_FILE_LIST_VERSION}"
        )));
    }
    let file_count = r.u32()?;
    // Cap the presize against the remaining buffer: a crafted file_count must not
    // pre-allocate gigabytes and abort before the read loop runs. Records are
    // exactly CONTAINER_FILE_RECORD_BYTES each; the loop below is the real bound.
    let remaining = buf.len().saturating_sub(r.pos);
    let mut recs =
        Vec::with_capacity((file_count as usize).min(remaining / CONTAINER_FILE_RECORD_BYTES));
    for _ in 0..file_count {
        let _name = decode_utf16(r.take(128)?); // 64 UTF-16 units, always "Data"
        let cloud_guid = r.guid()?;
        let file_guid = r.guid()?;
        recs.push(FileRecord {
            cloud_guid,
            file_guid,
        });
    }
    Ok(recs)
}

// ---------------------------------------------------------------------------
// Container-name -> save file mapping
// ---------------------------------------------------------------------------

/// The role a container plays within its world, derived from the name suffix.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum FileKey {
    Level,
    LevelMeta,
    LocalData,
    WorldOption,
    Player(String),
    PlayerDps(String),
}

impl FileKey {
    /// Steam-tree-relative destination for this file.
    fn target_path(&self) -> String {
        match self {
            FileKey::Level => "Level.sav".into(),
            FileKey::LevelMeta => "LevelMeta.sav".into(),
            FileKey::LocalData => "LocalData.sav".into(),
            FileKey::WorldOption => "WorldOption.sav".into(),
            FileKey::Player(uid) => format!("Players/{uid}.sav"),
            FileKey::PlayerDps(uid) => format!("Players/{uid}_dps.sav"),
        }
    }
}

fn suffix_to_key(suffix: &str) -> Option<FileKey> {
    match suffix {
        "Level" => Some(FileKey::Level),
        "LevelMeta" => Some(FileKey::LevelMeta),
        "LocalData" => Some(FileKey::LocalData),
        "WorldOption" => Some(FileKey::WorldOption),
        _ => {
            let uid = suffix.strip_prefix("Players-")?;
            match uid.strip_suffix("_dps") {
                Some(base) => Some(FileKey::PlayerDps(base.to_string())),
                None => Some(FileKey::Player(uid.to_string())),
            }
        }
    }
}

/// Strip the game's `-Slot<n>-` and trailing `-<2 digits>` revision decorations
/// so revision-bumped container names collapse to one canonical base.
fn clean_container_name(name: &str) -> String {
    let s = strip_slot(name);
    strip_trailing_revision(&s)
}

fn strip_slot(name: &str) -> String {
    if let Some(idx) = name.find("-Slot") {
        let after = &name[idx + 5..];
        let digits_end = after
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(after.len());
        if digits_end > 0 && after[digits_end..].starts_with('-') {
            // Keep the trailing dash: "A-Slot0-Level" -> "A-Level".
            return format!("{}{}", &name[..idx], &after[digits_end..]);
        }
    }
    name.to_string()
}

fn strip_trailing_revision(name: &str) -> String {
    let b = name.as_bytes();
    let n = b.len();
    if n >= 3 && b[n - 3] == b'-' && b[n - 2].is_ascii_digit() && b[n - 1].is_ascii_digit() {
        name[..n - 3].to_string()
    } else {
        name.to_string()
    }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

/// Scan the whole store: parse `containers.index`, pick the latest generation of
/// each container, resolve its blob and group into worlds.
///
/// Reads `containers.index` and each chosen `container.<seq>`, and probes blob
/// files for existence so [`WgsFileRef::blob_path`] resolves the dual-GUID
/// atomic-write case ("try file_guid, then cloud_guid; both missing → skip the
/// container"). Worlds without a `Level.sav` blob are dropped with a warning.
pub fn manifest(read: WgsRead) -> Result<WgsManifest, SaveError> {
    let index_bytes = read("containers.index")
        .ok_or_else(|| SaveError::Layout("WGS containers.index not found in store root".into()))?;
    let entries = parse_index(&index_bytes)?;
    let mut warnings = Vec::new();

    // 1. Map entries to (save_id, key) and keep the latest generation of each:
    //    highest seq, tie-broken by newest mtime. seq is a numeric u8, so
    //    "container.10" beats "container.2" (a lexicographic bug would not).
    let mut chosen: HashMap<(String, FileKey), IndexEntry> = HashMap::new();
    for entry in entries {
        // `EggTest*` ghost containers are test artifacts — dropped silently.
        if entry.name.starts_with("EggTest") {
            continue;
        }
        let cleaned = clean_container_name(&entry.name);
        let Some((save_id, suffix)) = cleaned.split_once('-') else {
            warnings.push(format!(
                "container '{}' has no '<SaveID>-<Suffix>' shape; skipped",
                entry.name
            ));
            continue;
        };
        let Some(key) = suffix_to_key(suffix) else {
            warnings.push(format!(
                "container '{}' has unknown suffix '{suffix}'; skipped",
                entry.name
            ));
            continue;
        };
        let k = (save_id.to_string(), key);
        let better = match chosen.get(&k) {
            None => true,
            Some(cur) => entry.seq > cur.seq || (entry.seq == cur.seq && entry.mtime > cur.mtime),
        };
        if better {
            chosen.insert(k, entry);
        }
    }

    // 2. Resolve each chosen generation's blob and group by world. Sorted for a
    //    deterministic manifest (independent of HashMap iteration order).
    let mut chosen_vec: Vec<((String, FileKey), IndexEntry)> = chosen.into_iter().collect();
    chosen_vec.sort_by(|a, b| {
        a.0 .0
            .cmp(&b.0 .0)
            .then_with(|| a.0 .1.target_path().cmp(&b.0 .1.target_path()))
    });

    let mut worlds_map: HashMap<String, Vec<WgsFileRef>> = HashMap::new();
    let mut world_mtime: HashMap<String, u64> = HashMap::new();

    for ((save_id, key), entry) in chosen_vec {
        let dir = guid_file_name(&entry.uuid);
        let container_path = format!("{dir}/container.{}", entry.seq);
        let Some(cfile) = read(&container_path) else {
            warnings.push(format!(
                "container file '{container_path}' missing (incomplete cloud sync); skipped"
            ));
            continue;
        };
        let recs = match parse_container_file(&cfile) {
            Ok(r) => r,
            Err(e) => {
                warnings.push(format!("container file '{container_path}': {e}; skipped"));
                continue;
            }
        };
        let Some(rec) = recs.first() else {
            warnings.push(format!(
                "container '{}' lists no files; skipped",
                entry.name
            ));
            continue;
        };

        // Dual-GUID atomic write: the blob is named by whichever of file_guid /
        // cloud_guid actually exists on disk. Try file_guid first.
        let Some(blob_path) = resolve_blob_path(read, &dir, rec) else {
            warnings.push(format!(
                "blob for container '{}' missing (incomplete cloud sync); skipped",
                entry.name
            ));
            continue;
        };

        worlds_map
            .entry(save_id.clone())
            .or_default()
            .push(WgsFileRef {
                target_path: key.target_path(),
                blob_path,
                size: entry.size,
            });
        let m = world_mtime.entry(save_id).or_insert(0);
        *m = (*m).max(entry.mtime);
    }

    // 3. Build worlds; a world with no Level blob is unusable and dropped.
    let mut worlds: Vec<WgsWorldManifest> = Vec::new();
    for (save_id, files) in worlds_map {
        if !files.iter().any(|f| f.target_path == "Level.sav") {
            warnings.push(format!("world '{save_id}' has no Level.sav blob; dropped"));
            continue;
        }
        let mtime_ticks = world_mtime.get(&save_id).copied().unwrap_or(0);
        worlds.push(WgsWorldManifest {
            save_id,
            mtime_ticks,
            files,
        });
    }
    worlds.sort_by(|a, b| a.save_id.cmp(&b.save_id));

    Ok(WgsManifest { worlds, warnings })
}

/// Resolve a file record's blob to a store-relative path, honoring the dual-GUID
/// atomic-write case: `file_guid` is the primary, `cloud_guid` the alternate.
/// `None` when neither blob file exists.
fn resolve_blob_path(read: WgsRead, dir: &str, rec: &FileRecord) -> Option<String> {
    let file_path = format!("{dir}/{}", guid_file_name(&rec.file_guid));
    if read(&file_path).is_some() {
        return Some(file_path);
    }
    let cloud_path = format!("{dir}/{}", guid_file_name(&rec.cloud_guid));
    if read(&cloud_path).is_some() {
        return Some(cloud_path);
    }
    None
}

// ---------------------------------------------------------------------------
// list_worlds
// ---------------------------------------------------------------------------

/// Summarize every world for a save picker: world name (from `LevelMeta.sav`)
/// and human player count. Decompresses each `LevelMeta` blob; a world with an
/// absent or corrupt `LevelMeta` simply reports `world_name = None`.
pub fn list_worlds(read: WgsRead) -> Result<Vec<WgsWorld>, SaveError> {
    let manifest = manifest(read)?;
    let mut out = Vec::with_capacity(manifest.worlds.len());
    for w in &manifest.worlds {
        let meta_path = w
            .files
            .iter()
            .find(|f| f.target_path == "LevelMeta.sav")
            .map(|f| f.blob_path.clone());
        let world_name = meta_path
            .and_then(|p| read(&p))
            .and_then(|bytes| compress::decompress_sav(&bytes).ok())
            .and_then(|blob| crate::characters::parse_world_name(&blob).ok().flatten());
        let player_count = w
            .files
            .iter()
            .filter(|f| {
                f.target_path.starts_with("Players/") && !f.target_path.ends_with("_dps.sav")
            })
            .count() as u32;
        out.push(WgsWorld {
            save_id: w.save_id.clone(),
            world_name,
            mtime_ticks: w.mtime_ticks,
            player_count,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// extract_world
// ---------------------------------------------------------------------------

/// Read every blob for one world into raw, still-compressed `.sav` bytes ready
/// for [`crate::read_save_from_parts`]. A missing `Level.sav` is a hard error;
/// missing optional blobs are skipped with a warning.
pub fn extract_world(read: WgsRead, save_id: &str) -> Result<ExtractedWorld, SaveError> {
    let manifest = manifest(read)?;
    let Some(world) = manifest.worlds.into_iter().find(|w| w.save_id == save_id) else {
        return Err(SaveError::Layout(format!(
            "WGS world '{save_id}' not found in store"
        )));
    };

    let mut level: Option<Vec<u8>> = None;
    let mut level_meta = None;
    let mut world_option = None;
    let mut local_data = None;
    let mut players = Vec::new();
    let mut dps = Vec::new();
    let mut warnings = Vec::new();

    for f in &world.files {
        let Some(bytes) = read(&f.blob_path) else {
            if f.target_path == "Level.sav" {
                return Err(SaveError::Layout(format!(
                    "WGS world '{save_id}': Level.sav blob '{}' missing",
                    f.blob_path
                )));
            }
            warnings.push(format!(
                "blob '{}' for {} missing; skipped",
                f.blob_path, f.target_path
            ));
            continue;
        };
        match f.target_path.as_str() {
            "Level.sav" => level = Some(bytes),
            "LevelMeta.sav" => level_meta = Some(bytes),
            "WorldOption.sav" => world_option = Some(bytes),
            "LocalData.sav" => local_data = Some(bytes),
            p if p.starts_with("Players/") && p.ends_with("_dps.sav") => {
                let label = p.trim_start_matches("Players/").to_string();
                dps.push((label, bytes));
            }
            p if p.starts_with("Players/") => {
                let label = p.trim_start_matches("Players/").to_string();
                players.push((label, bytes));
            }
            other => warnings.push(format!("unexpected target '{other}'; skipped")),
        }
    }

    let Some(level) = level else {
        return Err(SaveError::Layout(format!(
            "WGS world '{save_id}': no Level.sav blob"
        )));
    };

    Ok(ExtractedWorld {
        level,
        level_meta,
        players,
        dps,
        world_option,
        local_data,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_file_name_mixed_endian() {
        // bytes_le swap: [3,2,1,0, 5,4, 7,6, 8..16].
        let raw: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(guid_file_name(&raw), "33221100554477668899AABBCCDDEEFF");
    }

    #[test]
    fn clean_container_name_strips_decorations() {
        assert_eq!(clean_container_name("ABC-Slot0-Level"), "ABC-Level");
        assert_eq!(clean_container_name("ABC-Level-03"), "ABC-Level");
        assert_eq!(clean_container_name("ABC-Slot2-Level-07"), "ABC-Level");
        // A 32-hex player UID must not be mistaken for a 2-digit revision.
        assert_eq!(
            clean_container_name("ABC-Players-0483729D000000000000000000000000"),
            "ABC-Players-0483729D000000000000000000000000"
        );
    }

    #[test]
    fn suffix_to_key_players_and_dps() {
        assert_eq!(suffix_to_key("Level"), Some(FileKey::Level));
        assert_eq!(
            suffix_to_key("Players-ABCD"),
            Some(FileKey::Player("ABCD".into()))
        );
        assert_eq!(
            suffix_to_key("Players-ABCD_dps"),
            Some(FileKey::PlayerDps("ABCD".into()))
        );
        assert_eq!(suffix_to_key("Bogus"), None);
    }

    /// A `containers.index` declaring count=0xFFFFFFFF with only a handful of
    /// trailing bytes must return `Err` (short buffer), NOT abort the allocator
    /// with a capacity-overflow via `Vec::with_capacity(count)`.
    #[test]
    fn parse_index_huge_count_does_not_oom() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&CONTAINER_INDEX_VERSION.to_le_bytes()); // version 0xE
        buf.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // count
        buf.extend_from_slice(&0u32.to_le_bytes()); // flag1
        buf.extend_from_slice(&0u32.to_le_bytes()); // package_name (empty utf16)
        buf.extend_from_slice(&0u64.to_le_bytes()); // mtime
        buf.extend_from_slice(&0u32.to_le_bytes()); // flag2
        buf.extend_from_slice(&0u32.to_le_bytes()); // index_uuid (empty utf16)
        buf.extend_from_slice(&0u64.to_le_bytes()); // reserved
        buf.extend_from_slice(&[1, 2, 3, 4]); // a handful of trailing bytes
        assert!(parse_index(&buf).is_err());
    }

    /// A `container.<seq>` declaring file_count=0xFFFFFFFF with a handful of
    /// trailing bytes must return `Err`, NOT abort via a giant pre-allocation.
    #[test]
    fn parse_container_file_huge_count_does_not_oom() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&CONTAINER_FILE_LIST_VERSION.to_le_bytes()); // version 4
        buf.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // file_count
        buf.extend_from_slice(&[1, 2, 3, 4]); // a handful of trailing bytes
        assert!(parse_container_file(&buf).is_err());
    }
}
