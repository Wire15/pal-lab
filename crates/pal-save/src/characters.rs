//! Extraction of `pal_data::OwnedPal`s (and player identities) from a decoded
//! `Level.sav`, plus the small amount of a player save we need to classify
//! containers. Field layout follows cheahjs/palworld-save-tools
//! `rawdata/character.py`: each `CharacterSaveParameterMap` value's `RawData`
//! is `SaveParameter` properties, then 4 unknown bytes, then a group-id guid.

use std::collections::HashSet;

use pal_data::types::{ContainerKind, Gender, Guid, IvSet, OwnedPal};

use crate::archive::Reader;
use crate::gvas::{self, find, GvasHeader, Value};
use crate::SaveError;

/// A player identity discovered in the level save.
#[derive(Debug, Clone)]
pub struct PlayerEntry {
    pub uid: Guid,
    pub name: String,
}

/// Result of parsing a `Level.sav`. `base_containers` are the pal-container
/// guids owned by base camps (from `BaseCampSaveData`), used to classify base
/// worker pals.
#[derive(Debug, Default)]
pub struct LevelParse {
    pub pals: Vec<OwnedPal>,
    pub players: Vec<PlayerEntry>,
    pub base_containers: HashSet<Guid>,
}

/// Container ids extracted from a single player save, used to classify where a
/// pal physically lives.
#[derive(Debug, Default)]
pub struct PlayerContainers {
    pub player_uid: Option<Guid>,
    /// `OtomoCharacterContainerId` — the active party.
    pub party: Option<Guid>,
    /// `PalStorageContainerId` — the palbox.
    pub palbox: Option<Guid>,
}

enum Entry {
    Pal(Box<OwnedPal>),
    Player(PlayerEntry),
    /// A parsed-but-empty entry (e.g. a player with no nickname yet); ignored.
    None,
}

/// Parse `Level.sav`, extracting pals and player identities. Structural parsing
/// of the map is strict; per-entity *interpretation* failures are collected as
/// warnings and skipped (fail-soft).
pub fn parse_level(blob: &[u8], warnings: &mut Vec<String>) -> Result<LevelParse, SaveError> {
    let mut r = Reader::new(blob);
    GvasHeader::read(&mut r)?;

    // Top level holds a single `worldSaveData` StructProperty.
    while let Some((name, type_name, size)) = gvas::read_tag(&mut r)? {
        if name == "worldSaveData" && type_name == "StructProperty" {
            r.fstring()?; // struct_type
            r.skip(16)?; // struct_id
            r.optional_guid()?;
            return parse_world_save_data(&mut r, warnings);
        }
        gvas::skip_property(&mut r, &type_name, size)?;
    }
    Err(SaveError::Gvas("worldSaveData not found in level save".into()))
}

fn parse_world_save_data(r: &mut Reader, warnings: &mut Vec<String>) -> Result<LevelParse, SaveError> {
    let mut out = LevelParse::default();
    while let Some((name, type_name, size)) = gvas::read_tag(r)? {
        if name == "CharacterSaveParameterMap" && type_name == "MapProperty" {
            parse_character_map(r, &mut out, warnings)?;
        } else if name == "BaseCampSaveData" && type_name == "MapProperty" {
            // Base-camp worker containers. Parsed in an isolated sub-reader
            // bounded by `size`, so any malformed base data warns and skips
            // without desyncing the outer cursor (fail-soft).
            match base_camp_containers(r, size) {
                Ok(ids) => out.base_containers.extend(ids),
                Err(e) => warnings.push(format!("BaseCampSaveData: {e}")),
            }
        } else {
            gvas::skip_property(r, &type_name, size)?;
        }
    }
    Ok(out)
}

fn parse_character_map(
    r: &mut Reader,
    out: &mut LevelParse,
    warnings: &mut Vec<String>,
) -> Result<(), SaveError> {
    let _key_type = r.fstring()?; // StructProperty
    let _value_type = r.fstring()?; // StructProperty
    r.optional_guid()?;
    r.u32()?; // padding (always 0)
    let count = r.u32()?;

    for i in 0..count {
        // Map key/value are bare struct bodies (properties-until-end); the
        // struct type comes from the map, not an inline tag.
        let key = gvas::read_properties_until_end(r)?;
        let value = gvas::read_properties_until_end(r)?;
        match extract_entry(&key, &value) {
            Ok(Entry::Pal(p)) => out.pals.push(*p),
            Ok(Entry::Player(pl)) => out.players.push(pl),
            Ok(Entry::None) => {}
            Err(e) => warnings.push(format!("character entry #{i}: {e}")),
        }
    }
    Ok(())
}

