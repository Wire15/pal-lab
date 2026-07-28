//! Surgery-table implant tests: the terminal, result-layer relaxation that lets
//! a plan cover up to `max_implants` missing REQUIRED passives from the surgery
//! table (`SolverConfig::surgery`). Surgery competes purely on effort — each
//! implant adds `cost_secs` to a plan's ranking effort — so a cheaper exact
//! breeding plan keeps priority. These drive the full `solve` pipeline against
//! the embedded pack with synthetic owned sets (never the real save), mirroring
//! the fixture conventions in `solver_wild.rs` / `solver_cakes.rs`.

use pal_data::types::{ContainerKind, Gender, IvSet, OwnedPal};
use pal_data::GameData;
use pal_solver::solver::config::{GenderReverserConfig, SolverConfig, SurgeryConfig};
use pal_solver::solver::results::PlanSource;
use pal_solver::solver::spec::{TargetPal, TargetSpec};
use pal_solver::solver::{diagnose_no_path, resolve_passive, resolve_species, solve, NoPathReason};

/// A synthetic owned pal of `species`/`gender` carrying `passives`, level 1.
fn owned(gd: &GameData, species: u16, gender: Gender, passives: &[&str]) -> OwnedPal {
    OwnedPal {
        instance_id: [species as u8; 16],
        character_id: gd.species_at(species).unwrap().internal_name.clone(),
        is_boss: false,
        is_lucky: false,
        gender: Some(gender),
        level: 1,
        rank: 0,
        passives: passives.iter().map(|p| p.to_string()).collect(),
        active_skills: vec![],
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
/// gender-oriented `(a Female, b Male)` so an owned pair in that orientation
/// breeds into `t`. Mirrors `solver_wild`/`diagnose`'s `find_recipe`.
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

fn owned_only() -> SolverConfig {
    SolverConfig { include_wild: false, ..SolverConfig::default() }
}

/// Owned-only config with the surgery table enabled.
fn with_surgery(max_implants: u8, cost_secs: f64) -> SolverConfig {
    SolverConfig {
        surgery: Some(SurgeryConfig { max_implants, cost_secs }),
        ..owned_only()
    }
}

/// (a) A required passive NO pool member carries: no plan without surgery
/// (MissingPassiveCarrier), and WITH surgery a one-step plan whose sole implant
/// is exactly that passive, with the implant cost folded into the plan effort.
#[test]
fn missing_passive_becomes_implant() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    let swift = resolve_passive(gd, "Swift").expect("Swift resolves");
    // Own the breeding pair (opposite genders), neither carrying Swift.
    let pool = vec![owned(gd, a, Gender::Female, &[]), owned(gd, b, Gender::Male, &[])];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_passives = vec![swift.clone()];

    // No surgery: unreachable (no carrier), diagnosed as MissingPassiveCarrier.
    let off = solve(gd, &spec, &pool, &owned_only());
    assert!(off.is_empty(), "no exact plan can inherit a passive no pal carries");
    let reasons = diagnose_no_path(gd, &spec, &pool, &owned_only());
    assert!(
        reasons.iter().any(|r| matches!(
            r,
            NoPathReason::MissingPassiveCarrier { passive_id, surgery_off: true, .. } if *passive_id == swift
        )),
        "surgery-off missing carrier must flag surgery_off, got {reasons:?}"
    );

    // With surgery (1 implant): a plan exists; the bred target is implanted with
    // exactly Swift, which surfaces both in the surgery list and the root slots.
    let on = solve(gd, &spec, &pool, &with_surgery(1, 600.0));
    assert!(!on.is_empty(), "surgery must cover the single missing passive");
    let plan = &on[0];
    assert_eq!(plan.total_steps, 1, "one breeding step (the target)");
    assert_eq!(plan.surgery.len(), 1, "exactly one implant");
    assert_eq!(plan.surgery[0].passive_id, swift, "implant is the missing passive");
    assert!((plan.surgery[0].cost_secs - 600.0).abs() < 1e-9);
    assert!(plan.root.passives.contains(&swift), "implanted passive appears in the root slots");
    assert!(matches!(plan.root.source, PlanSource::Bred));

    // Effort includes the implant cost: the same bred tree at cost 0 vs 600
    // differs by exactly the one implant's cost.
    let free = solve(gd, &spec, &pool, &with_surgery(1, 0.0));
    assert!(!free.is_empty());
    let delta = plan.total_time_secs - free[0].total_time_secs;
    assert!((delta - 600.0).abs() < 1e-6, "implant cost must be added to plan effort, got {delta}");
}

/// (b) Zero-step case: an owned target-species pal missing one required passive
/// is a valid plan on its own — 0 breeding steps + 1 implant.
#[test]
fn owned_target_zero_step_implant() {
    let gd = GameData::get();
    // A self-pair-only legendary is a clean single owned instance of the target.
    let t = resolve_species(gd, "JetDragon").expect("Jetragon in pack");
    let swift = resolve_passive(gd, "Swift").expect("Swift resolves");
    let pool = vec![owned(gd, t, Gender::Male, &[])];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_passives = vec![swift.clone()];

    // Without surgery the lone owned pal lacks Swift and cannot breed (no pair).
    assert!(solve(gd, &spec, &pool, &owned_only()).is_empty());

    let on = solve(gd, &spec, &pool, &with_surgery(1, 300.0));
    assert!(!on.is_empty(), "the owned pal is deliverable with one implant");
    let plan = &on[0];
    assert_eq!(plan.total_steps, 0, "no breeding — the owned pal IS the target");
    assert!(matches!(plan.root.source, PlanSource::Owned { .. }));
    assert_eq!(plan.surgery.len(), 1);
    assert_eq!(plan.surgery[0].passive_id, swift);
    assert!((plan.total_time_secs - 300.0).abs() < 1e-9, "0 breeding effort + one implant cost");
}

/// (c) More missing passives than `max_implants` stays unreachable.
#[test]
fn too_many_missing_stays_no_path() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    let swift = resolve_passive(gd, "Swift").expect("Swift");
    let runner = resolve_passive(gd, "Runner").expect("Runner");
    assert_ne!(swift, runner, "distinct passives");
    let pool = vec![owned(gd, a, Gender::Female, &[]), owned(gd, b, Gender::Male, &[])];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_passives = vec![swift, runner];

    // Two required passives, no carriers, only one implant allowed -> no plan.
    let on = solve(gd, &spec, &pool, &with_surgery(1, 600.0));
    assert!(on.is_empty(), "k=2 missing exceeds max_implants=1");
    // Raising the cap to cover both unblocks it (sanity that the gap is exactly 2).
    let two = solve(gd, &spec, &pool, &with_surgery(2, 600.0));
    assert!(!two.is_empty(), "max_implants=2 covers both missing passives");
    assert_eq!(two[0].surgery.len(), 2);
}

