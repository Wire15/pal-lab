//! Patch-resilience canary. Reads a reference save (gitignored testdata; skips
//! gracefully when absent so CI without the fixture stays green) and asserts
//! that the decoded roster carries nonzero values in every save property we
//! depend on: pals, passives, IVs/talents, level, rank, and gender.
//!
//! The point is a LOUD failure the next time a game patch silently renames a
//! save property. A rename makes the corresponding extractor read nothing, so
//! the field collapses to its zero/empty default across the whole roster — an
//! all-zero column here means "the property name moved", not "no data".

use std::path::PathBuf;

fn save_dir() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58");
    p.is_dir().then_some(p)
}

#[test]
fn reference_save_decodes_nonzero_core_fields() {
    let Some(dir) = save_dir() else {
        eprintln!("reference_save_decodes_nonzero_core_fields: testdata save absent, skipping");
        return;
    };

    let save = pal_save::read_save_dir(&dir).expect("read reference save");

    // Roster itself: a rename of the container/character properties zeroes this.
    assert!(
        !save.pals.is_empty(),
        "no pals decoded — CharacterContainer/instance layout likely renamed"
    );

    // Passives (`PassiveSkillList`).
    assert!(
        save.pals.iter().any(|p| !p.passives.is_empty()),
        "no pal carries any passive — PassiveSkillList property likely renamed"
    );

    // IVs / talents (`Talent_HP` / `Talent_Melee` / `Talent_Defense`).
    assert!(
        save.pals
            .iter()
            .any(|p| p.ivs.hp > 0 || p.ivs.attack > 0 || p.ivs.defense > 0),
        "every pal has all-zero IVs — Talent_* properties likely renamed"
    );

    // Level (`Level`).
    assert!(
        save.pals.iter().any(|p| p.level > 1),
        "no pal above level 1 — Level property likely renamed"
    );

    // Condensation rank (`Rank`) — at least one pal in a large roster is ranked.
    assert!(
        save.pals.iter().any(|p| p.rank > 0),
        "no pal has a nonzero rank — Rank property likely renamed"
    );

    // Gender (`Gender`) — required to distinguish pals from human NPCs.
    assert!(
        save.pals.iter().any(|p| p.gender.is_some()),
        "no pal has a decoded gender — Gender property likely renamed"
    );
}
