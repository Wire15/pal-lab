//! Shared domain vocabulary. Kept dependency-light: every crate in the
//! workspace speaks these types.

use serde::{Deserialize, Serialize};

/// 16-byte GUID as stored in save files. Formatting/display is a UI concern.
pub type Guid = [u8; 16];

/// Internal species id (`CharacterID` in saves, e.g. `"Anubis"`), with any
/// `BOSS_`/`PREDATOR_`/`GYM_` prefix stripped — prefix flags live on the
/// owning struct instead.
pub type PalId = String;

/// Internal passive-skill id (e.g. `"ElementBoost_Earth_2_PAL"`).
pub type PassiveId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Gender {
    Male,
    Female,
}

/// IV ("talent" internally) block, 0–100 per stat.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IvSet {
    pub hp: u8,
    pub attack: u8,
    pub defense: u8,
}

/// Where an owned pal physically lives. Server/world saves distinguish these
/// via container ownership; palcalc's #1 gap was missing the last two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContainerKind {
    Party,
    Palbox,
    Base,
    ViewingCage,
    GlobalPalStorage,
    DimensionalPalStorage,
    Unknown,
}

/// A pal instance owned by somebody in the save. Produced by `pal-save`,
/// consumed by the solver and UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnedPal {
    pub instance_id: Guid,
    pub character_id: PalId,
    /// Alpha/boss variant (`BOSS_` prefix in the raw `CharacterID`).
    pub is_boss: bool,
    pub gender: Option<Gender>,
    pub level: u32,
    /// Condensation rank (0 = base).
    pub rank: u32,
    pub passives: Vec<PassiveId>,
    pub ivs: IvSet,
    pub nickname: Option<String>,
    pub owner_player_uid: Option<Guid>,
    pub container_id: Option<Guid>,
    pub slot_index: Option<u32>,
    pub container_kind: ContainerKind,
}
