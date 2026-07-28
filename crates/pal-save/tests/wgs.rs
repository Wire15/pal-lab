//! Xbox / Game Pass WGS reader tests.
//!
//! Two layers: hand-built in-memory stores exercise the parsing edge cases
//! (version rejection, numeric seq ordering, name decorations, EggTest drop,
//! dual-GUID fallback, missing-blob skip), and an oracle test — gated on the
//! gitignored `testdata/` fixtures — proves the WGS pipeline reads a real save
//! identically to the Steam-directory reader, including the CNK round-trip.

use std::collections::HashMap;
use std::path::PathBuf;

use pal_save::wgs::{self, guid_file_name};

// ---------------------------------------------------------------------------
// Synthetic in-memory store builder
// ---------------------------------------------------------------------------

fn push_u16str(out: &mut Vec<u8>, s: &str) {
    let units: Vec<u16> = s.encode_utf16().collect();
    out.extend_from_slice(&(units.len() as u32).to_le_bytes());
    for u in units {
        out.extend_from_slice(&u.to_le_bytes());
    }
}

/// Distinct 16-byte GUID from a seed byte.
fn g(n: u8) -> [u8; 16] {
    [n; 16]
}

fn zeros() -> [u8; 16] {
    [0u8; 16]
}

struct Store {
    map: HashMap<String, Vec<u8>>,
    entries: Vec<u8>,
    count: u32,
    version: u32,
}

impl Store {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            entries: Vec::new(),
            count: 0,
            version: 0xE,
        }
    }

    /// Add a container: an index entry, its `container.<seq>` file list (unless
    /// `write_cfile` is false) and, when `blob` is `Some((guid, bytes))`, a blob
    /// stored under `guid`'s on-disk name.
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        name: &str,
        seq: u8,
        uuid: [u8; 16],
        mtime: u64,
        file_guid: [u8; 16],
        cloud_guid: [u8; 16],
        blob: Option<([u8; 16], Vec<u8>)>,
        write_cfile: bool,
    ) {
        push_u16str(&mut self.entries, name);
        push_u16str(&mut self.entries, name); // name_repeat
        push_u16str(&mut self.entries, ""); // cloud_id
        self.entries.push(seq);
        self.entries.extend_from_slice(&5u32.to_le_bytes()); // flag
        self.entries.extend_from_slice(&uuid);
        self.entries.extend_from_slice(&mtime.to_le_bytes());
        self.entries.extend_from_slice(&0u64.to_le_bytes()); // reserved
        let size = blob.as_ref().map(|(_, b)| b.len() as u64).unwrap_or(0);
        self.entries.extend_from_slice(&size.to_le_bytes());
        self.count += 1;

        let dir = guid_file_name(&uuid);
        if write_cfile {
            let mut cf = Vec::new();
            cf.extend_from_slice(&4u32.to_le_bytes()); // version
            cf.extend_from_slice(&1u32.to_le_bytes()); // file_count
            cf.extend_from_slice(&[0u8; 128]); // 128-byte name field
            cf.extend_from_slice(&cloud_guid);
            cf.extend_from_slice(&file_guid);
            self.map.insert(format!("{dir}/container.{seq}"), cf);
        }
        if let Some((blob_guid, content)) = blob {
            self.map
                .insert(format!("{dir}/{}", guid_file_name(&blob_guid)), content);
        }
    }

    fn finish(mut self) -> HashMap<String, Vec<u8>> {
        let mut idx = Vec::new();
        idx.extend_from_slice(&self.version.to_le_bytes());
        idx.extend_from_slice(&self.count.to_le_bytes());
        idx.extend_from_slice(&0u32.to_le_bytes()); // flag1
        push_u16str(&mut idx, "PocketpairInc.Palworld_ad4psfrxyesvt");
        idx.extend_from_slice(&0u64.to_le_bytes()); // mtime
        idx.extend_from_slice(&0u32.to_le_bytes()); // flag2 (trailer)
        push_u16str(&mut idx, ""); // index_uuid (trailer)
        idx.extend_from_slice(&0u64.to_le_bytes()); // reserved (trailer)
        idx.extend_from_slice(&self.entries);
        self.map.insert("containers.index".into(), idx);
        self.map
    }
}

