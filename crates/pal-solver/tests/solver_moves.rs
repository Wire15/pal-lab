//! Active-skill move-inheritance tests: the child-moveset model where a bred
//! pal's required moves come from its target-species learnset (auto-satisfied),
//! AT MOST ONE move threaded through breeding (per-egg rate
//! `ACTIVE_INHERIT_RATE`, COMMUNITY-MEASURED — not code-verified), and the rest
//! from Skill Fruit (`SolverConfig::skill_fruit`, a terminal result-layer step
//! mirroring surgery). These drive the full `solve` pipeline against the embedded
//! pack with synthetic owned sets (never the real save), mirroring the fixture
//! conventions in `solver_surgery.rs`. Note `OwnedPal` now carries an
//! `active_skills` field (equipped move ids); wild pals never carry a move.

use std::collections::HashSet;

use pal_data::types::{ContainerKind, Gender, IvSet, OwnedPal};
use pal_data::GameData;
use pal_solver::solver::config::{SkillFruitConfig, SolverConfig};
use pal_solver::solver::results::PlanNode;
use pal_solver::solver::spec::{TargetPal, TargetSpec};
use pal_solver::solver::{diagnose_no_path, solve, NoPathReason};

/// A synthetic owned pal of `species`/`gender` carrying `passives` + equipped
/// `moves`, level 1. `seed` disambiguates the instance id so a pair of the same
/// species does not collide.
fn owned(
    gd: &GameData,
    seed: u8,
    species: u16,
    gender: Gender,
    passives: &[&str],
    moves: &[&str],
) -> OwnedPal {
    let mut instance_id = [species as u8; 16];
    instance_id[0] = seed;
    OwnedPal {
        instance_id,
        character_id: gd.species_at(species).unwrap().internal_name.clone(),
        is_boss: false,
        is_lucky: false,
        gender: Some(gender),
        level: 1,
        rank: 0,
        passives: passives.iter().map(|p| p.to_string()).collect(),
        active_skills: moves.iter().map(|m| m.to_string()).collect(),
        is_human: false,
        ivs: IvSet::default(),
        nickname: None,
        owner_player_uid: None,
        container_id: None,
        slot_index: None,
        container_kind: ContainerKind::Palbox,
    }
}

/// The first cross-species recipe `(a, b) -> t` (three distinct species),
/// gender-oriented `(a Female, b Male)`. Mirrors `solver_surgery`'s `find_recipe`.
fn find_recipe(gd: &GameData) -> (u16, u16, u16) {
    let n = gd.species_count() as u16;
    for t in 0..n {
        for a in 0..n {
            for b in (a + 1)..n {
                if a == t || b == t {
                    continue;
                }
                if gd.child_of(a, Gender::Female, b, Gender::Male) == Some(t) {
                    return (a, b, t);
                }
            }
        }
    }
    panic!("no cross-species recipe in pack");
}

/// The first cross-species recipe whose target species has a non-empty learnset
/// (for the levelup-auto-satisfy case).
fn find_recipe_with_learnset(gd: &GameData) -> (u16, u16, u16) {
    let n = gd.species_count() as u16;
    for t in 0..n {
        if gd.learnset(t).is_empty() {
            continue;
        }
        for a in 0..n {
            for b in (a + 1)..n {
                if a == t || b == t {
                    continue;
                }
                if gd.child_of(a, Gender::Female, b, Gender::Male) == Some(t) {
                    return (a, b, t);
                }
            }
        }
    }
    panic!("no cross-species recipe with a learnset target in pack");
}

fn learnset_ids(gd: &GameData, t: u16) -> HashSet<String> {
    gd.learnset(t).iter().map(|lm| lm.waza_id.clone()).collect()
}

