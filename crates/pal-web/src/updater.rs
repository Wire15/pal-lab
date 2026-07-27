//! Web mirror of the ABOUT-panel data commands in
//! `app/src-tauri/src/updater.rs`.
//!
//! `data_pack_info` is a pure read of the embedded `'static` [`pal_data::GameData`]
//! pack, so it ports verbatim. `check_update` performs a blocking network fetch
//! (ureq) in the native build; that has no faithful single-threaded wasm analogue
//! and is intentionally out of scope this wave, so the dispatcher returns a
//! descriptive `Err` for it instead of half-implementing it here.

use serde::Serialize;

/// Embedded data-pack identity for the ABOUT panel: the pal-data pack version
/// (e.g. `"v26"`) and the Palworld game build it was extracted from.
#[derive(Debug, Clone, Serialize)]
pub struct DataPackInfo {
    pub pack_version: String,
    pub game_build: String,
}

/// Report the embedded pal-data pack's version + source game build. Reads the
/// already-decoded `'static` [`pal_data::GameData`]; no allocation beyond the
/// two returned strings.
pub fn data_pack_info() -> DataPackInfo {
    let gd = pal_data::GameData::get();
    DataPackInfo {
        pack_version: gd.version().to_string(),
        game_build: gd.game_build().to_string(),
    }
}
