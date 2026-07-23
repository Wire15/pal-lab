//! Parent-pinning (Wave A): pinned owned instances must appear as leaves in
//! every returned plan, are exempt from the initial working-set reduction, and
//! set `pins_satisfied = false` (with empty plans) when they eliminate every
//! otherwise-valid result.
//!
//! Scenarios are built from real pack breeding data (a discovered canonical
//! parent pair of a target), driven through the full `solve` pipeline
//! owned-only, so they are deterministic and independent of any save.

use pal_data::types::{ContainerKind, Gender, Guid, IvSet, OwnedPal, PassiveId};
use pal_data::GameData;
use pal_solver::solver::config::SolverConfig;
use pal_solver::solver::results::PlanSource;
use pal_solver::solver::spec::{TargetPal, TargetSpec};
use pal_solver::solver::{resolve_species, solve_reporting};

/// A synthetic owned pal with a chosen instance id and passive list.
fn owned(
    gd: &GameData,
    species: u16,
    gender: Gender,
    instance_id: Guid,
    passives: Vec<PassiveId>,
) -> OwnedPal {
    OwnedPal {
        instance_id,
        character_id: gd.species_at(species).unwrap().internal_name.clone(),
        is_boss: false,
        is_lucky: false,
        is_human: false,
        gender: Some(gender),
        level: 1,
        rank: 0,
        passives,
        active_skills: vec![],
        ivs: IvSet::default(),
        nickname: None,
        owner_player_uid: None,
        container_id: None,
        slot_index: None,
        container_kind: ContainerKind::Palbox,
    }
}

fn id(n: u8) -> Guid {
    let mut g = [0u8; 16];
    g[0] = n;
    g
}

fn owned_only() -> SolverConfig {
    SolverConfig { include_wild: false, ..SolverConfig::default() }
}

/// Any owned instance id appearing as a leaf in a plan tree.
fn owned_species_in_plan(node: &pal_solver::solver::results::PlanNode, species: u16) -> bool {
    if matches!(node.source, PlanSource::Owned { .. }) && node.species == species {
        return true;
    }
    node.children.iter().any(|c| owned_species_in_plan(c, species))
}

/// A target with a discoverable canonical one-step parent pair, and that pair.
/// Returns `(target, parent_a, parent_b)`.
fn discover_pair(gd: &GameData) -> (u16, u16, u16) {
    // Anubis is the golden target and has canonical parents in the pack.
    let anubis = resolve_species(gd, "Anubis").expect("Anubis in pack");
    let pairs = gd.parents_of(anubis);
    assert!(!pairs.is_empty(), "Anubis must have canonical parents");
    let (a, b) = pairs[0];
    (anubis, a, b)
}

/// (a) Pinning an instance that the unpinned owned-only plan already uses
/// returns the same best plan with `pins_satisfied = true`.
#[test]
fn pin_used_instance_keeps_plan() {
    let gd = GameData::get();
    let (target, a, b) = discover_pair(gd);
    let cfg = owned_only();

    let a_id = id(1);
    let b_id = id(2);
    let roster =
        vec![owned(gd, a, Gender::Male, a_id, vec![]), owned(gd, b, Gender::Female, b_id, vec![])];

    let spec = TargetSpec::new(TargetPal::Species(target));
    let (unpinned, unpinned_pins) = solve_reporting(gd, &spec, &roster, &cfg);
    assert!(!unpinned.is_empty(), "owned parents must yield a plan");
    assert!(unpinned_pins, "no pins -> pins_satisfied true");

    // Pin parent A (the only source of its species — must appear in every plan).
    let mut pinned_spec = spec.clone();
    pinned_spec.pinned_parents = vec![a_id];
    let (pinned, pinned_pins) = solve_reporting(gd, &pinned_spec, &roster, &cfg);
    assert!(pinned_pins, "the pin is satisfiable");
    assert!(!pinned.is_empty(), "pinned plan must survive");
    assert!(
        owned_species_in_plan(&pinned[0].root, a),
        "the pinned parent species must appear owned in the plan"
    );
    // Same best plan (identical effort + step count).
    assert_eq!(pinned[0].total_steps, unpinned[0].total_steps, "same step count");
    assert!(
        (pinned[0].total_time_secs - unpinned[0].total_time_secs).abs() < 1e-6,
        "same best effort"
    );
}

