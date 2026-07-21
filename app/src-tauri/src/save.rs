//! Frontend-facing save summary + the `load_save` command.
//!
//! Right now `load_save` returns hand-written mock data so the UI can be built
//! and exercised end to end. The shape is exactly the integration contract:
//! `SaveSummary.pals` is `Vec<pal_data::OwnedPal>` serialized with its default
//! serde derive, so wiring in the real reader is a single-function swap.

use pal_data::types::{ContainerKind, Gender, Guid, IvSet, OwnedPal};
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
}

/// Build a 16-byte GUID from a compact seed so the mock stays readable.
fn guid(hi: u8, lo: u8) -> Guid {
    let mut g = [0u8; 16];
    g[0] = hi;
    g[15] = lo;
    g
}

/// Format a GUID the way the UI expects a player uid string.
fn guid_str(g: &Guid) -> String {
    g.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

/// Load a save from `save_dir` and summarize it for the UI.
///
/// TODO(integration): replace the mock body with
/// `pal_save::read_level_sav(Path::new(&save_dir))`, mapping its `SaveData`
/// into `SaveSummary` (the `pals` field is already `Vec<OwnedPal>`). No caller
/// or frontend change required.
#[tauri::command]
pub fn load_save(save_dir: String) -> Result<SaveSummary, String> {
    if save_dir.trim().is_empty() {
        return Err("No save folder selected.".into());
    }

    let alice = guid(0x01, 0xA1);
    let bob = guid(0x02, 0xB2);

    let pals = vec![
        OwnedPal {
            instance_id: guid(0x10, 0x01),
            character_id: "Anubis".into(),
            is_boss: false,
            gender: Some(Gender::Male),
            level: 34,
            rank: 2,
            passives: vec!["Legend".into(), "PAL_ALLAttack_up2".into()],
            ivs: IvSet { hp: 82, attack: 91, defense: 40 },
            nickname: Some("Digs".into()),
            owner_player_uid: Some(alice),
            container_id: Some(guid(0x20, 0x01)),
            slot_index: Some(0),
            container_kind: ContainerKind::Party,
        },
        OwnedPal {
            instance_id: guid(0x10, 0x02),
            character_id: "Anubis".into(),
            is_boss: false,
            gender: Some(Gender::Female),
            level: 28,
            rank: 0,
            passives: vec!["Rare".into()],
            ivs: IvSet { hp: 55, attack: 60, defense: 88 },
            nickname: None,
            owner_player_uid: Some(alice),
            container_id: Some(guid(0x20, 0x02)),
            slot_index: Some(3),
            container_kind: ContainerKind::Palbox,
        },
        OwnedPal {
            instance_id: guid(0x10, 0x03),
            character_id: "Jetragon".into(),
            is_boss: true,
            gender: Some(Gender::Male),
            level: 50,
            rank: 4,
            passives: vec![
                "Legend".into(),
                "PAL_ALLAttack_up2".into(),
                "MoveSpeed_up_2".into(),
                "Deadeye".into(),
            ],
            ivs: IvSet { hp: 100, attack: 100, defense: 95 },
            nickname: Some("Alpha".into()),
            owner_player_uid: Some(bob),
            container_id: Some(guid(0x20, 0x03)),
            slot_index: Some(1),
            container_kind: ContainerKind::Base,
        },
        OwnedPal {
            instance_id: guid(0x10, 0x04),
            character_id: "Grintale".into(),
            is_boss: false,
            gender: Some(Gender::Female),
            level: 12,
            rank: 1,
            passives: vec![],
            ivs: IvSet { hp: 30, attack: 22, defense: 18 },
            nickname: None,
            owner_player_uid: Some(bob),
            container_id: Some(guid(0x20, 0x04)),
            slot_index: Some(7),
            container_kind: ContainerKind::ViewingCage,
        },
        OwnedPal {
            instance_id: guid(0x10, 0x05),
            character_id: "Lamball".into(),
            is_boss: false,
            gender: None,
            level: 5,
            rank: 0,
            passives: vec!["Coward".into()],
            ivs: IvSet { hp: 10, attack: 8, defense: 12 },
            nickname: Some("Fluff".into()),
            owner_player_uid: None,
            container_id: Some(guid(0x20, 0x05)),
            slot_index: None,
            container_kind: ContainerKind::GlobalPalStorage,
        },
        OwnedPal {
            instance_id: guid(0x10, 0x06),
            character_id: "Depresso".into(),
            is_boss: false,
            gender: Some(Gender::Male),
            level: 19,
            rank: 3,
            passives: vec!["Lucky".into(), "Runner".into()],
            ivs: IvSet { hp: 44, attack: 51, defense: 33 },
            nickname: None,
            owner_player_uid: Some(alice),
            container_id: Some(guid(0x20, 0x06)),
            slot_index: Some(2),
            container_kind: ContainerKind::DimensionalPalStorage,
        },
        OwnedPal {
            instance_id: guid(0x10, 0x07),
            character_id: "Cattiva".into(),
            is_boss: false,
            gender: Some(Gender::Female),
            level: 41,
            rank: 2,
            passives: vec!["Workaholic".into(), "Serious".into(), "Diet_Lover".into()],
            ivs: IvSet { hp: 70, attack: 45, defense: 62 },
            nickname: Some("Kit".into()),
            owner_player_uid: Some(alice),
            container_id: None,
            slot_index: None,
            container_kind: ContainerKind::Unknown,
        },
        OwnedPal {
            instance_id: guid(0x10, 0x08),
            character_id: "Frostallion".into(),
            is_boss: false,
            gender: Some(Gender::Male),
            level: 47,
            rank: 4,
            passives: vec!["Legend".into(), "Ice_Emperor".into(), "Musclehead".into()],
            ivs: IvSet { hp: 96, attack: 88, defense: 90 },
            nickname: None,
            owner_player_uid: Some(bob),
            container_id: Some(guid(0x20, 0x08)),
            slot_index: Some(5),
            container_kind: ContainerKind::Palbox,
        },
    ];

    Ok(SaveSummary {
        world_name: "Mock World (Sakurajima)".into(),
        players: vec![
            PlayerRef { uid: guid_str(&alice), name: "Alice".into() },
            PlayerRef { uid: guid_str(&bob), name: "Bob".into() },
        ],
        pals,
    })
}
