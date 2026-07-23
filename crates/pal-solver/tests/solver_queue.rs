//! Multi-target queue (Wave A): earlier items' bred output seeds later items,
//! so a target breedable from a previous target's result costs one step instead
//! of re-deriving that result from scratch.
//!
//! Built from real pack breeding data, driven owned-only for determinism.

use pal_data::types::{ContainerKind, Gender, IvSet, OwnedPal};
use pal_data::GameData;
use pal_solver::solver::config::SolverConfig;
use pal_solver::solver::results::{PlanNode, PlanSource};
use pal_solver::solver::spec::{TargetPal, TargetSpec};
use pal_solver::solver::{solve, solve_queue, Catching, QueueItem};

fn owned(gd: &GameData, species: u16, gender: Gender, n: u8) -> OwnedPal {
    let mut instance_id = [0u8; 16];
    instance_id[0] = n;
    OwnedPal {
        instance_id,
        character_id: gd.species_at(species).unwrap().internal_name.clone(),
        is_boss: false,
        is_lucky: false,
        is_human: false,
        gender: Some(gender),
        level: 1,
        rank: 0,
        passives: vec![],
        active_skills: vec![],
        ivs: IvSet::default(),
        nickname: None,
        owner_player_uid: None,
        container_id: None,
        slot_index: None,
        container_kind: ContainerKind::Palbox,
    }
}

fn owned_only() -> SolverConfig {
    SolverConfig { include_wild: false, ..SolverConfig::default() }
}

fn has_owned_child_species(node: &PlanNode, species: u16) -> bool {
    node.children.iter().any(|c| {
        (matches!(c.source, PlanSource::Owned { .. }) && c.species == species)
            || has_owned_child_species(c, species)
    })
}

/// Find `(b_target, a_mid, c_other, a_p1, a_p2)` such that:
///   * `A` (a_mid) breeds from a canonical pair `(a_p1, a_p2)`,
///   * `(A, C)` is a gender-independent canonical parent pair of `B`.
/// This lets a two-item queue reuse item-1's `A` when solving `B`.
fn discover_chain(gd: &GameData) -> (u16, u16, u16, u16, u16) {
    let n = (0..u16::MAX).take_while(|&i| gd.species_at(i).is_some()).count() as u16;
    for b in 0..n {
        for &(a, c) in gd.parents_of(b) {
            // `A` must itself be breedable (has canonical parents).
            let a_parents = gd.parents_of(a);
            if a_parents.is_empty() {
                continue;
            }
            // The (A, C) -> B combo must be gender-independent so a
            // single-gender synthetic A can still pair with an owned C.
            let gi = gd.child_of(a, Gender::Male, c, Gender::Female) == Some(b)
                && gd.child_of(a, Gender::Female, c, Gender::Male) == Some(b);
            if !gi {
                continue;
            }
            let (p1, p2) = a_parents[0];
            // Keep the scenario clean: A's parents and C are all distinct from A
            // and B so ownership can't trivially short-circuit a step.
            if [p1, p2, c].iter().all(|&s| s != a && s != b) {
                return (b, a, c, p1, p2);
            }
        }
    }
    panic!("no suitable breeding chain found in pack");
}