/// First move id with the requested (`can_inherit`, `has_skill_fruit`) flags that
/// is NOT in `avoid` (the target learnset), plus its display name.
fn find_move(
    gd: &GameData,
    avoid: &HashSet<String>,
    can_inherit: bool,
    has_fruit: bool,
) -> (String, String) {
    gd.active_skills()
        .iter()
        .find(|(id, a)| {
            a.can_inherit == can_inherit && a.has_skill_fruit == has_fruit && !avoid.contains(id)
        })
        .map(|(id, a)| (id.clone(), a.name.clone()))
        .unwrap_or_else(|| {
            panic!("no move with can_inherit={can_inherit} has_skill_fruit={has_fruit} outside learnset")
        })
}

fn owned_only() -> SolverConfig {
    SolverConfig { include_wild: false, ..SolverConfig::default() }
}

fn with_fruit(cost_secs: f64) -> SolverConfig {
    SolverConfig { skill_fruit: Some(SkillFruitConfig { cost_secs }), ..owned_only() }
}

/// Walk the plan tree collecting every node's `inherited_move`.
fn collect_inherited(node: &PlanNode, out: &mut Vec<String>) {
    if let Some(m) = &node.inherited_move {
        out.push(m.clone());
    }
    for c in &node.children {
        collect_inherited(c, out);
    }
}

/// (a) An owned carrier of an inheritable (non-fruitable) move => the plan threads
/// it: a bred node carries `inherited_move`, and the effort is strictly HIGHER
/// than the same target without the move requirement (the inherit roll multiplies
/// into the success probability, raising the egg count).
#[test]
fn owned_carrier_threads_move() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    let learn = learnset_ids(gd, t);
    let (m, m_name) = find_move(gd, &learn, true, false); // inheritable, non-fruitable

    // Parent `a` carries the move; nobody else does.
    let pool = vec![owned(gd, 1, a, Gender::Female, &[], &[&m]), owned(gd, 2, b, Gender::Male, &[], &[])];

    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_moves = vec![m.clone()];
    let with = solve(gd, &spec, &pool, &owned_only());
    assert!(!with.is_empty(), "an owned carrier makes the move threadable");
    let plan = &with[0];

    // The threaded move surfaces as `inherited_move` on a bred node.
    let mut inherited = Vec::new();
    collect_inherited(&plan.root, &mut inherited);
    assert!(
        inherited.contains(&m_name),
        "a bred node must record the threaded move as inherited_move, got {inherited:?}"
    );
    assert!(plan.fruits.is_empty(), "no fruit step when the move is threaded");
    assert!(plan.levelup_moves.is_empty(), "the move is not in the target learnset");

    // Same target, no move requirement: strictly cheaper (no inherit roll).
    let plain_spec = TargetSpec::new(TargetPal::Species(t));
    let plain = solve(gd, &plain_spec, &pool, &owned_only());
    assert!(!plain.is_empty());
    assert!(
        plan.total_time_secs > plain[0].total_time_secs,
        "threading the move must raise effort: with={} plain={}",
        plan.total_time_secs,
        plain[0].total_time_secs
    );
}

