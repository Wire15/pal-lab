//! Name resolution shared by the `solve` CLI and the Tauri command: accept
//! either an internal id (`Anubis`, `Legend`) or an English display name.

use pal_data::types::PassiveId;
use pal_data::GameData;

/// Resolve a species by internal id (exact) or English display name
/// (case-insensitive). Returns the interned species index.
pub fn resolve_species(gd: &GameData, name: &str) -> Option<u16> {
    if let Some(idx) = gd.species_index(name) {
        return Some(idx);
    }
    let lower = name.to_lowercase();
    gd.species()
        .enumerate()
        .find(|(_, s)| s.name.to_lowercase() == lower)
        .map(|(i, _)| i as u16)
}

/// Resolve a passive by internal id (exact) or English display name
/// (case-insensitive). Returns the passive's internal id.
pub fn resolve_passive(gd: &GameData, name: &str) -> Option<PassiveId> {
    let lower = name.to_lowercase();
    gd.passives()
        .iter()
        .find(|p| p.internal_name == name || p.name.to_lowercase() == lower)
        .map(|p| p.internal_name.clone())
}