// ---------------------------------------------------------------------------
// Synthetic-store tests
// ---------------------------------------------------------------------------

#[test]
fn rejects_unsupported_index_version() {
    let mut b = Store::new();
    b.version = 0xD;
    b.add(
        "SAVE-Level",
        1,
        g(1),
        0,
        g(2),
        zeros(),
        Some((g(2), vec![1, 2, 3])),
        true,
    );
    let store = b.finish();
    let mut read = |p: &str| store.get(p).cloned();
    match wgs::manifest(&mut read) {
        Err(e) => assert!(format!("{e}").contains("version"), "message: {e}"),
        Ok(_) => panic!("expected version rejection"),
    }
}

#[test]
fn picks_highest_numeric_seq() {
    // Two Level generations of the same world. seq 10 must beat seq 2 even
    // though its mtime is *lower* (seq dominates), and even though the filename
    // "container.10" sorts before "container.2" lexicographically.
    let mut b = Store::new();
    b.add(
        "SAVE-Level",
        2,
        g(1),
        100,
        g(2),
        zeros(),
        Some((g(2), b"OLD".to_vec())),
        true,
    );
    b.add(
        "SAVE-Level",
        10,
        g(3),
        50,
        g(4),
        zeros(),
        Some((g(4), b"NEW".to_vec())),
        true,
    );
    let store = b.finish();
    let mut read = |p: &str| store.get(p).cloned();
    let ex = wgs::extract_world(&mut read, "SAVE").expect("extract");
    assert_eq!(ex.level, b"NEW");
}

#[test]
fn strips_decorations_and_drops_eggtest() {
    let mut b = Store::new();
    // "-Slot0-" and trailing "-03" revision both stripped -> world "SAVE".
    b.add(
        "SAVE-Slot0-Level-03",
        1,
        g(1),
        0,
        g(2),
        zeros(),
        Some((g(2), b"LVL".to_vec())),
        true,
    );
    // EggTest ghost container: dropped entirely, never becomes a world.
    b.add(
        "EggTestGhost-Level",
        1,
        g(5),
        0,
        g(6),
        zeros(),
        Some((g(6), b"EGG".to_vec())),
        true,
    );
    let store = b.finish();
    let mut read = |p: &str| store.get(p).cloned();
    let m = wgs::manifest(&mut read).expect("manifest");
    assert_eq!(m.worlds.len(), 1);
    assert_eq!(m.worlds[0].save_id, "SAVE");
    assert!(m.worlds[0]
        .files
        .iter()
        .any(|f| f.target_path == "Level.sav"));
    assert!(!m.worlds.iter().any(|w| w.save_id.starts_with("EggTest")));
}

#[test]
fn dual_guid_falls_back_to_cloud() {
    // file_guid names a blob that is absent; cloud_guid names the one on disk.
    let mut b = Store::new();
    b.add(
        "SAVE-Level",
        1,
        g(1),
        0,
        /* file_guid */ g(2),
        /* cloud_guid */ g(9),
        Some((g(9), b"CLOUD".to_vec())),
        true,
    );
    let store = b.finish();
    let mut read = |p: &str| store.get(p).cloned();
    let m = wgs::manifest(&mut read).expect("manifest");
    assert_eq!(m.worlds.len(), 1);
    let level = m.worlds[0]
        .files
        .iter()
        .find(|f| f.target_path == "Level.sav")
        .expect("Level file");
    let dir = guid_file_name(&g(1));
    assert_eq!(level.blob_path, format!("{dir}/{}", guid_file_name(&g(9))));
    let ex = wgs::extract_world(&mut read, "SAVE").expect("extract");
    assert_eq!(ex.level, b"CLOUD");
}

