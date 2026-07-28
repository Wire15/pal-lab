//! Palworld `.sav` reader: PlZ/PlM compression wrapper -> GVAS property tree
//! -> `pal_data::OwnedPal` extraction. READ-ONLY by design; this crate never
//! writes save data.

pub mod archive;
pub mod characters;
pub mod compress;
pub mod gvas;
pub mod localdata;
pub mod map_objects;
pub mod wgs;
pub mod worldoption;

pub use localdata::{
    read_local_data, parse_player_map_state, CustomMarker, FogLayer, LocalData, PlayerMapRecord,
};
pub use map_objects::{read_base_points, read_map_objects, BasePoint, MapObjectInstance};
pub use wgs::{
    extract_world, list_worlds, manifest, ExtractedWorld, WgsFileRef, WgsManifest, WgsRead,
    WgsWorld, WgsWorldManifest,
};
pub use worldoption::{parse_world_options_sav, WorldOptions};

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

    let level_sav = std::fs::read(dir.join("Level.sav"))?;

    // Split the `Players/` directory into regular per-player saves (party /
    // palbox) and `*_dps.sav` dimensional-storage files, reading each as raw
    // (still-compressed) bytes; `read_save_from_parts` decompresses + parses.
    let mut player_saves: Vec<(String, Vec<u8>)> = Vec::new();
    let mut dps_saves: Vec<(String, Vec<u8>)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir.join("Players")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("sav") {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            let label = path.display().to_string();
            if path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|n| n.ends_with("_dps.sav"))
            {
                dps_saves.push((label, bytes));
            } else {
                player_saves.push((label, bytes));
            }
        }
    }

    let level_meta_sav = std::fs::read(dir.join("LevelMeta.sav")).ok();

    read_save_from_parts(&level_sav, level_meta_sav.as_deref(), &player_saves, &dps_saves)
}

