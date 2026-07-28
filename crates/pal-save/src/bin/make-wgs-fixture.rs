//! Dev tool: pack a real Palworld save directory into a synthetic Xbox / Game
//! Pass **WGS** container store, for testing the [`pal_save::wgs`] reader
//! without needing a real Game Pass installation.
//!
//! Usage: `make-wgs-fixture <save_dir> <out_wgs_user_dir>`
//!
//! `save_dir` is a Steam-style world folder (holding `Level.sav`,
//! `LevelMeta.sav`, optional `WorldOption.sav` / `LocalData.sav`, and a
//! `Players/` subdir). `out_wgs_user_dir` is the per-user WGS directory to
//! create (its basename is normally `<UserIdHex16>_<TitleGuidHex32>`).
//!
//! `Level.sav` is decompressed and re-emitted as a single-pass zlib **PlZ**
//! blob wrapped in the Xbox **CNK** double-header (exercising the CNK read
//! path); every other `.sav` is copied verbatim as its blob. A
//! `containers.index` (version 0xE) plus one `<GUID>/container.1` + blob per
//! file complete the store. GUIDs are random.

use std::io::Write as _;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::write::ZlibEncoder;
use flate2::Compression;

use pal_save::compress::decompress_sav;
use pal_save::wgs::guid_file_name;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: make-wgs-fixture <save_dir> <out_wgs_user_dir>");
        std::process::exit(2);
    }
    let save_dir = PathBuf::from(&args[1]);
    let out_dir = PathBuf::from(&args[2]);

    let save_id = save_dir
        .file_name()
        .and_then(|s| s.to_str())
        .expect("save_dir must have a basename")
        .to_string();

    // Gather (container-name-suffix-qualified name, blob bytes) for every file.
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();

    // Level.sav: decompress (PlM/PlZ) -> single-pass zlib PlZ -> CNK wrapper.
    let level_raw = std::fs::read(save_dir.join("Level.sav")).expect("read Level.sav");
    let level_blob = decompress_sav(&level_raw).expect("decompress Level.sav");
    let level_cnk = cnk_wrap(&plz_wrap(&level_blob));
    files.push((format!("{save_id}-Level"), level_cnk));

    // Optional world files: copied verbatim.
    for (fname, suffix) in [
        ("LevelMeta.sav", "LevelMeta"),
        ("WorldOption.sav", "WorldOption"),
        ("LocalData.sav", "LocalData"),
    ] {
        let p = save_dir.join(fname);
        if p.is_file() {
            let bytes = std::fs::read(&p).expect("read world file");
            files.push((format!("{save_id}-{suffix}"), bytes));
        }
    }

    // Player saves: copied verbatim. "<UID>.sav" -> "Players-<UID>",
    // "<UID>_dps.sav" -> "Players-<UID>_dps".
    if let Ok(entries) = std::fs::read_dir(save_dir.join("Players")) {
        let mut players: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("sav"))
            .collect();
        players.sort();
        for p in players {
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .expect("player file stem")
                .to_string();
            let bytes = std::fs::read(&p).expect("read player save");
            files.push((format!("{save_id}-Players-{stem}"), bytes));
        }
    }

    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let mut rng = Rng::seeded();
    let mtime = now_filetime();

    // containers.index header.
    let mut index = Vec::new();
    index.extend_from_slice(&0xE_u32.to_le_bytes()); // version
    index.extend_from_slice(&(files.len() as u32).to_le_bytes()); // container_count
    index.extend_from_slice(&0u32.to_le_bytes()); // flag1
    write_utf16_str(&mut index, "PocketpairInc.Palworld_ad4psfrxyesvt"); // package_name
    index.extend_from_slice(&mtime.to_le_bytes()); // mtime
    index.extend_from_slice(&0u32.to_le_bytes()); // flag2 (trailer)
    write_utf16_str(&mut index, ""); // index_uuid (trailer)
    index.extend_from_slice(&0u64.to_le_bytes()); // reserved (trailer)

    for (name, blob) in &files {
        let container_guid = rng.guid();
        let file_guid = rng.guid();
        let dir_name = guid_file_name(&container_guid);

        // containers.index entry.
        write_utf16_str(&mut index, name);
        write_utf16_str(&mut index, name); // name_repeat
        write_utf16_str(&mut index, ""); // cloud_id (empty -> local-only)
        index.push(1u8); // seq -> container.1
        index.extend_from_slice(&5u32.to_le_bytes()); // flag (local-only)
        index.extend_from_slice(&container_guid); // uuid
        index.extend_from_slice(&mtime.to_le_bytes()); // mtime
        index.extend_from_slice(&0u64.to_le_bytes()); // reserved
        index.extend_from_slice(&(blob.len() as u64).to_le_bytes()); // size

        // <dir>/container.1 file list (single "Data" record; cloud_guid zeros).
        let cdir = out_dir.join(&dir_name);
        std::fs::create_dir_all(&cdir).expect("create container dir");
        let mut cfile = Vec::new();
        cfile.extend_from_slice(&4u32.to_le_bytes()); // version
        cfile.extend_from_slice(&1u32.to_le_bytes()); // file_count
        write_fixed_utf16_64(&mut cfile, "Data"); // 128-byte name
        cfile.extend_from_slice(&[0u8; 16]); // cloud_guid (zeros on local disk)
        cfile.extend_from_slice(&file_guid); // file_guid
        std::fs::write(cdir.join("container.1"), &cfile).expect("write container.1");

        // <dir>/<file_guid_hex> blob.
        std::fs::write(cdir.join(guid_file_name(&file_guid)), blob).expect("write blob");
    }

    std::fs::write(out_dir.join("containers.index"), &index).expect("write containers.index");
    eprintln!(
        "wrote WGS store with {} containers to {}",
        files.len(),
        out_dir.display()
    );
}