/// (d) When both an exact plan and a surgery plan exist, ranking is pure effort:
/// a costly implant lets the exact (bred-in) plan win; a free implant lets the
/// cheaper surgery plan win. Exact keeps priority only when it is cheaper.
#[test]
fn exact_beats_surgery_when_cheaper() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    let swift = resolve_passive(gd, "Swift").expect("Swift");
    // Pool: the breeding pair (with `a` carrying Swift by internal id, so an
    // exact "breed Swift in" plan exists) PLUS an owned target instance with no
    // passives (so a 0-step "own it + implant Swift" surgery plan also exists).
    let pool = vec![
        owned(gd, a, Gender::Female, &[swift.as_str()]),
        owned(gd, b, Gender::Male, &[]),
        owned(gd, t, Gender::Male, &[]),
    ];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_passives = vec![swift.clone()];

    // Expensive implant: the exact bred plan (Swift inherited, no surgery) beats
    // the costly implant, so it keeps priority.
    let costly = solve(gd, &spec, &pool, &with_surgery(1, 1.0e9));
    assert!(!costly.is_empty());
    assert!(costly[0].surgery.is_empty(), "a costly implant must not displace the exact plan");
    assert!(costly[0].root.passives.contains(&swift), "exact plan breeds Swift onto the target");

    // Free implant: implanting Swift onto the already-owned target is a 0-step,
    // zero-effort plan that undercuts breeding — surgery competes purely on effort.
    let free = solve(gd, &spec, &pool, &with_surgery(1, 0.0));
    assert!(!free.is_empty());
    assert_eq!(free[0].surgery.len(), 1, "a free implant makes the surgery plan cheapest");
    assert_eq!(free[0].total_steps, 0, "the cheapest surgery plan implants onto the owned target");
}

