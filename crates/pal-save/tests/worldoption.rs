//! `WorldOption.sav` parse smoke. The reference file (from a real save) lives in
//! the gitignored `testdata/worldoption/`; the test skips gracefully when it is
//! absent so CI without the fixture stays green.

use std::path::PathBuf;

fn worldoption_dir() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/worldoption");
    p.join("WorldOption.sav").is_file().then_some(p)
}

#[test]
fn parses_egg_hatch_hours_from_real_save() {
    let Some(dir) = worldoption_dir() else {
        eprintln!("parses_egg_hatch_hours_from_real_save: testdata absent, skipping");
        return;
    };
    let opts = pal_save::read_world_options(&dir)
        .expect("WorldOption.sav must parse")
        .expect("WorldOption.sav present => Some");
    let hours = opts
        .egg_hatch_hours
        .expect("PalEggDefaultHatchingTime present in the real save");
    eprintln!("scanned PalEggDefaultHatchingTime = {hours} hours");
    // Plausible world-setting range: > 0 and within the game's slider bounds.
    assert!(hours > 0.0 && hours <= 240.0, "implausible egg hatch hours: {hours}");
}

#[test]
fn missing_world_option_returns_none() {
    // A directory with no WorldOption.sav (the crate root) => Ok(None).
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let opts = pal_save::read_world_options(&dir).expect("absent file is not an error");
    assert!(opts.is_none(), "missing WorldOption.sav must yield None");
}
