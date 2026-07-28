//! Bred plan-node intelligence fields (StepData wave): `prob_passives`,
//! `prob_ivs`, `expected_eggs`, `iv_targets`. Deterministic hand-built refs — no
//! probability model, no save file — so the invariants stand on their own.

use pal_data::types::{ContainerKind, Gender};
use pal_data::GameData;
use pal_solver::solver::config::{BreedingSetup, CakeKind};
use pal_solver::solver::refs::{
    BredPalRef, OwnedInstance, OwnedPalRef, PalRef, SolverIv, SolverIvSet,
};
use pal_solver::solver::results::{BreedingPlan, PlanSource};

fn owned_ref(species: u16, gender: Gender) -> PalRef {
    PalRef::Owned(OwnedPalRef {
        species,
        gender: gender.into(),
        effective_passives: vec![],
        ivs: SolverIvSet::RANDOM,
        primary: OwnedInstance {
            instance_id: [0u8; 16],
            gender,
            container: ContainerKind::Palbox,
            real_passives: vec![],
            ivs: SolverIvSet::RANDOM,
        },
        alt: None,
        carries_move: false,
    })
}

/// An IV set with HP relevant at floor `hp_floor`, attack/defense irrelevant.
fn hp_only_ivs(hp_floor: u8) -> SolverIvSet {
    SolverIvSet {
        hp: SolverIv::fixed(true, hp_floor),
        attack: SolverIv::fixed(false, 0),
        defense: SolverIv::fixed(false, 0),
    }
}

fn bred(gd: &GameData, species: u16, pp: f64, pi: f64, ivs: SolverIvSet, p1: PalRef, p2: PalRef) -> BredPalRef {
    BredPalRef::new(gd, species, p1, p2, vec![], pp, ivs, pi, &BreedingSetup::default(), 1.0)
}

#[test]
fn bred_node_carries_prob_split_eggs_and_iv_targets() {
    let gd = GameData::get();

    // Two-level HP-carrying chain: root(bred) <- [owned, bred-parent(hp)].
    let parent_bred = bred(
        gd,
        1,
        0.4,
        0.5,
        hp_only_ivs(40),
        owned_ref(2, Gender::Male),
        owned_ref(3, Gender::Female),
    );
    let parent_avg = parent_bred.avg_required_breedings;

    let root = bred(
        gd,
        0,
        0.25,
        0.5,
        hp_only_ivs(40),
        owned_ref(4, Gender::Male),
        PalRef::Bred(Box::new(parent_bred)),
    );
    let root_avg = root.avg_required_breedings;
    let root_ref = PalRef::Bred(Box::new(root));

    // iv_thresholds = the (cake-effective) spec floors; HP demanded at 40.
    let plan = BreedingPlan::from_ref(gd, &root_ref, CakeKind::Normal, [40, 30, 20]);
    let r = &plan.root;

    // (a) prob split present and composes to the node probability.
    assert_eq!(r.prob_passives, Some(0.25));
    assert_eq!(r.prob_ivs, Some(0.5));
    let pp = r.prob_passives.unwrap();
    let pi = r.prob_ivs.unwrap();
    assert!((r.probability - pp * pi).abs() < 1e-12, "probability must equal prob_passives*prob_ivs");

    // (b) iv_targets: HP threshold (40) on the HP-carrying stat, 0 on the
    //     attack/defense stats the spec never demanded — even though the spec
    //     thresholds there are 30/20, they are not relevant so they stay 0.
    assert_eq!(r.iv_targets, Some([40, 0, 0]));

    // (c) expected_eggs is the ref's OWN per-node avg_required_breedings.
    assert_eq!(r.expected_eggs, Some(root_avg));

    // The bred parent (still on the HP-carrying chain) also gates on HP=40 and
    // reports ITS OWN egg count (per-node, not the root's or a cumulative sum).
    let bred_child = r
        .children
        .iter()
        .find(|c| matches!(c.source, PlanSource::Bred))
        .expect("a bred parent");
    assert_eq!(bred_child.iv_targets, Some([40, 0, 0]));
    assert_eq!(bred_child.expected_eggs, Some(parent_avg));
    assert_eq!(bred_child.prob_passives, Some(0.4));
    assert_eq!(bred_child.prob_ivs, Some(0.5));

    // Owned leaves never carry the bred-only fields.
    let owned_leaf = r
        .children
        .iter()
        .find(|c| matches!(c.source, PlanSource::Owned { .. }))
        .expect("an owned leaf");
    assert_eq!(owned_leaf.prob_passives, None);
    assert_eq!(owned_leaf.prob_ivs, None);
    assert_eq!(owned_leaf.expected_eggs, None);
    assert_eq!(owned_leaf.iv_targets, None);
}

#[test]
fn iv_targets_zero_when_stat_not_carried() {
    let gd = GameData::get();
    // A bred node with NO relevant IVs: iv_targets all zero regardless of the
    // spec thresholds passed in.
    let node = bred(
        gd,
        0,
        0.5,
        1.0,
        SolverIvSet::RANDOM,
        owned_ref(1, Gender::Male),
        owned_ref(2, Gender::Female),
    );
    let node_ref = PalRef::Bred(Box::new(node));
    let plan = BreedingPlan::from_ref(gd, &node_ref, CakeKind::Normal, [50, 50, 50]);
    assert_eq!(plan.root.iv_targets, Some([0, 0, 0]));
    // prob_ivs == 1.0 (no IV constraint) still recorded, not absent.
    assert_eq!(plan.root.prob_ivs, Some(1.0));
}

#[test]
fn expected_eggs_is_per_node_not_cumulative() {
    let gd = GameData::get();
    // Root avg is small (high prob); the bred parent's avg is large (low prob).
    // A cumulative field would make the root >= the parent; per-node must not.
    let parent = bred(
        gd,
        1,
        0.05,
        1.0,
        SolverIvSet::RANDOM,
        owned_ref(2, Gender::Male),
        owned_ref(3, Gender::Female),
    );
    let parent_avg = parent.avg_required_breedings; // ceil(1/0.05) = 20
    let root = bred(
        gd,
        0,
        1.0,
        1.0,
        SolverIvSet::RANDOM,
        owned_ref(4, Gender::Male),
        PalRef::Bred(Box::new(parent)),
    );
    let root_avg = root.avg_required_breedings; // ceil(1/1.0) = 1
    let root_ref = PalRef::Bred(Box::new(root));
    let plan = BreedingPlan::from_ref(gd, &root_ref, CakeKind::Normal, [0, 0, 0]);

    assert_eq!(plan.root.expected_eggs, Some(root_avg));
    assert!(root_avg < parent_avg, "sanity: root cheaper than parent");
    let bred_child = plan
        .root
        .children
        .iter()
        .find(|c| matches!(c.source, PlanSource::Bred))
        .unwrap();
    assert_eq!(bred_child.expected_eggs, Some(parent_avg));
    // Per-node: the root's egg count is NOT the cumulative sum of the subtree.
    assert!(
        plan.root.expected_eggs.unwrap() < bred_child.expected_eggs.unwrap(),
        "expected_eggs must be per-node, not cumulative",
    );
}