#[test]
fn queue_reuses_prior_target_output() {
    let gd = GameData::get();
    let (b_target, a_mid, c_other, a_p1, a_p2) = discover_chain(gd);
    let cfg = owned_only();

    // Base roster: both genders of A's parents and of C. No A is owned.
    let base = vec![
        owned(gd, a_p1, Gender::Male, 1),
        owned(gd, a_p1, Gender::Female, 2),
        owned(gd, a_p2, Gender::Male, 3),
        owned(gd, a_p2, Gender::Female, 4),
        owned(gd, c_other, Gender::Male, 5),
        owned(gd, c_other, Gender::Female, 6),
    ];

    let spec_a = TargetSpec::new(TargetPal::Species(a_mid));
    let spec_b = TargetSpec::new(TargetPal::Species(b_target));

    // Standalone B from the base roster: must breed A first, then B (>= 2 steps).
    let standalone_b = solve(gd, &spec_b, &base, &cfg);
    assert!(!standalone_b.is_empty(), "B must be reachable from the base roster");
    let standalone_secs = standalone_b[0].total_time_secs;
    assert!(standalone_b[0].total_steps >= 2, "standalone B needs to breed A then B");
    assert!(
        !has_owned_child_species(&standalone_b[0].root, a_mid),
        "base roster owns no A, so standalone B cannot use an owned A"
    );

    // Queue: item 1 = A, item 2 = B. Item 1's bred A seeds item 2.
    let items = vec![
        QueueItem { spec: spec_a.clone(), cfg: cfg.clone(), catching: Catching::BreedingOnly },
        QueueItem { spec: spec_b.clone(), cfg: cfg.clone(), catching: Catching::BreedingOnly },
    ];
    let q = solve_queue(gd, &base, &items, false);
    assert_eq!(q.items.len(), 2, "both items solved");

    let item1 = &q.items[0];
    assert!(!item1.plans.is_empty(), "item 1 (A) must have a plan");
    assert_eq!(item1.target, TargetPal::Species(a_mid));

    let item2 = &q.items[1];
    assert!(!item2.plans.is_empty(), "item 2 (B) must have a plan");
    let queued_secs = item2.plans[0].total_time_secs;

    // The queued B plan reuses the synthetic owned A (one step, owned-A child).
    assert_eq!(item2.plans[0].total_steps, 1, "queued B is a single step off owned A");
    assert!(
        has_owned_child_species(&item2.plans[0].root, a_mid),
        "queued B must breed off the synthetic owned A"
    );

    // Reuse is strictly cheaper than deriving B from scratch.
    assert!(
        queued_secs < standalone_secs,
        "queued B ({queued_secs}s) must beat standalone B ({standalone_secs}s)"
    );

    // combined_effort = item1 effort + item2 (queued) effort.
    let expected = item1.plans[0].total_time_secs + queued_secs;
    assert!(
        (q.combined_effort_secs - expected).abs() < 1e-6,
        "combined effort must sum plans[0] of each item: {} vs {}",
        q.combined_effort_secs,
        expected
    );
    eprintln!(
        "queue chain B={b_target} A={a_mid} C={c_other}: standalone B={standalone_secs:.0}s ({} steps) | queued item1(A)={:.0}s item2(B)={queued_secs:.0}s ({} steps) combined={:.0}s",
        standalone_b[0].total_steps,
        item1.plans[0].total_time_secs,
        item2.plans[0].total_steps,
        q.combined_effort_secs,
    );
}

#[test]
fn queue_stops_on_failure() {
    let gd = GameData::get();
    let (_b, a_mid, _c, a_p1, a_p2) = discover_chain(gd);
    let cfg = owned_only();

    // Roster can breed A but the middle item targets an unreachable pin, so it
    // fails; with stop_on_failure the third item is never attempted.
    let base = vec![
        owned(gd, a_p1, Gender::Male, 1),
        owned(gd, a_p1, Gender::Female, 2),
        owned(gd, a_p2, Gender::Male, 3),
        owned(gd, a_p2, Gender::Female, 4),
    ];
    let spec_a = TargetSpec::new(TargetPal::Species(a_mid));
    let mut spec_fail = TargetSpec::new(TargetPal::Species(a_mid));
    // A pin no owned/bred pal can satisfy -> empty plans for this item.
    spec_fail.pinned_parents = vec![[0xAB; 16]];

    let items = vec![
        QueueItem { spec: spec_a.clone(), cfg: cfg.clone(), catching: Catching::BreedingOnly },
        QueueItem { spec: spec_fail, cfg: cfg.clone(), catching: Catching::BreedingOnly },
        QueueItem { spec: spec_a, cfg: cfg.clone(), catching: Catching::BreedingOnly },
    ];
    let q = solve_queue(gd, &base, &items, true);
    assert_eq!(q.items.len(), 2, "stop_on_failure halts after the failing item");
    assert!(!q.items[0].plans.is_empty(), "item 1 succeeds");
    assert!(q.items[1].plans.is_empty(), "item 2 fails (unsatisfiable pin)");
    assert!(!q.items[1].pins_satisfied, "failing item reports pins unsatisfied");
}