fn key_guid(key: &[(String, Value)], name: &str) -> Option<Guid> {
    find(key, name).and_then(Value::as_guid)
}

/// Decode a single `CharacterSaveParameterMap` entry. The value's `RawData`
/// bytes are decoded in an isolated reader, so a malformed entity cannot
/// desync the outer map cursor.
fn extract_entry(key: &[(String, Value)], value: &[(String, Value)]) -> Result<Entry, SaveError> {
    let raw = find(value, "RawData")
        .and_then(Value::as_bytes)
        .ok_or_else(|| SaveError::Gvas("entry missing RawData".into()))?;

    let mut cr = Reader::new(raw);
    let object = gvas::read_properties_until_end(&mut cr)?;
    let param = find(&object, "SaveParameter")
        .and_then(Value::as_props)
        .ok_or_else(|| SaveError::Gvas("RawData missing SaveParameter".into()))?;

    let instance_id = key_guid(key, "InstanceId").unwrap_or_default();

    // Player character entries carry the player's identity + nickname.
    if find(param, "IsPlayer")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let uid = key_guid(key, "PlayerUId")
            .or_else(|| find(param, "OwnerPlayerUId").and_then(Value::as_guid))
            .unwrap_or_default();
        let name = find(param, "NickName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if name.is_empty() && uid == Guid::default() {
            return Ok(Entry::None);
        }
        return Ok(Entry::Player(PlayerEntry { uid, name }));
    }

    Ok(Entry::Pal(Box::new(build_pal(param, instance_id)?)))
}

/// Build an [`OwnedPal`] from a decoded `SaveParameter` property set. Shared by
/// the `Level.sav` character map and the dimensional-storage array. The
/// resulting `container_kind` is always [`ContainerKind::Unknown`]; callers
/// classify it afterward.
fn build_pal(param: &[(String, Value)], instance_id: Guid) -> Result<OwnedPal, SaveError> {
    let raw_char_id = find(param, "CharacterID")
        .and_then(Value::as_str)
        .ok_or_else(|| SaveError::Gvas("pal missing CharacterID".into()))?;
    let (character_id, is_boss) = strip_species_prefix(raw_char_id);

    let gender = find(param, "Gender")
        .and_then(Value::as_str)
        .map(parse_gender);

    // Palworld omits default-valued properties; a missing Level means 1.
    let level = find(param, "Level")
        .and_then(Value::as_i32)
        .unwrap_or(1)
        .max(0) as u32;
    let rank = find(param, "Rank")
        .and_then(Value::as_i32)
        .unwrap_or(0)
        .max(0) as u32;

    let ivs = IvSet {
        hp: talent(param, "Talent_HP"),
        // Talent_Shot is the attack IV; tolerate the older Talent_Melee name.
        attack: find(param, "Talent_Shot")
            .or_else(|| find(param, "Talent_Melee"))
            .and_then(Value::as_i32)
            .map(clamp_iv)
            .unwrap_or(0),
        defense: talent(param, "Talent_Defense"),
    };

    let passives = find(param, "PassiveSkillList")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    // Equipped active skills. cheahjs rawdata/character.py exposes `EquipWaza`
    // (equipped) and `MasteredWaza` (learned); we surface only the equipped
    // set. Values are `EPalWazaID::*` enum labels; strip the prefix for display.
    let active_skills = find(param, "EquipWaza")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty() && *s != "None")
                .map(strip_waza_prefix)
                .collect()
        })
        .unwrap_or_default();

    let nickname = find(param, "NickName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let owner_player_uid = find(param, "OwnerPlayerUId").and_then(Value::as_guid);
    let (container_id, slot_index) = slot_id(param);

    Ok(OwnedPal {
        instance_id,
        character_id,
        is_boss,
        gender,
        level,
        rank,
        passives,
        active_skills,
        ivs,
        nickname,
        owner_player_uid,
        container_id,
        slot_index,
        container_kind: ContainerKind::Unknown,
    })
}

/// Byte offset of `container_id` inside a `WorkerDirector` `RawData` blob:
/// `id` (Guid, 16) + `spawn_transform` (FTransform = FQuat 32 + 2x FVector 24,
/// = 80) + `current_order_type` (1) + `current_battle_type` (1). Layout per
/// cheahjs/palworld-save-tools `rawdata/worker_director.py`.
const WORKER_DIRECTOR_CONTAINER_OFFSET: usize = 16 + 80 + 1 + 1;

