//! Save summary mapping — the web mirror of `app/src-tauri/src/save.rs`.
//!
//! Maps a parsed [`pal_save::SaveData`] into the same [`SaveSummary`] JSON the
//! native `load_save` command returns. `pals` is `Vec<pal_data::OwnedPal>`
//! serialized with its default serde derive, so the JSON shape matches
//! `crates/pal-data/src/types.rs` exactly. Unlike native, the web build never
//! re-reads a directory: the parsed save is cached once by `load_save_bundle`
//! and re-summarized on demand.

use pal_data::types::{Guid, OwnedPal};
use serde::Serialize;

/// A player entry, keyed by a display-formatted GUID string.
#[derive(Debug, Clone, Serialize)]
pub struct PlayerRef {
    pub uid: String,
    pub name: String,
}

/// A guild-owned base camp, mapped to its worker pal-container and the guild's
/// member players. GUIDs are lowercase 32-char hex strings, matching
/// [`PlayerRef::uid`] and the hex form of [`pal_data::types::OwnedPal`]'s
/// `container_id`, so the UI can join bases to pals and player tabs directly.
#[derive(Debug, Clone, Serialize)]
pub struct BaseRef {
    pub container_id: String,
    pub guild_id: String,
    pub guild_name: String,
    pub member_uids: Vec<String>,
}

/// Everything the Save Inspector view needs from one loaded world.
#[derive(Debug, Clone, Serialize)]
pub struct SaveSummary {
    pub world_name: String,
    pub players: Vec<PlayerRef>,
    pub pals: Vec<OwnedPal>,
    /// Guild-owned base camps mapped to worker containers + member players.
    pub bases: Vec<BaseRef>,
    /// Non-fatal parser warnings (skipped entities, unreadable sub-saves).
    pub warnings: Vec<String>,
}

/// Format a GUID as the lowercase 32-char hex string the UI expects.
pub(crate) fn guid_str(g: &Guid) -> String {
    g.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

/// Map a parsed [`pal_save::SaveData`] into the frontend summary shape. Borrows
/// the cached save (the web build re-summarizes without re-reading), cloning the
/// roster into the response the same way the native by-value mapping moved it.
pub fn to_summary(save: &pal_save::SaveData) -> SaveSummary {
    SaveSummary {
        world_name: save
            .world_name
            .clone()
            .unwrap_or_else(|| "Unknown World".into()),
        players: save
            .players
            .iter()
            .map(|p| PlayerRef {
                uid: guid_str(&p.uid),
                name: p.name.clone(),
            })
            .collect(),
        bases: save
            .bases
            .iter()
            .map(|b| BaseRef {
                container_id: guid_str(&b.container_id),
                guild_id: guid_str(&b.guild_id),
                guild_name: b.guild_name.clone(),
                member_uids: b.member_uids.iter().map(guid_str).collect(),
            })
            .collect(),
        pals: save.pals.clone(),
        warnings: save.warnings.clone(),
    }
}