#[test]
fn missing_blob_skipped_with_warning() {
    let mut b = Store::new();
    // Valid Level keeps the world alive.
    b.add(
        "SAVE-Level",
        1,
        g(1),
        0,
        g(2),
        zeros(),
        Some((g(2), b"LVL".to_vec())),
        true,
    );
    // Player container whose blob is entirely absent (neither GUID resolves).
    b.add("SAVE-Players-AAAA", 1, g(3), 0, g(4), zeros(), None, true);
    let store = b.finish();
    let mut read = |p: &str| store.get(p).cloned();
    let m = wgs::manifest(&mut read).expect("manifest");
    assert_eq!(m.worlds.len(), 1);
    assert!(!m.worlds[0]
        .files
        .iter()
        .any(|f| f.target_path.starts_with("Players/")));
    assert!(
        m.warnings.iter().any(|w| w.contains("missing")),
        "expected a missing-blob warning, got {:?}",
        m.warnings
    );
}

#[test]
fn drops_world_without_level() {
    // A world with only a LevelMeta (no Level blob) is unusable and dropped.
    let mut b = Store::new();
    b.add(
        "SAVE-LevelMeta",
        1,
        g(1),
        0,
        g(2),
        zeros(),
        Some((g(2), b"META".to_vec())),
        true,
    );
    let store = b.finish();
    let mut read = |p: &str| store.get(p).cloned();
    let m = wgs::manifest(&mut read).expect("manifest");
    assert!(m.worlds.is_empty());
    assert!(m.warnings.iter().any(|w| w.contains("Level")));
}

// ---------------------------------------------------------------------------
// Oracle test (gated on gitignored testdata fixtures)
// ---------------------------------------------------------------------------

fn wgs_store_dir() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/wgs1/0000000000000001_00000000000000000000000000000001");
    p.join("containers.index").is_file().then_some(p)
}

fn steam_save_dir() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58");
    p.is_dir().then_some(p)
}

#[test]
fn oracle_wgs_matches_steam_read() {
    let (Some(wgs_dir), Some(steam_dir)) = (wgs_store_dir(), steam_save_dir()) else {
        eprintln!("oracle_wgs_matches_steam_read: testdata absent, skipping");
        return;
    };

    let mut read = |p: &str| std::fs::read(wgs_dir.join(p)).ok();

    // Baseline: read the Steam-directory save directly.
    let baseline = pal_save::read_save_dir(&steam_dir).expect("read steam save");

    // list_worlds: exactly one world, correct id, name and player count.
    let worlds = wgs::list_worlds(&mut read).expect("list_worlds");
    assert_eq!(worlds.len(), 1, "one world in the fixture");
    let w = &worlds[0];
    assert_eq!(w.save_id, "11B693994C6849F2AAF47088BD302C58");
    assert_eq!(w.world_name, baseline.world_name, "list_worlds world_name");

    let steam_player_files = std::fs::read_dir(steam_dir.join("Players"))
        .expect("Players dir")
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.ends_with(".sav") && !n.ends_with("_dps.sav")
        })
        .count();
    assert_eq!(
        w.player_count as usize, steam_player_files,
        "player_count == Steam player files (excl _dps)"
    );

    // extract_world -> read_save_from_parts must match the baseline save.
    let ex = wgs::extract_world(&mut read, &w.save_id).expect("extract_world");
    assert_eq!(&ex.level[8..11], b"CNK", "fixture Level.sav is CNK-wrapped");

    let wgs_save = pal_save::read_save_from_parts(
        &ex.level,
        ex.level_meta.as_deref(),
        &ex.players,
        &ex.dps,
    )
    .expect("read_save_from_parts over WGS blobs");

    assert_eq!(
        wgs_save.pals.len(),
        baseline.pals.len(),
        "pal count matches Steam read"
    );
    assert_eq!(
        wgs_save.players.len(),
        baseline.players.len(),
        "player count matches Steam read"
    );
    assert_eq!(
        wgs_save.world_name, baseline.world_name,
        "world name matches Steam read"
    );

    // CNK round-trip: the re-wrapped Level decompresses byte-identically to the
    // original PlM Level.sav's GVAS blob.
    let steam_level = std::fs::read(steam_dir.join("Level.sav")).expect("read Level.sav");
    let from_cnk = pal_save::compress::decompress_sav(&ex.level).expect("decompress CNK level");
    let from_plm = pal_save::compress::decompress_sav(&steam_level).expect("decompress PlM level");
    assert_eq!(
        from_cnk, from_plm,
        "CNK Level decompresses identically to the PlM original"
    );
}