/// (b) No owned carrier but the move is fruitable: with Skill Fruit ON the plan
/// carries a fruit step (cost folded into effort); with it OFF the target is
/// unreachable and diagnosed as `MissingMoveCarrier { fruit_off: true }`.
#[test]
fn no_carrier_fruitable_uses_fruit_or_blocks() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    let learn = learnset_ids(gd, t);
    let (m, _m_name) = find_move(gd, &learn, false, true); // non-inheritable but fruitable

    // Nobody carries the move.
    let pool = vec![owned(gd, 1, a, Gender::Female, &[], &[]), owned(gd, 2, b, Gender::Male, &[], &[])];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_moves = vec![m.clone()];

    // Fruit ON: a plan exists with exactly one fruit step at the configured cost.
    let cost = 450.0;
    let on = solve(gd, &spec, &pool, &with_fruit(cost));
    assert!(!on.is_empty(), "skill fruit must cover the fruitable move");
    let plan = &on[0];
    assert_eq!(plan.fruits.len(), 1, "one fruit step");
    assert_eq!(plan.fruits[0].move_id, m, "fruit teaches the required move");
    assert!((plan.fruits[0].cost_secs - cost).abs() < 1e-9);
    let mut inherited = Vec::new();
    collect_inherited(&plan.root, &mut inherited);
    assert!(inherited.is_empty(), "no move threaded (no carrier) — pure fruit");

    // The fruit cost is folded into the plan effort: same tree, +cost.
    let plain = solve(gd, &TargetSpec::new(TargetPal::Species(t)), &pool, &with_fruit(cost));
    assert!(!plain.is_empty());
    let delta = plan.total_time_secs - plain[0].total_time_secs;
    assert!((delta - cost).abs() < 1e-6, "fruit cost added to effort, got {delta}");

    // Fruit OFF: unreachable, diagnosed with fruit_off:true.
    let off = solve(gd, &spec, &pool, &owned_only());
    assert!(off.is_empty(), "no fruit relaxation => the move cannot be obtained");
    let reasons = diagnose_no_path(gd, &spec, &pool, &owned_only());
    assert!(
        reasons.iter().any(|r| matches!(
            r,
            NoPathReason::MissingMoveCarrier { move_id, fruit_available: true, fruit_off: true, .. }
                if *move_id == m
        )),
        "fruit-off fruitable move must flag fruit_off, got {reasons:?}"
    );
}

/// (c) A move that is neither inheritable nor fruitable can never be obtained:
/// NoPath with `inheritable: false` regardless of any config.
#[test]
fn non_inheritable_non_fruitable_blocks() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    let learn = learnset_ids(gd, t);
    let (m, _m_name) = find_move(gd, &learn, false, false); // neither

    // Even with a "carrier", a non-inheritable move cannot thread.
    let pool = vec![owned(gd, 1, a, Gender::Female, &[], &[&m]), owned(gd, 2, b, Gender::Male, &[], &[])];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_moves = vec![m.clone()];

    // Skill Fruit on cannot help either (no fruit exists for this move).
    assert!(solve(gd, &spec, &pool, &with_fruit(300.0)).is_empty());
    let reasons = diagnose_no_path(gd, &spec, &pool, &with_fruit(300.0));
    assert!(
        reasons.iter().any(|r| matches!(
            r,
            NoPathReason::MissingMoveCarrier {
                move_id,
                inheritable: false,
                fruit_available: false,
                fruit_off: false,
                move_name: _,
            } if *move_id == m
        )),
        "hard-unobtainable move must report inheritable:false fruit_available:false, got {reasons:?}"
    );
}

/// (d) Two non-fruitable required moves exceed the single breeding slot: NoPath.
/// The second move reuses `MissingMoveCarrier { inheritable: true,
/// fruit_available: false }` (it is threadable in isolation, just no free slot).
#[test]
fn two_non_fruitable_moves_exceed_cap() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    let learn = learnset_ids(gd, t);
    // Two DISTINCT inheritable, non-fruitable moves not in the target learnset.
    let (m1, _n1) = find_move(gd, &learn, true, false);
    let mut avoid = learn.clone();
    avoid.insert(m1.clone());
    let (m2, _n2) = find_move(gd, &avoid, true, false);
    assert_ne!(m1, m2, "distinct moves");

    // A single owned carrier holds BOTH moves (both threadable), so the blocker is
    // the single-thread cap, not a missing carrier.
    let pool = vec![
        owned(gd, 1, a, Gender::Female, &[], &[&m1, &m2]),
        owned(gd, 2, b, Gender::Male, &[], &[]),
    ];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_moves = vec![m1.clone(), m2.clone()];

    assert!(solve(gd, &spec, &pool, &owned_only()).is_empty(), "two non-fruitable moves cannot both thread");
    let reasons = diagnose_no_path(gd, &spec, &pool, &owned_only());
    assert!(
        reasons.iter().any(|r| matches!(
            r,
            NoPathReason::MissingMoveCarrier {
                move_id,
                inheritable: true,
                fruit_available: false,
                ..
            } if *move_id == m2
        )),
        "the second non-fruitable move exceeds the cap (inheritable:true), got {reasons:?}"
    );
}

