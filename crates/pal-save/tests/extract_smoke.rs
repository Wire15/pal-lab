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

/// Human-NPC detection and guild/base ownership against the real save.
#[test]
fn humans_and_guild_bases() {
    use pal_data::GameData;
    let save = pal_save::read_save_dir(save_dir()).expect("read save dir");
    let gd = GameData::get();

    // Every owned entity whose species is absent from the pack must be flagged
    // a human — there are no genuine pal data-gaps left (the one casing quirk,
    // GhostAnglerFish -> Ghangler, resolves via the case-insensitive pack
    // lookup). Conversely every human must be absent from the pack and carry no
    // gender, and every non-human must resolve to a real species.
    let mut pal_gaps = Vec::new();
    for p in &save.pals {
        let in_pack = gd.species_by_id(&p.character_id).is_some();
        if p.is_human {
            assert!(p.gender.is_none(), "human {} has a gender", p.character_id);
            assert!(!in_pack, "human {} is actually in the pack", p.character_id);
        } else if !in_pack {
            pal_gaps.push(p.character_id.clone());
        }
    }
    assert!(
        pal_gaps.is_empty(),
        "unexpected non-human species missing from pack (data gap): {pal_gaps:?}"
    );

    // The real save contains catchable human NPCs (SalesPerson, Hunter_*,
    // Male_/Female_People*). At least a handful must be detected.
    let humans: Vec<&str> = save
        .pals
        .iter()
        .filter(|p| p.is_human)
        .map(|p| p.character_id.as_str())
        .collect();
    assert!(
        humans.len() >= 5,
        "expected >=5 human NPCs, found {}: {humans:?}",
        humans.len()
    );
    // The vast majority of the roster is real pals, not humans.
    assert!(
        humans.len() < save.pals.len() / 10,
        "implausibly many humans: {} of {}",
        humans.len(),
        save.pals.len()
    );

    // Boss-prefixed field variants (title-case `Boss_IceFox`/`Boss_LavaGirl`)
    // must strip to their base species and resolve, flagged as bosses.
    assert!(
        save.pals
            .iter()
            .any(|p| p.is_boss && gd.species_by_id(&p.character_id).is_some()),
        "no boss-variant pal resolved to a pack species"
    );

    // Guild/base ownership: at least one guild base mapped to a real worker
    // container, with non-empty members that are all known players.
    assert!(!save.bases.is_empty(), "no guild bases mapped");
    let player_uids: std::collections::HashSet<_> =
        save.players.iter().map(|p| p.uid).collect();
    let base_containers: std::collections::HashSet<_> = save
        .pals
        .iter()
        .filter(|p| p.container_kind == ContainerKind::Base)
        .filter_map(|p| p.container_id)
        .collect();
    let mut any_members = false;
    let mut any_populated = false;
    for b in &save.bases {
        assert!(
            !b.guild_name.is_empty() || !b.member_uids.is_empty(),
            "base {:?} has neither guild name nor members",
            b.container_id
        );
        for m in &b.member_uids {
            assert!(player_uids.contains(m), "base member is not a known player");
        }
        if !b.member_uids.is_empty() {
            any_members = true;
        }
        if base_containers.contains(&b.container_id) {
            any_populated = true;
        }
    }
    assert!(any_members, "no guild base had any member players");
    assert!(
        any_populated,
        "no mapped base container holds any Base-classified pals"
    );
}

fn count(save: &pal_save::SaveData, kind: ContainerKind) -> usize {
    save.pals
        .iter()
        .filter(|p| p.container_kind == kind)
        .count()
}
