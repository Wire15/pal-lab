//! Palworld `.sav` reader: PlZ/PlM compression wrapper -> GVAS property tree
//! -> `pal_data::OwnedPal` extraction. READ-ONLY by design; this crate never
//! writes save data.

pub mod archive;
pub mod characters;
pub mod compress;
pub mod gvas;
pub mod localdata;
pub mod worldoption;

pub use localdata::{
    read_local_data, parse_player_map_state, CustomMarker, FogLayer, LocalData, PlayerMapRecord,
};
pub use worldoption::WorldOptions;

use std::collections::HashSet;
use std::path::Path;

use pal_data::types::{ContainerKind, Guid, OwnedPal};
use thiserror::Error;

/// Errors surfaced by the save reader. Per-entity failures do NOT produce these;
/// they are collected as warnings on [`SaveData`] instead (fail-soft parsing).
#[derive(Debug, Error)]
pub enum SaveError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("compression: {0}")]
    Compression(String),
    #[error("not supported yet: {0}")]
    NotSupportedYet(String),
    #[error("gvas: {0}")]
    Gvas(String),
    #[error("save layout: {0}")]
    Layout(String),
}

/// A player identity in the save.
#[derive(Debug, Clone)]
pub struct PlayerInfo {
    pub uid: Guid,
    pub name: String,
}

/// Base-camp ownership: one guild-owned base, mapped to its physical worker
/// pal-container and the guild's member players. Emitted per base container so
/// the UI can scope base strips to the guild members of a selected player.
#[derive(Debug, Clone)]
pub struct BaseOwnership {
    /// Worker pal-container guid (matches an [`OwnedPal::container_id`] whose
    /// `container_kind` is [`ContainerKind::Base`]).
    pub container_id: Guid,
    /// Owning guild id (`GroupSaveDataMap` group id).
    pub guild_id: Guid,
    /// Display guild name (e.g. `"Unnamed Guild"`).
    pub guild_name: String,
    /// Player uids of the guild's members present in this save.
    pub member_uids: Vec<Guid>,
}

/// Everything the reader recovers from a save directory (or a single level
/// file). Malformed entities are skipped and reported in `warnings`.
#[derive(Debug, Default)]
pub struct SaveData {
    pub world_name: Option<String>,
    pub players: Vec<PlayerInfo>,
    pub pals: Vec<OwnedPal>,
    /// Guild-owned base camps mapped to their worker containers + members.
    pub bases: Vec<BaseOwnership>,
    pub warnings: Vec<String>,
}

/// Read a full save directory (the folder containing `Level.sav`, `LevelMeta.sav`
/// and a `Players/` subdirectory). Cross-references player saves to classify
/// which container each pal lives in.
pub fn read_save_dir(dir: impl AsRef<Path>) -> Result<SaveData, SaveError> {
    let dir = dir.as_ref();
    let mut warnings = Vec::new();

    let level_blob = read_and_decompress(&dir.join("Level.sav"))?;
    let mut parsed = characters::parse_level(&level_blob, &mut warnings)?;

    // Player saves tell us which container guids are the party / palbox;
    // `*_dps.sav` files hold each player's dimensional pal storage.
    let mut party: HashSet<Guid> = HashSet::new();
    let mut palbox: HashSet<Guid> = HashSet::new();
    let mut dps_paths: Vec<std::path::PathBuf> = Vec::new();
    let players_dir = dir.join("Players");
    if let Ok(entries) = std::fs::read_dir(&players_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("sav") {
                continue;
            }
            if path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|n| n.ends_with("_dps.sav"))
            {
                dps_paths.push(path);
                continue;
            }
            match read_and_decompress(&path).and_then(|b| characters::parse_player_save(&b)) {
                Ok(pc) => {
                    party.extend(pc.party);
                    palbox.extend(pc.palbox);
                }
                Err(e) => warnings.push(format!("player save {}: {e}", path.display())),
            }
        }
    }

    for pal in &mut parsed.pals {
        if let Some(c) = pal.container_id {
            pal.container_kind = if party.contains(&c) {
                ContainerKind::Party
            } else if palbox.contains(&c) {
                ContainerKind::Palbox
            } else if parsed.base_containers.contains(&c) {
                ContainerKind::Base
            } else {
                ContainerKind::Unknown
            };
        }
    }

    // Merge dimensional-storage pals (self-contained in the dps files), tagged
    // `DimensionalPalStorage`, deduped by instance id against the level roster.
    let mut seen: HashSet<Guid> = parsed.pals.iter().map(|p| p.instance_id).collect();
    for path in &dps_paths {
        match read_and_decompress(path)
            .and_then(|b| characters::parse_dimensional_storage(&b, &mut warnings))
        {
            Ok(dps_pals) => {
                for pal in dps_pals {
                    if seen.insert(pal.instance_id) {
                        parsed.pals.push(pal);
                    }
                }
            }
            Err(e) => warnings.push(format!("dimensional storage {}: {e}", path.display())),
        }
    }

    let world_name = match read_and_decompress(&dir.join("LevelMeta.sav")) {
        Ok(blob) => characters::parse_world_name(&blob).unwrap_or(None),
        Err(_) => None,
    };

    let bases = build_bases(
        &parsed.guilds,
        &parsed.base_id_to_container,
        &parsed.players,
    );

    Ok(SaveData {
        world_name,
        players: to_player_infos(&parsed.players),
        pals: parsed.pals,
        bases,
        warnings,
    })
}