/// (e) A required move in the TARGET species' own learnset is auto-satisfied by
/// leveling: it surfaces in `levelup_moves`, imposes no breeding constraint, and
/// leaves the plan effort identical to the unconstrained solve.
#[test]
fn learnset_move_is_levelup_only() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe_with_learnset(gd);
    let lm = &gd.learnset(t)[0];
    let move_id = lm.waza_id.clone();
    let move_name = gd.active_skill(&move_id).map(|s| s.name.clone()).unwrap_or_else(|| move_id.clone());

    let pool = vec![owned(gd, 1, a, Gender::Female, &[], &[]), owned(gd, 2, b, Gender::Male, &[], &[])];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_moves = vec![move_id.clone()];

    let with = solve(gd, &spec, &pool, &owned_only());
    assert!(!with.is_empty(), "a learnset move imposes no breeding constraint");
    let plan = &with[0];
    assert!(plan.levelup_moves.contains(&move_name), "learnset move listed as levelup, got {:?}", plan.levelup_moves);
    assert!(plan.fruits.is_empty(), "no fruit needed for a learnset move");
    let mut inherited = Vec::new();
    collect_inherited(&plan.root, &mut inherited);
    assert!(inherited.is_empty(), "no move threaded for a learnset move");

    let plain = solve(gd, &TargetSpec::new(TargetPal::Species(t)), &pool, &owned_only());
    assert!(!plain.is_empty());
    assert!(
        (plan.total_time_secs - plain[0].total_time_secs).abs() < 1e-9,
        "a learnset move must not change effort"
    );
}

/// (f) Serde: a spec/config with the new move fields roundtrips, AND old payloads
/// WITHOUT the new fields still deserialize (serde `default` — backward compat).
#[test]
fn move_fields_roundtrip_and_backcompat() {
    // Roundtrip a spec carrying required_moves + a config carrying skill_fruit.
    let mut spec = TargetSpec::new(TargetPal::Species(3));
    spec.required_moves = vec!["AirCanon".into(), "Unique_SheepBall_Roll".into()];
    let spec_json = serde_json::to_string(&spec).unwrap();
    let spec_back: TargetSpec = serde_json::from_str(&spec_json).unwrap();
    assert_eq!(spec_back.required_moves, spec.required_moves);

    let cfg = SolverConfig { skill_fruit: Some(SkillFruitConfig { cost_secs: 321.0 }), ..owned_only() };
    let cfg_json = serde_json::to_string(&cfg).unwrap();
    let cfg_back: SolverConfig = serde_json::from_str(&cfg_json).unwrap();
    assert_eq!(cfg_back.skill_fruit.map(|f| f.cost_secs), Some(321.0));

    // OLD spec payload (no required_moves) deserializes to an empty Vec.
    let old_spec = r#"{"pal":{"Species":3},"required_passives":[],"optional_passives":[],
        "iv_hp":0,"iv_attack":0,"iv_defense":0,"required_gender":null,"max_irrelevant":1}"#;
    let s: TargetSpec = serde_json::from_str(old_spec).unwrap();
    assert!(s.required_moves.is_empty(), "missing required_moves defaults to empty");

    // OLD config payload (no skill_fruit) deserializes to None.
    let old_cfg = r#"{"max_breeding_steps":10,"max_solver_iterations":20,"max_wild_pals":10,
        "max_input_irrelevant_passives":3,"include_wild":false,"max_effort_secs":604800.0,
        "result_limit":3}"#;
    let c: SolverConfig = serde_json::from_str(old_cfg).unwrap();
    assert!(c.skill_fruit.is_none(), "missing skill_fruit defaults to None");

    // SkillFruitConfig serde default cost is 300.0.
    let f: SkillFruitConfig = serde_json::from_str("{}").unwrap();
    assert!((f.cost_secs - 300.0).abs() < 1e-9, "SkillFruitConfig default cost is 300.0");
}
