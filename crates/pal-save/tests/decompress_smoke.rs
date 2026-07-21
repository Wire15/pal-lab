use std::path::PathBuf;

fn save_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58")
}

fn try_one(name: &str) {
    let path = save_dir().join(name);
    let raw = std::fs::read(&path).expect("read");
    eprintln!("--- {name}: {} raw bytes, header {:02x?}", raw.len(), &raw[..16]);
    match pal_save::compress::decompress_sav(&raw) {
        Ok(blob) => eprintln!("  OK -> {} bytes, magic {:02x?}", blob.len(), &blob[..8.min(blob.len())]),
        Err(e) => eprintln!("  ERR {e}"),
    }
}

#[test]
fn decompress_all() {
    try_one("Players/0483729D000000000000000000000000.sav");
    try_one("LevelMeta.sav");
    try_one("Level.sav");
}