/// Read a single `Level.sav` file. Containers are left `Unknown` (no player
/// saves are consulted); use [`read_save_dir`] for full classification.
pub fn read_level_sav(path: impl AsRef<Path>) -> Result<SaveData, SaveError> {
    let mut warnings = Vec::new();
    let blob = read_and_decompress(path.as_ref())?;
    let parsed = characters::parse_level(&blob, &mut warnings)?;
    let bases = build_bases(
        &parsed.guilds,
        &parsed.base_id_to_container,
        &parsed.players,
    );
    Ok(SaveData {
        world_name: None,
        players: to_player_infos(&parsed.players),
        pals: parsed.pals,
        bases,
        warnings,
    })
}

/// Join parsed guilds with the base_id -> container map, keeping only guild
/// members that are known players in this save. One [`BaseOwnership`] per base
/// container that resolves; bases with no worker container are skipped.
fn build_bases(
    guilds: &[characters::GuildRaw],
    base_id_to_container: &std::collections::HashMap<Guid, Guid>,
    players: &[characters::PlayerEntry],
) -> Vec<BaseOwnership> {
    let player_uids: HashSet<Guid> = players.iter().map(|p| p.uid).collect();
    let mut bases = Vec::new();
    for guild in guilds {
        let member_uids: Vec<Guid> = guild
            .member_candidates
            .iter()
            .copied()
            .filter(|u| player_uids.contains(u))
            .collect();
        for base_id in &guild.base_ids {
            if let Some(&container_id) = base_id_to_container.get(base_id) {
                bases.push(BaseOwnership {
                    container_id,
                    guild_id: guild.guild_id,
                    guild_name: guild.guild_name.clone(),
                    member_uids: member_uids.clone(),
                });
            }
        }
    }
    bases
}

fn to_player_infos(entries: &[characters::PlayerEntry]) -> Vec<PlayerInfo> {
    entries
        .iter()
        .map(|p| PlayerInfo {
            uid: p.uid,
            name: p.name.clone(),
        })
        .collect()
}

fn read_and_decompress(path: &Path) -> Result<Vec<u8>, SaveError> {
    let raw = std::fs::read(path)?;
    compress::decompress_sav(&raw)
}

/// Read `<save_dir>/WorldOption.sav` for the world's breeding-relevant option
/// values. Returns `Ok(None)` when the file is absent (dedicated servers keep
/// world settings elsewhere and ship no `WorldOption.sav`), so callers fall back
/// to vanilla defaults. `Err` only on a present-but-corrupt file.
pub fn read_world_options(
    save_dir: impl AsRef<Path>,
) -> Result<Option<WorldOptions>, SaveError> {
    let path = save_dir.as_ref().join("WorldOption.sav");
    if !path.exists() {
        return Ok(None);
    }
    let blob = read_and_decompress(&path)?;
    Ok(Some(worldoption::parse_world_options(&blob)?))
}
