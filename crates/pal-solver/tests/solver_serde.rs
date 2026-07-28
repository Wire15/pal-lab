//! Breeding-plan serialization roundtrip (a Tauri command wraps this next phase).
//! Builds a plan tree from hand-constructed refs — no probability calls.

use pal_data::types::{ContainerKind, Gender};
use pal_data::GameData;
use pal_solver::solver::refs::{
    BredPalRef, EffPassive, OwnedInstance, OwnedPalRef, PalRef, SolverIvSet, WildPalRef,
};
use pal_solver::solver::results::{BreedingPlan, PlanSource};
use pal_solver::solver::CakeKind;
use pal_solver::solver::config::BreedingSetup;

#[test]
fn plan_serializes_and_roundtrips() {
    let gd = GameData::get();

    let owned = PalRef::Owned(OwnedPalRef {
        species: 1,
        gender: Gender::Male.into(),
        effective_passives: vec![EffPassive::Desired("Swift".into())],
        ivs: SolverIvSet::RANDOM,
        primary: OwnedInstance {
            instance_id: [1u8; 16],
            gender: Gender::Male,
            container: ContainerKind::Palbox,
            real_passives: vec!["Swift".into()],
            ivs: SolverIvSet::RANDOM,
        },
        alt: None,
        carries_move: false,
    });
    let wild = PalRef::Wild(WildPalRef::new(gd, 2, vec![], 1));

    let bred = PalRef::Bred(Box::new(BredPalRef::new(
        gd,
        0,
        owned,
        wild,
        vec![EffPassive::Desired("Swift".into()), EffPassive::Random],
        0.25,
        SolverIvSet::RANDOM,
        1.0,
        &BreedingSetup::default(),
        1.0,
    )));

    let plan = BreedingPlan::from_ref(gd, &bred, CakeKind::Normal, [0, 0, 0]);
    assert_eq!(plan.root.children.len(), 2);
    assert!(matches!(plan.root.source, PlanSource::Bred));
    assert_eq!(plan.total_steps, 1);
    assert_eq!(plan.total_wild_pals, 1);
    // probability captured on the bred node
    assert!((plan.root.probability - 0.25).abs() < 1e-9);

    // A leaf sourced from a wild catch.
    let has_wild = plan
        .root
        .children
        .iter()
        .any(|c| matches!(c.source, PlanSource::Wild { .. }));
    assert!(has_wild, "wild parent should surface as a Wild source");

    let json = serde_json::to_string(&plan).expect("serialize");
    let back: BreedingPlan = serde_json::from_str(&json).expect("deserialize");
    let json2 = serde_json::to_string(&back).expect("re-serialize");
    assert_eq!(json, json2, "roundtrip must be lossless");

    assert_eq!(back.root.children.len(), 2);
    assert_eq!(back.total_wild_pals, plan.total_wild_pals);
    assert_eq!(back.root.species_name, plan.root.species_name);
}