/// (f) Both relaxations OFF => byte-identical serialization to the pre-feature
/// output. Reuses the `solver_serde` hand-built plan and proves the new
/// `surgery` / `gender_reversed` fields never appear when unused.
#[test]
fn both_off_serialization_is_byte_identical() {
    use pal_data::types::Gender as G;
    use pal_solver::solver::config::BreedingSetup;
    use pal_solver::solver::refs::{
        BredPalRef, EffPassive, OwnedInstance, OwnedPalRef, PalRef, SolverIvSet, WildPalRef,
    };
    use pal_solver::solver::results::{BreedingPlan, SolvedRef};
    use pal_solver::solver::CakeKind;

    let gd = GameData::get();
    let owned = PalRef::Owned(OwnedPalRef {
        species: 1,
        gender: G::Male.into(),
        effective_passives: vec![EffPassive::Desired("Swift".into())],
        ivs: SolverIvSet::RANDOM,
        primary: OwnedInstance {
            instance_id: [1u8; 16],
            gender: G::Male,
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

    // The exact-satisfaction plan (no surgery, no reversed parent) must serialize
    // exactly as `from_ref` did before the feature — the new fields are skipped.
    let base = BreedingPlan::from_ref(gd, &bred, CakeKind::Normal, [0, 0, 0]);
    let solved = BreedingPlan::from_solved(gd, &SolvedRef::exact(bred.clone()), CakeKind::Normal, [0, 0, 0]);
    let base_json = serde_json::to_string(&base).expect("serialize base");
    let solved_json = serde_json::to_string(&solved).expect("serialize solved");
    assert_eq!(base_json, solved_json, "exact SolvedRef serializes identically to from_ref");
    assert!(!base_json.contains("surgery"), "no surgery key when unused: {base_json}");
    assert!(!base_json.contains("gender_reversed"), "no gender_reversed key when unused");

    // And the default config really leaves both relaxations off.
    let cfg = SolverConfig::default();
    assert!(cfg.surgery.is_none());
    assert!(cfg.gender_reverser.is_none());
    let _ = GenderReverserConfig { cost_secs: 0.0 };
}

/// Special lottery-tier passives (Rainbow/WorldTree) are refused by the in-game
/// surgery table: surgery must NOT claim to cover them, and the no-path
/// diagnosis must not suggest enabling surgery for them (`surgery_off: false`).
#[test]
fn special_tier_passives_are_unimplantable() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    let special = gd
        .passives()
        .iter()
        .find(|p| p.tier.is_some() && p.pal_facing)
        .expect("pack carries at least one special-tier (Rainbow/WorldTree) passive");
    let pool = vec![owned(gd, a, Gender::Female, &[]), owned(gd, b, Gender::Male, &[])];
    let mut spec = TargetSpec::new(TargetPal::Species(t));
    spec.required_passives = vec![special.internal_name.clone()];

    // Surgery ON with headroom: still no plan — the tier is not implantable.
    let on = solve(gd, &spec, &pool, &with_surgery(4, 0.0));
    assert!(on.is_empty(), "surgery must not cover a special-tier passive");

    // Diagnosis keeps the carrier blocker and never suggests the dead remedy,
    // with surgery on OR off.
    for cfg in [with_surgery(4, 0.0), owned_only()] {
        let reasons = diagnose_no_path(gd, &spec, &pool, &cfg);
        assert!(
            reasons.iter().any(|r| matches!(
                r,
                NoPathReason::MissingPassiveCarrier { passive_id, surgery_off: false, .. }
                    if *passive_id == special.internal_name
            )),
            "special-tier carrier blocker must persist with surgery_off:false, got {reasons:?}"
        );
    }
}