/// (b) A pin that no owned pal (hence no plan tree) can satisfy empties the
/// result and reports `pins_satisfied = false`. (The pack's breeding graph is
/// effectively fully connected, so a *reachable* owned species is always
/// pin-satisfiable; the genuinely unsatisfiable case is a pin absent from the
/// owned roster — an id you don't actually have.)
#[test]
fn pin_unreachable_instance_empties_result() {
    let gd = GameData::get();
    let (target, a, b) = discover_pair(gd);
    let cfg = owned_only();

    // An extra owned pal of an unrelated species, plus the target's parents.
    let ghost_species = (0..u16::MAX)
        .map_while(|i| gd.species_at(i).map(|_| i))
        .find(|&s| s != a && s != b && s != target)
        .expect("some third species");
    let roster = vec![
        owned(gd, a, Gender::Male, id(1), vec![]),
        owned(gd, b, Gender::Female, id(2), vec![]),
        owned(gd, ghost_species, Gender::Male, id(9), vec![]),
    ];

    let spec = TargetSpec::new(TargetPal::Species(target));
    // Sanity: reachable without the pin.
    let (base, _) = solve_reporting(gd, &spec, &roster, &cfg);
    assert!(!base.is_empty(), "target reachable without pins");

    // Pin an instance id that no owned pal carries -> no tree can contain it.
    let mut pinned_spec = spec.clone();
    pinned_spec.pinned_parents = vec![[0x7F; 16]];
    let (pinned, pins_satisfied) = solve_reporting(gd, &pinned_spec, &roster, &cfg);
    assert!(pinned.is_empty(), "an unsatisfiable pin must empty the plans");
    assert!(!pins_satisfied, "pins_satisfied must be false when a pin kills the result");
}

/// (c) A pinned instance that the working-set reduction would otherwise drop
/// (here: filtered out by `max_input_irrelevant_passives = 0` because it
/// carries an irrelevant passive) is retained, so the plan can still be built.
#[test]
fn pinned_instance_exempt_from_reduction() {
    let gd = GameData::get();
    let (target, a, b) = discover_pair(gd);

    // Zero irrelevant-passive budget: an owned pal with any off-target passive
    // is normally filtered out of the initial working set entirely.
    let cfg = SolverConfig {
        include_wild: false,
        max_input_irrelevant_passives: 0,
        ..SolverConfig::default()
    };

    // Parent A carries one irrelevant passive; parent B is clean. With no other
    // source of species A, filtering A out makes the target unreachable.
    let irrelevant: PassiveId = "Legend".to_string();
    let a_id = id(1);
    let roster = vec![
        owned(gd, a, Gender::Male, a_id, vec![irrelevant.clone()]),
        owned(gd, b, Gender::Female, id(2), vec![]),
    ];

    let spec = TargetSpec::new(TargetPal::Species(target));

    // Unpinned: A is dropped by the irrelevant-passive reduction -> no plan.
    let (unpinned, _) = solve_reporting(gd, &spec, &roster, &cfg);
    assert!(
        unpinned.is_empty(),
        "without the pin, the reduction drops parent A and the target is unreachable"
    );

    // Pinned: A is exempt from the reduction, retained, and the plan is found.
    let mut pinned_spec = spec.clone();
    pinned_spec.pinned_parents = vec![a_id];
    let (pinned, pins_satisfied) = solve_reporting(gd, &pinned_spec, &roster, &cfg);
    assert!(pins_satisfied, "pin is satisfiable once A is retained");
    assert!(!pinned.is_empty(), "pinned exemption must retain A and yield a plan");
    assert!(
        owned_species_in_plan(&pinned[0].root, a),
        "the retained pinned parent must appear in the plan"
    );
}