/// Parse the `BaseCampSaveData` map (Guid key + struct value) from an isolated
/// sub-reader bounded by `size`, returning each base's worker pal-container
/// guid. The outer reader is always advanced past the whole map region, so a
/// malformed base cannot desync the caller (fail-soft).
fn base_camp_containers(r: &mut Reader, size: usize) -> Result<HashSet<Guid>, SaveError> {
    let _key_type = r.fstring()?; // StructProperty
    let _value_type = r.fstring()?; // StructProperty
    r.optional_guid()?;
    // Consume the whole value region up front, then decode from a copy: any
    // decode failure below leaves the outer cursor correctly positioned.
    let body = r.bytes(size)?.to_vec();

    let mut sub = Reader::new(&body);
    sub.u32()?; // padding (always 0)
    let count = sub.u32()?;

    let mut containers = HashSet::new();
    for _ in 0..count {
        let _base_id = sub.guid()?; // map key is a bare Guid
        let value = gvas::read_properties_until_end(&mut sub)?;
        if let Some(cid) = base_worker_container(&value) {
            containers.insert(cid);
        }
    }
    Ok(containers)
}

/// Extract the worker pal-container guid from a single base's value struct.
/// Returns `None` for a base with no populated worker container (all-zero id).
fn base_worker_container(value: &[(String, Value)]) -> Option<Guid> {
    let raw = find(value, "WorkerDirector")
        .and_then(Value::as_props)
        .and_then(|p| find(p, "RawData"))
        .and_then(Value::as_bytes)?;
    let end = WORKER_DIRECTOR_CONTAINER_OFFSET + 16;
    let cid: Guid = raw.get(WORKER_DIRECTOR_CONTAINER_OFFSET..end)?.try_into().ok()?;
    (cid != Guid::default()).then_some(cid)
}

fn talent(param: &[(String, Value)], name: &str) -> u8 {
    find(param, name)
        .and_then(Value::as_i32)
        .map(clamp_iv)
        .unwrap_or(0)
}

fn clamp_iv(v: i32) -> u8 {
    v.clamp(0, 100) as u8
}

/// Strip a `BOSS_`/`PREDATOR_`/`GYM_` prefix. Only `BOSS_` marks an alpha/boss.
fn strip_species_prefix(id: &str) -> (String, bool) {
    if let Some(rest) = id.strip_prefix("BOSS_") {
        return (rest.to_string(), true);
    }
    for prefix in ["PREDATOR_", "GYM_"] {
        if let Some(rest) = id.strip_prefix(prefix) {
            return (rest.to_string(), false);
        }
    }
    (id.to_string(), false)
}

/// Strip the `EPalWazaID::` enum prefix from an equipped-waza id, leaving the
/// internal skill name (e.g. `EPalWazaID::FireBall` -> `FireBall`). A proper
/// skill-name DB is out of scope; the cleaned id is shown as a chip.
fn strip_waza_prefix(id: &str) -> String {
    id.strip_prefix("EPalWazaID::").unwrap_or(id).to_string()
}

fn parse_gender(s: &str) -> Gender {
    if s.contains("Female") {
        Gender::Female
    } else {
        Gender::Male
    }
}

/// `SlotId` -> (container guid, slot index). The struct nests
/// `ContainerId { ID: Guid }` and a `SlotIndex` int.
fn slot_id(param: &[(String, Value)]) -> (Option<Guid>, Option<u32>) {
    let Some(slot) = find(param, "SlotId").and_then(Value::as_props) else {
        return (None, None);
    };
    let container_id = find(slot, "ContainerId")
        .and_then(Value::as_props)
        .and_then(|p| find(p, "ID"))
        .and_then(Value::as_guid);
    let slot_index = find(slot, "SlotIndex")
        .and_then(Value::as_i32)
        .map(|v| v.max(0) as u32);
    (container_id, slot_index)
}

/// Parse the small slice of a player save we need: its uid + party/palbox
/// container ids.
pub fn parse_player_save(blob: &[u8]) -> Result<PlayerContainers, SaveError> {
    let mut r = Reader::new(blob);
    GvasHeader::read(&mut r)?;
    while let Some((name, type_name, size)) = gvas::read_tag(&mut r)? {
        if name == "SaveData" && type_name == "StructProperty" {
            r.fstring()?;
            r.skip(16)?;
            r.optional_guid()?;
            return parse_player_body(&mut r);
        }
        gvas::skip_property(&mut r, &type_name, size)?;
    }
    Ok(PlayerContainers::default())
}

