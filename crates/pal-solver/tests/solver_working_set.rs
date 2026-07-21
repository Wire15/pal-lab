//! Working-set keying and dominance. No probability calls: bred refs receive
//! their probabilities directly.

use pal_data::types::{ContainerKind, Gender, PassiveId};
use pal_data::GameData;
use pal_solver::solver::refs::{
    BredPalRef, EffPassive, OwnedInstance, OwnedPalRef, PalRef, SolverIv, SolverIvSet,
};
use pal_solver::solver::working_set::{dominates, key_of, WorkingSet};

fn owned_instance() -> OwnedInstance {
    OwnedInstance {
        instance_id: [0u8; 16],
        gender: Gender::Male,
        container: ContainerKind::Palbox,
        real_passives: vec![],
        ivs: SolverIvSet::RANDOM,
    }
}

fn bred(gd: &GameData, species: u16, prob: f64) -> PalRef {
    // Owned (zero-effort) parents so the bred effort is purely self-effort,
    // which decreases as `prob` increases.
    let parent = |g: Gender| {
        PalRef::Owned(OwnedPalRef {
            species: 1,
            gender: g.into(),
            effective_passives: vec![],
            ivs: SolverIvSet::RANDOM,
            primary: OwnedInstance { gender: g, ..owned_instance() },
            alt: None,
        })
    };
    PalRef::Bred(Box::new(BredPalRef::new(
        gd,
        species,
        parent(Gender::Male),
        parent(Gender::Female),
        vec![],
        prob,
        SolverIvSet::RANDOM,
        1.0,
    )))
}

fn owned_with(species: u16, gender: Gender, effective: Vec<EffPassive>, ivs: SolverIvSet) -> PalRef {
    PalRef::Owned(OwnedPalRef {
        species,
        gender: gender.into(),
        effective_passives: effective,
        ivs,
        primary: OwnedInstance { gender, ..owned_instance() },
        alt: None,
    })
}

#[test]
fn cheaper_equal_key_ref_replaces_worse() {
    let gd = GameData::get();
    let worse = bred(gd, 0, 1.0 / 3.0); // avg 3
    let better = bred(gd, 0, 0.5); // avg 2 -> cheaper
    assert!(better.total_effort() < worse.total_effort());
    // Same grouping key (species/gender/passives/iv-relevance all identical).
    assert_eq!(key_of(&worse), key_of(&better));

    let mut ws = WorkingSet::new();
    assert!(ws.insert(worse.clone()));
    assert!(ws.insert(better.clone()), "cheaper ref should be accepted");
    assert_eq!(ws.len(), 1);
    assert!(
        (ws.get(&better).unwrap().total_effort() - better.total_effort()).abs() < 1e-9,
        "cheaper ref should be the survivor"
    );
    // Re-inserting the worse ref is rejected.
    assert!(!ws.insert(worse), "worse equal-key ref should be dropped");
    assert_eq!(ws.len(), 1);
}

#[test]
fn distinct_genders_are_distinct_keys() {
    let mut ws = WorkingSet::new();
    assert!(ws.insert(owned_with(4, Gender::Male, vec![], SolverIvSet::RANDOM)));
    assert!(ws.insert(owned_with(4, Gender::Female, vec![], SolverIvSet::RANDOM)));
    assert_eq!(ws.len(), 2, "male and female of the same pal are kept separately");
}

#[test]
fn passive_key_is_order_independent() {
    let a: PassiveId = "Alpha".into();
    let b: PassiveId = "Beta".into();
    let r1 = owned_with(
        6,
        Gender::Male,
        vec![EffPassive::Desired(a.clone()), EffPassive::Desired(b.clone())],
        SolverIvSet::RANDOM,
    );
    let r2 = owned_with(
        6,
        Gender::Male,
        vec![EffPassive::Desired(b), EffPassive::Desired(a)],
        SolverIvSet::RANDOM,
    );
    assert_eq!(key_of(&r1), key_of(&r2), "passive ordering must not affect the key");
}

#[test]
fn iv_quality_breaks_effort_ties() {
    // Two owned refs (both zero effort) with the same key but different IV maxes.
    let rel_hi = SolverIvSet { hp: SolverIv::fixed(true, 90), ..SolverIvSet::RANDOM };
    let rel_lo = SolverIvSet { hp: SolverIv::fixed(true, 60), ..SolverIvSet::RANDOM };
    let hi = owned_with(8, Gender::Male, vec![], rel_hi);
    let lo = owned_with(8, Gender::Male, vec![], rel_lo);
    // Same relevance (hp relevant) -> same key; equal (zero) effort.
    assert_eq!(key_of(&hi), key_of(&lo));
    assert_eq!(hi.total_effort(), lo.total_effort());
    assert!(dominates(&hi, &lo), "higher IVs win the effort tie");
    assert!(!dominates(&lo, &hi));
    // Identical refs: incumbent kept (no strict domination).
    assert!(!dominates(&hi, &hi));
}