/// Build a [`SaveData`] from in-memory raw (still PlZ/PlM-compressed) `.sav`
/// bytes instead of a directory — the byte-oriented core of [`read_save_dir`],
/// for non-filesystem callers (e.g. the wasm/browser build). `level_sav` is the
/// required `Level.sav`; `level_meta_sav` the optional `LevelMeta.sav` (world
/// name); `player_saves` the regular per-player saves (party/palbox) and
/// `dps_saves` the `*_dps.sav` dimensional-storage files. Each `(label, bytes)`
/// label appears only in warning messages. [`read_save_dir`] reads the directory
/// then delegates here so both share one parsing path.
pub fn read_save_from_parts(
    level_sav: &[u8],
    level_meta_sav: Option<&[u8]>,
    player_saves: &[(String, Vec<u8>)],
    dps_saves: &[(String, Vec<u8>)],
) -> Result<SaveData, SaveError> {
    let mut warnings = Vec::new();

    let level_blob = compress::decompress_sav(level_sav)?;
    let mut parsed = characters::parse_level(&level_blob, &mut warnings)?;

    // Player saves tell us which container guids are the party / palbox;
    // `*_dps.sav` files hold each player's dimensional pal storage. Viewing-cage
    // and global-storage container ids come from `Level.sav` map objects
    // (`parsed.cage_containers` / `parsed.global_containers`).
    let mut party: HashSet<Guid> = HashSet::new();
    let mut palbox: HashSet<Guid> = HashSet::new();
    for (label, bytes) in player_saves {
        match compress::decompress_sav(bytes).and_then(|b| characters::parse_player_save(&b)) {
            Ok(pc) => {
                party.extend(pc.party);
                palbox.extend(pc.palbox);
            }
            Err(e) => warnings.push(format!("player save {label}: {e}")),
        }
    }

    for pal in &mut parsed.pals {
        if let Some(c) = pal.container_id {
            pal.container_kind = classify_container(
                &c,
                &party,
                &palbox,
                &parsed.base_containers,
                &parsed.cage_containers,
                &parsed.global_containers,
            );
        }
    }

    // Merge dimensional-storage pals (self-contained in the dps files), tagged
    // `DimensionalPalStorage`, deduped by instance id against the level roster.
    let mut seen: HashSet<Guid> = parsed.pals.iter().map(|p| p.instance_id).collect();
    for (label, bytes) in dps_saves {
        match compress::decompress_sav(bytes)
            .and_then(|b| characters::parse_dimensional_storage(&b, &mut warnings))
        {
            Ok(dps_pals) => {
                for pal in dps_pals {
                    if seen.insert(pal.instance_id) {
                        parsed.pals.push(pal);
                    }
                }
            }
            Err(e) => warnings.push(format!("dimensional storage {label}: {e}")),
        }
    }

    let world_name = match level_meta_sav {
        Some(bytes) => match compress::decompress_sav(bytes) {
            Ok(blob) => characters::parse_world_name(&blob).unwrap_or(None),
            Err(_) => None,
        },
        None => None,
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
    let blob = read_and_decompress(path.as_ref())?;
    read_level_sav_from_blob(&blob)
}

/// Parse an already-decompressed `Level.sav` blob (same result as
/// [`read_level_sav`]). Lets callers that also need other `worldSaveData`
/// sections (e.g. `map_objects`) decompress the level once and reuse the blob.
pub fn read_level_sav_from_blob(blob: &[u8]) -> Result<SaveData, SaveError> {
    let mut warnings = Vec::new();
    let parsed = characters::parse_level(blob, &mut warnings)?;
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
    let raw = std::fs::read(&path)?;
    worldoption::parse_world_options_sav(&raw)
}

/// Classify a pal's physical container. Precedence follows provenance
/// strength: the player's own party/palbox ids, then base-camp worker
/// containers, then viewing-cage containers (world `DisplayCharacter`
/// objects), then the world-shared global pal storage. Anything else is
/// honestly `Unknown`.
fn classify_container(
    c: &Guid,
    party: &HashSet<Guid>,
    palbox: &HashSet<Guid>,
    bases: &HashSet<Guid>,
    cages: &HashSet<Guid>,
    global: &HashSet<Guid>,
) -> ContainerKind {
    if party.contains(c) {
        ContainerKind::Party
    } else if palbox.contains(c) {
        ContainerKind::Palbox
    } else if bases.contains(c) {
        ContainerKind::Base
    } else if cages.contains(c) {
        ContainerKind::ViewingCage
    } else if global.contains(c) {
        ContainerKind::GlobalPalStorage
    } else {
        ContainerKind::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real-save invariant: the co-op fixture classifies every pal — zero
    /// `Unknown` kinds — with the exact per-kind counts the ground-truth probe
    /// established. Also exercises the `MapObjectSaveData` storage-machine
    /// pass over a real `Level.sav` (this world has no cages / global storage
    /// built, so the new kinds legitimately count 0).
    #[test]
    fn coop_save_container_kinds_fully_classified() {
        let dir = format!(
            "{}/../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58",
            env!("CARGO_MANIFEST_DIR")
        );
        let save = read_save_dir(&dir).expect("read save");
        let mut counts: std::collections::HashMap<&'static str, usize> =
            std::collections::HashMap::new();
        for p in &save.pals {
            let k = match p.container_kind {
                ContainerKind::Party => "party",
                ContainerKind::Palbox => "palbox",
                ContainerKind::Base => "base",
                ContainerKind::DimensionalPalStorage => "dps",
                ContainerKind::ViewingCage => "cage",
                ContainerKind::GlobalPalStorage => "global",
                ContainerKind::Unknown => "unknown",
            };
            *counts.entry(k).or_default() += 1;
        }
        assert_eq!(save.pals.len(), 1669);
        assert_eq!(counts.get("unknown"), None, "no pal may be Unknown");
        assert_eq!(counts.get("party"), Some(&20));
        assert_eq!(counts.get("palbox"), Some(&1537));
        assert_eq!(counts.get("base"), Some(&76));
        assert_eq!(counts.get("dps"), Some(&36));
        assert_eq!(counts.get("cage"), None);
        assert_eq!(counts.get("global"), None);
    }

    #[test]
    fn classify_container_covers_cage_and_global() {
        let mk = |b: u8| -> Guid { [b; 16] };
        let party: HashSet<Guid> = [mk(1)].into();
        let palbox: HashSet<Guid> = [mk(2)].into();
        let bases: HashSet<Guid> = [mk(3)].into();
        let cages: HashSet<Guid> = [mk(4)].into();
        let global: HashSet<Guid> = [mk(5)].into();
        let f = |g: &Guid| classify_container(g, &party, &palbox, &bases, &cages, &global);
        assert!(matches!(f(&mk(1)), ContainerKind::Party));
        assert!(matches!(f(&mk(2)), ContainerKind::Palbox));
        assert!(matches!(f(&mk(3)), ContainerKind::Base));
        assert!(matches!(f(&mk(4)), ContainerKind::ViewingCage));
        assert!(matches!(f(&mk(5)), ContainerKind::GlobalPalStorage));
        assert!(matches!(f(&mk(9)), ContainerKind::Unknown));
    }
}