fn parse_player_body(r: &mut Reader) -> Result<PlayerContainers, SaveError> {
    let mut pc = PlayerContainers::default();
    while let Some((name, type_name, size)) = gvas::read_tag(r)? {
        match name.as_str() {
            "PlayerUId" | "OtomoCharacterContainerId" | "PalStorageContainerId" => {
                let v = gvas::read_property(r, &type_name, size)?;
                match name.as_str() {
                    "PlayerUId" => pc.player_uid = v.as_guid(),
                    "OtomoCharacterContainerId" => pc.party = container_ref(&v),
                    "PalStorageContainerId" => pc.palbox = container_ref(&v),
                    _ => {}
                }
            }
            _ => gvas::skip_property(r, &type_name, size)?,
        }
    }
    Ok(pc)
}

/// A `PalContainerId` struct wraps the container guid in an `ID` field.
fn container_ref(v: &Value) -> Option<Guid> {
    v.as_props()
        .and_then(|p| find(p, "ID"))
        .and_then(Value::as_guid)
        .or_else(|| v.as_guid())
}

/// Best-effort world name from `LevelMeta.sav`. Returns `Ok(None)` when no
/// `WorldName` string is present; parse errors bubble up to the caller, which
/// downgrades them to "no name".
pub fn parse_world_name(blob: &[u8]) -> Result<Option<String>, SaveError> {
    let mut r = Reader::new(blob);
    GvasHeader::read(&mut r)?;
    while let Some((name, type_name, size)) = gvas::read_tag(&mut r)? {
        if type_name == "StrProperty" && name == "WorldName" {
            return Ok(gvas::read_property(&mut r, &type_name, size)?
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string));
        }
        if name == "SaveData" && type_name == "StructProperty" {
            r.fstring()?;
            r.skip(16)?;
            r.optional_guid()?;
            while let Some((n2, t2, s2)) = gvas::read_tag(&mut r)? {
                if t2 == "StrProperty" && n2 == "WorldName" {
                    return Ok(gvas::read_property(&mut r, &t2, s2)?
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_string));
                }
                gvas::skip_property(&mut r, &t2, s2)?;
            }
            return Ok(None);
        }
        gvas::skip_property(&mut r, &type_name, size)?;
    }
    Ok(None)
}

/// Parse a dimensional pal-storage save (`*_dps.sav`). Its `GVAS` body is a
/// single `SaveParameterArray`, each element a `{ SaveParameter, InstanceId }`
/// struct — the same `SaveParameter` schema as `Level.sav`, but self-contained
/// (these pals do NOT appear in `Level.sav`). Empty slots (no `CharacterID`)
/// are skipped; per-pal decode failures are collected as warnings (fail-soft).
pub fn parse_dimensional_storage(
    blob: &[u8],
    warnings: &mut Vec<String>,
) -> Result<Vec<OwnedPal>, SaveError> {
    let mut r = Reader::new(blob);
    GvasHeader::read(&mut r)?;

    let mut pals = Vec::new();
    while let Some((name, type_name, size)) = gvas::read_tag(&mut r)? {
        if name == "SaveParameterArray" && type_name == "ArrayProperty" {
            let array = gvas::read_property(&mut r, &type_name, size)?;
            let elems = array
                .as_array()
                .ok_or_else(|| SaveError::Gvas("SaveParameterArray not an array".into()))?;
            for (i, elem) in elems.iter().enumerate() {
                match dimensional_pal(elem) {
                    Ok(Some(pal)) => pals.push(pal),
                    Ok(None) => {} // empty slot
                    Err(e) => warnings.push(format!("dimensional pal #{i}: {e}")),
                }
            }
            return Ok(pals);
        }
        gvas::skip_property(&mut r, &type_name, size)?;
    }
    Ok(pals)
}

/// Decode one dimensional-storage element into an [`OwnedPal`] tagged
/// [`ContainerKind::DimensionalPalStorage`]. Returns `Ok(None)` for an empty
/// slot (missing or `None` `CharacterID`).
fn dimensional_pal(elem: &Value) -> Result<Option<OwnedPal>, SaveError> {
    let props = elem
        .as_props()
        .ok_or_else(|| SaveError::Gvas("element not a struct".into()))?;
    let param = find(props, "SaveParameter")
        .and_then(Value::as_props)
        .ok_or_else(|| SaveError::Gvas("element missing SaveParameter".into()))?;

    match find(param, "CharacterID").and_then(Value::as_str) {
        None | Some("") | Some("None") => return Ok(None),
        Some(_) => {}
    }

    let instance_id = find(props, "InstanceId")
        .and_then(Value::as_props)
        .and_then(|p| find(p, "InstanceId"))
        .and_then(Value::as_guid)
        .unwrap_or_default();

    let mut pal = build_pal(param, instance_id)?;
    pal.container_kind = ContainerKind::DimensionalPalStorage;
    Ok(Some(pal))
}
