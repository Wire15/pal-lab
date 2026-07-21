use std::path::PathBuf;

fn save_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58")
}

fn decompress(name: &str) -> Vec<u8> {
    let path = save_dir().join(name);
    let raw = std::fs::read(&path).expect("read sav");
    pal_save::compress::decompress_sav(&raw).expect("decompress")
}

/// GVAS magic "GVAS" as little-endian bytes at offset 0.
const GVAS_MAGIC: &[u8] = &[0x47, 0x56, 0x41, 0x53];

#[test]
fn players_and_meta_decompress_to_gvas() {
    for name in [
        "Players/0483729D000000000000000000000000.sav",
        "LevelMeta.sav",
    ] {
        let blob = decompress(name);
        assert!(blob.len() >= 8, "{name}: too small");
        assert_eq!(&blob[..4], GVAS_MAGIC, "{name}: missing GVAS magic");
    }
}

#[test]
fn level_sav_decompresses_via_oodle() {
    let blob = decompress("Level.sav");
    // 1.8 MB Oodle Kraken payload inflates to ~30 MB of GVAS.
    assert!(
        blob.len() > 25_000_000,
        "Level.sav inflated to only {} bytes",
        blob.len()
    );
    assert_eq!(&blob[..4], GVAS_MAGIC, "Level.sav missing GVAS magic");
    // save_game_version == 3 (i32 LE right after the magic).
    assert_eq!(
        i32::from_le_bytes([blob[4], blob[5], blob[6], blob[7]]),
        3,
        "unexpected save game version"
    );
}
