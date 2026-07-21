//! End-to-end extraction against the bundled test save: the reader must
//! recover the four players and a large, plausibly-populated pal roster.

use std::path::PathBuf;

use pal_data::types::ContainerKind;

fn save_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58")
}

#[test]
fn reads_players_and_pals() {
    let save = pal_save::read_save_dir(save_dir()).expect("read save dir");

    // Four named players.
    assert_eq!(save.players.len(), 4, "expected 4 players");
    assert!(
        save.players.iter().all(|p| !p.name.is_empty()),
        "every player should have a nickname"
    );

    // A well-populated roster with real species ids.
    assert!(save.pals.len() > 1000, "only {} pals", save.pals.len());
    assert!(
        save.pals.iter().all(|p| !p.character_id.is_empty()),
        "every pal must have a species id"
    );

    // Species ids should not carry the raw prefixes (they are stripped).
    assert!(
        save.pals
            .iter()
            .all(|p| !p.character_id.starts_with("BOSS_")),
        "BOSS_ prefix should be stripped into is_boss"
    );

    // Containers must be classified across every storage type present in the
    // bundled save: party, palbox, base camps, and dimensional storage.
    let party = count(&save, ContainerKind::Party);
    let palbox = count(&save, ContainerKind::Palbox);
    let base = count(&save, ContainerKind::Base);
    let dimensional = count(&save, ContainerKind::DimensionalPalStorage);
    let unknown = count(&save, ContainerKind::Unknown);
    assert!(party > 0, "no party pals classified");
    assert!(palbox > 0, "no palbox pals classified");
    assert!(base > 0, "no base-camp pals classified");
    assert!(
        dimensional > 0,
        "no dimensional-storage pals merged from *_dps.sav"
    );
    assert_eq!(
        unknown, 0,
        "every container should be classified; {unknown} left Unknown"
    );

    // Some pals must carry passives and non-zero IVs (data really decoded).
    assert!(
        save.pals.iter().any(|p| !p.passives.is_empty()),
        "no pal has any passive skills"
    );
    assert!(
        save.pals
            .iter()
            .any(|p| p.ivs.hp > 0 || p.ivs.attack > 0 || p.ivs.defense > 0),
        "no pal has non-zero IVs"
    );

    // Some pals must carry equipped active skills (EquipWaza really decoded),
    // with the EPalWazaID:: enum prefix stripped.
    assert!(
        save.pals.iter().any(|p| !p.active_skills.is_empty()),
        "no pal has any equipped active skills"
    );
    assert!(
        save.pals
            .iter()
            .flat_map(|p| &p.active_skills)
            .all(|s| !s.starts_with("EPalWazaID::")),
        "EPalWazaID:: prefix should be stripped from active skills"
    );

    // Gender should decode to both variants across a big roster.
    assert!(
        save.pals.iter().any(|p| p.gender.is_some()),
        "no pal has a decoded gender"
    );

    // Fail-soft: parsing the whole save should not have hard-errored per entity.
    assert!(
        save.warnings.len() < save.pals.len() / 10,
        "too many per-entity warnings: {}",
        save.warnings.len()
    );
}

fn count(save: &pal_save::SaveData, kind: ContainerKind) -> usize {
    save.pals
        .iter()
        .filter(|p| p.container_kind == kind)
        .count()
}
