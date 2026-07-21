//! Frontend-facing save summary + the `load_save` command.
//!
//! `load_save` reads a real Palworld save directory via `pal_save` and maps its
//! [`pal_save::SaveData`] into a [`SaveSummary`]. `SaveSummary.pals` is
//! `Vec<pal_data::OwnedPal>` serialized with its default serde derive, so the
//! JSON shape matches `crates/pal-data/src/types.rs` exactly.

use std::path::Path;

use pal_data::types::{Guid, OwnedPal};
use serde::Serialize;

/// A player entry, keyed by a display-formatted GUID string.
#[derive(Debug, Clone, Serialize)]
pub struct PlayerRef {
    pub uid: String,
    pub name: String,
}

/// Everything the Save Inspector view needs from one loaded world.
#[derive(Debug, Clone, Serialize)]
pub struct SaveSummary {
    pub world_name: String,
    pub players: Vec<PlayerRef>,
    pub pals: Vec<OwnedPal>,
    /// Non-fatal parser warnings (skipped entities, unreadable sub-saves).
    pub warnings: Vec<String>,
}

/// Format a GUID as the lowercase 32-char hex string the UI expects.
fn guid_str(g: &Guid) -> String {
    g.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

/// Map a parsed [`pal_save::SaveData`] into the frontend summary shape.
fn to_summary(save: pal_save::SaveData) -> SaveSummary {
    SaveSummary {
        world_name: save.world_name.unwrap_or_else(|| "Unknown World".into()),
        players: save
            .players
            .iter()
            .map(|p| PlayerRef {
                uid: guid_str(&p.uid),
                name: p.name.clone(),
            })
            .collect(),
        pals: save.pals,
        warnings: save.warnings,
    }
}

/// Load a save from `save_dir` and summarize it for the UI. Read-only.
#[tauri::command]
pub fn load_save(save_dir: String) -> Result<SaveSummary, String> {
    if save_dir.trim().is_empty() {
        return Err("No save folder selected.".into());
    }
    let save = pal_save::read_save_dir(Path::new(&save_dir)).map_err(|e| e.to_string())?;
    Ok(to_summary(save))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn testdata_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58")
    }

    #[test]
    fn maps_real_save_into_summary() {
        let save = pal_save::read_save_dir(testdata_dir()).expect("read save dir");
        let summary = to_summary(save);

        assert_eq!(summary.world_name.is_empty(), false, "world name empty");
        assert_eq!(summary.players.len(), 4, "expected 4 players");
        assert!(
            summary.pals.len() > 1500,
            "expected a large roster, got {}",
            summary.pals.len()
        );

        // Every player uid is a 32-char lowercase hex string.
        for p in &summary.players {
            assert_eq!(p.uid.len(), 32, "uid not 32 hex chars: {}", p.uid);
            assert!(
                p.uid.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "uid not lowercase hex: {}",
                p.uid
            );
            assert!(!p.name.is_empty(), "player name empty");
        }

        // Dimensional storage really merged (the classification gap this closes).
        let dimensional = summary
            .pals
            .iter()
            .filter(|p| {
                matches!(
                    p.container_kind,
                    pal_data::types::ContainerKind::DimensionalPalStorage
                )
            })
            .count();
        assert!(dimensional > 0, "no dimensional-storage pals in summary");
    }
}