/// Compress `raw` as a single-pass zlib PlZ `.sav` blob.
fn plz_wrap(raw: &[u8]) -> Vec<u8> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(raw).expect("zlib write");
    let comp = enc.finish().expect("zlib finish");
    let mut out = Vec::with_capacity(12 + comp.len());
    out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
    out.extend_from_slice(&(comp.len() as u32).to_le_bytes());
    out.extend_from_slice(b"PlZ");
    out.push(0x31);
    out.extend_from_slice(&comp);
    out
}

/// Prefix the 12-byte Xbox CNK outer wrapper onto a PlZ blob.
fn cnk_wrap(plz: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + plz.len());
    out.extend_from_slice(&0u32.to_le_bytes()); // outer uncompressed_len (ignored)
    out.extend_from_slice(&(plz.len() as u32).to_le_bytes()); // outer compressed_len (ignored)
    out.extend_from_slice(b"CNK");
    out.push(0x31);
    out.extend_from_slice(plz);
    out
}

/// `u32` code-unit count then UTF-16LE bytes (no NUL terminator).
fn write_utf16_str(out: &mut Vec<u8>, s: &str) {
    let units: Vec<u16> = s.encode_utf16().collect();
    out.extend_from_slice(&(units.len() as u32).to_le_bytes());
    for u in units {
        out.extend_from_slice(&u.to_le_bytes());
    }
}

/// Fixed 128-byte (64 UTF-16 units) NUL-padded name field.
fn write_fixed_utf16_64(out: &mut Vec<u8>, s: &str) {
    let mut units: Vec<u16> = s.encode_utf16().collect();
    units.resize(64, 0);
    for u in units {
        out.extend_from_slice(&u.to_le_bytes());
    }
}

/// Windows FILETIME (100 ns ticks since 1601-01-01 UTC) for the current time.
fn now_filetime() -> u64 {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after 1970");
    (d.as_secs() + 11_644_473_600) * 10_000_000 + u64::from(d.subsec_nanos()) / 100
}

/// SplitMix64 — enough randomness for unique fixture GUIDs, no extra deps.
struct Rng(u64);

impl Rng {
    fn seeded() -> Self {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x1234_5678_9abc_def0)
            | 1;
        Rng(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn guid(&mut self) -> [u8; 16] {
        let mut g = [0u8; 16];
        g[..8].copy_from_slice(&self.next_u64().to_le_bytes());
        g[8..].copy_from_slice(&self.next_u64().to_le_bytes());
        g
    }
}
