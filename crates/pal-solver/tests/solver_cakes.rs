//! Cake-aware breeding tests.
//!
//! Cake effects are code-verified from `DA_BreedingItemEffectData` (datamined in
//! palcalc #208): Special forces the direct-inherit passive roll to 4, Vegetable
//! doubles eggs per cycle (halving breeding time), Mushroom/DeluxeVegetable raise
//! the offspring IV floor. DeluxeVegetable's mutation bonus is deliberately
//! ignored (outcomes out of scope). See `solver::config::CakeKind`.
//!
//! Expected probabilities are hand-derived term-by-term from the shipped weight
//! arrays ([4,3,2,1] passive-inherit -> 40/30/20/10%, same for random-add), the
//! same independent derivation the oracle suite pins the base functions against.

use std::path::PathBuf;

use pal_data::types::{ContainerKind, Gender};
use pal_data::{GameData, InheritanceWeights};
use pal_solver::probabilities::{
    prob_inherited_target_ivs, prob_inherited_target_passives,
    prob_inherited_target_passives_forced,
};
use pal_solver::solver::config::{BreedingSetup, CakeKind, SolverConfig};
use pal_solver::solver::refs::{
    incubation_secs, BredPalRef, OwnedInstance, OwnedPalRef, PalRef, SolverIvSet,
    AVG_BREEDING_TIME_SECS, DEFAULT_EGG_HATCH_HOURS,
};
use pal_solver::solver::results::BreedingPlan;
use pal_solver::solver::spec::{TargetPal, TargetSpec};
use pal_solver::solver::{resolve_passive, resolve_species, solve};

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * b.abs().max(1.0)
}

fn owned_ref(species: u16, gender: Gender) -> PalRef {
    PalRef::Owned(OwnedPalRef {
        species,
        gender: gender.into(),
        effective_passives: vec![],
        ivs: SolverIvSet::RANDOM,
        primary: OwnedInstance {
            instance_id: [species as u8; 16],
            gender,
            container: ContainerKind::Palbox,
            real_passives: vec![],
            ivs: SolverIvSet::RANDOM,
        },
        alt: None,
    })
}

/// A bred ref with owned (zero-effort) parents so `total_effort == self_effort`.
fn bred(gd: &GameData, passives_prob: f64) -> BredPalRef {
    bred_egg(gd, passives_prob, 1.0)
}

/// As [`bred`], but with a cake egg multiplier applied at construction.
fn bred_egg(gd: &GameData, passives_prob: f64, egg_mult: f64) -> BredPalRef {
    BredPalRef::new(
        gd,
        0,
        owned_ref(1, Gender::Male),
        owned_ref(2, Gender::Female),
        vec![],
        passives_prob,
        SolverIvSet::RANDOM,
        1.0,
        &BreedingSetup::default(),
        egg_mult,
    )
}

// ---- 1. Special forces the direct-inherit roll to 4 --------------------------

#[test]
fn special_forces_four_passive_inheritance() {
    let w = InheritanceWeights::default();

    // Pool of exactly 4, all 4 desired, child keeps all 4. Baseline: only the
    // 10% "inherit 4 directly" roll works, times the 0-random fill (which at the
    // 4-slot cap is `random_at_least(0)` = 1.0). Forced: X is 4 with certainty,
    // and the one size-4 subset IS the desired set -> 1.0.
    let base = prob_inherited_target_passives(4, 4, 4, &w);
    let forced = prob_inherited_target_passives_forced(4, 4, 4, &w);
    assert!(close(base, 0.10), "baseline P(4-of-4) = 0.10, got {base}");
    assert!(close(forced, 1.0), "Special P(4-of-4) = 1.0, got {forced}");
    // The 10% four-passive ceiling becomes 100% — a 10x lever.
    assert!(close(forced / base, 10.0));

    // Pool 4, only 2 desired, child fills to 4 slots. Baseline sums three
    // direct-roll terms (0.015 + 0.06 + 0.10 = 0.175); forced guarantees the two
    // desired are among the 4 inherited -> 1.0.
    let base2 = prob_inherited_target_passives(4, 2, 4, &w);
    let forced2 = prob_inherited_target_passives_forced(4, 2, 4, &w);
    assert!(close(base2, 0.175), "baseline P(2-of-4, final 4) = 0.175, got {base2}");
    assert!(close(forced2, 1.0), "Special P(2-of-4, final 4) = 1.0, got {forced2}");

    // Forcing X=4 means the child ALWAYS ends with min(4, pool) passives, so a
    // request for only 2 final slots (pool 4) is impossible under Special.
    let base3 = prob_inherited_target_passives(4, 2, 2, &w);
    let forced3 = prob_inherited_target_passives_forced(4, 2, 2, &w);
    assert!(close(base3, 0.02), "baseline P(2-of-4, final 2) = 0.02, got {base3}");
    assert!(close(forced3, 0.0), "Special cannot leave only 2 slots from a pool of 4");

    // A pool smaller than 4 clamps the forced roll to the pool size.
    // Pool 2, both desired, final 2: forced inherits both with certainty, then
    // the 0-random fill (final < 4 cap) is exactly `random(0)` = 0.40.
    let forced4 = prob_inherited_target_passives_forced(2, 2, 2, &w);
    assert!(close(forced4, 0.40), "Special P(2-of-2, final 2) = 0.40, got {forced4}");
}

// ---- 2. Vegetable halves the breeding-time component -------------------------

#[test]
fn vegetable_halves_breeding_time() {
    let gd = GameData::get();
    // passives_prob 0.5, ivs 1.0 -> avg 2 breedings.
    let normal = bred(gd, 0.5);
    assert_eq!(normal.avg_required_breedings, 2);
    let veg = bred_egg(gd, 0.5, CakeKind::Vegetable.egg_multiplier());

    let incubation =
        incubation_secs(gd.species_at(0).unwrap().rarity, DEFAULT_EGG_HATCH_HOURS * 3600.0);
    // Only the breeding-time term divides by 2; incubation (added once with
    // MultipleIncubators) is unchanged.
    let normal_breeding = normal.self_effort - incubation;
    let veg_breeding = veg.self_effort - incubation;
    assert!(close(veg_breeding, normal_breeding / 2.0), "breeding time must halve");
    assert!(close(normal_breeding, 2.0 * AVG_BREEDING_TIME_SECS));
    assert!(close(veg_breeding, AVG_BREEDING_TIME_SECS));
    // Parents are owned (zero effort) so total == self.
    assert!(close(veg.total_effort, veg.self_effort));
    assert!(veg.total_effort < normal.total_effort);

    // DeluxeVegetable shares BreedCount=2.
    assert_eq!(CakeKind::DeluxeVegetable.egg_multiplier(), 2.0);
    // Non-egg cakes leave time untouched.
    for k in [CakeKind::Normal, CakeKind::Mushroom, CakeKind::Special] {
        assert_eq!(k.egg_multiplier(), 1.0);
    }
}

// ---- 3. Mushroom raises the IV pass-rate ------------------------------------

#[test]
fn mushroom_raises_iv_pass_rate() {
    let w = InheritanceWeights::default();

    // Only Mushroom/DeluxeVegetable bump the IV floor (by TalentBonusMax = 5).
    assert_eq!(CakeKind::Mushroom.iv_floor_bonus(), 5);
    assert_eq!(CakeKind::DeluxeVegetable.iv_floor_bonus(), 5);
    for k in [CakeKind::Normal, CakeKind::Vegetable, CakeKind::Special] {
        assert_eq!(k.iv_floor_bonus(), 0);
    }

    // A spec asking for a low IV floor (<= the bonus) plus a high one.
    let mut spec = TargetSpec::new(TargetPal::Species(0));
    spec.iv_hp = 5;
    spec.iv_attack = 3;
    spec.iv_defense = 60;

    // Normal cake leaves thresholds untouched.
    let mut normal_spec = spec.clone();
    CakeKind::Normal.apply_iv_floor(&mut normal_spec);
    assert_eq!((normal_spec.iv_hp, normal_spec.iv_attack, normal_spec.iv_defense), (5, 3, 60));

    // Mushroom lowers every threshold by 5: the two low IVs become "don't care",
    // the high one is merely eased.
    let mut mushroom_spec = spec.clone();
    CakeKind::Mushroom.apply_iv_floor(&mut mushroom_spec);
    assert_eq!((mushroom_spec.iv_hp, mushroom_spec.iv_attack, mushroom_spec.iv_defense), (0, 0, 55));

    // Pass-rate: with one IV category still required the child must inherit it
    // (P = 0.5833); once the floor covers the low targets that category drops
    // out and the pass-rate for THOSE targets rises to certainty.
    let before = prob_inherited_target_ivs(1, 0, &w);
    let after = prob_inherited_target_ivs(0, 0, &w);
    assert!(close(before, 7.0 / 12.0), "1-required IV pass-rate = 0.5833, got {before}");
    assert!(close(after, 1.0));
    assert!(after > before, "Mushroom's IV floor must raise the pass-rate");
}

// ---- 4. Normal cake is inert (identical to the pre-cake path) ----------------

#[test]
fn normal_cake_is_inert() {
    let gd = GameData::get();
    assert_eq!(CakeKind::default(), CakeKind::Normal);
    assert_eq!(SolverConfig::default().cake, CakeKind::Normal);

    assert!(!CakeKind::Normal.forces_all_passives());
    assert_eq!(CakeKind::Normal.egg_multiplier(), 1.0);
    assert_eq!(CakeKind::Normal.iv_floor_bonus(), 0);
    assert!(!CakeKind::Normal.consumes_cakes());
    assert!(CakeKind::Special.consumes_cakes());

    // A Normal-cake plan reports zero cakes; a bred ref built the vanilla way
    // has an egg multiplier of 1.0.
    let r = PalRef::Bred(Box::new(bred(gd, 0.25)));
    let plan = BreedingPlan::from_ref(gd, &r, CakeKind::Normal);
    assert_eq!(plan.cake, CakeKind::Normal);
    assert_eq!(plan.cake_count, 0);
}

// ---- 5. Cake-count is the summed per-node attempts estimate ------------------

#[test]
fn cake_count_sums_breeding_attempts() {
    let gd = GameData::get();
    // avg = ceil(1/0.25) = 4 breedings.
    let child = bred(gd, 0.25);
    assert_eq!(child.avg_required_breedings, 4);
    // Normal/Special: one egg per cycle -> 4 attempts. Vegetable: 2 eggs -> 2.
    assert_eq!(child.attempts_estimate(), 4);
    assert_eq!(bred_egg(gd, 0.25, 2.0).attempts_estimate(), 2);

    // A one-step plan needs `attempts` cakes when a cake is used.
    let r = PalRef::Bred(Box::new(child));
    assert_eq!(BreedingPlan::from_ref(gd, &r, CakeKind::Special).cake_count, 4);
    assert_eq!(BreedingPlan::from_ref(gd, &r, CakeKind::Normal).cake_count, 0);

    // Infeasible ref (prob 0) contributes no finite attempts.
    let dead = PalRef::Bred(Box::new(bred(gd, 0.0)));
    assert_eq!(BreedingPlan::from_ref(gd, &dead, CakeKind::Special).cake_count, 0);
}

// ---- 6. CLI cake-kind parsing -----------------------------------------------

#[test]
fn cake_kind_parses_from_str() {
    assert_eq!("normal".parse::<CakeKind>().unwrap(), CakeKind::Normal);
    assert_eq!("mushroom".parse::<CakeKind>().unwrap(), CakeKind::Mushroom);
    assert_eq!("vegetable".parse::<CakeKind>().unwrap(), CakeKind::Vegetable);
    assert_eq!("veg".parse::<CakeKind>().unwrap(), CakeKind::Vegetable);
    assert_eq!("deluxe".parse::<CakeKind>().unwrap(), CakeKind::DeluxeVegetable);
    assert_eq!("Deluxe-Vegetable".parse::<CakeKind>().unwrap(), CakeKind::DeluxeVegetable);
    assert_eq!("SPECIAL".parse::<CakeKind>().unwrap(), CakeKind::Special);
    assert!("bogus".parse::<CakeKind>().is_err());
}

// ---- 7. Golden plan on the testdata save + Special-cake collapse -------------

/// Path to the reference save (gitignored). Skips gracefully when absent so CI
/// without the save stays green.
fn testdata_save() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58");
    p.is_dir().then_some(p)
}

#[test]
fn golden_normal_plan_and_special_collapse() {
    let Some(save_dir) = testdata_save() else {
        eprintln!("golden_normal_plan_and_special_collapse: testdata save absent, skipping");
        return;
    };
    let gd = GameData::get();
    let save = pal_save::read_save_dir(&save_dir).expect("read testdata save");

    let anubis = resolve_species(gd, "Anubis").expect("Anubis");
    let swift = resolve_passive(gd, "Swift").expect("Swift");
    let runner = resolve_passive(gd, "Runner").expect("Runner");
    let mut spec = TargetSpec::new(TargetPal::Species(anubis));
    spec.required_passives = vec![swift, runner];

    // Golden: Normal cake, no wild pals (deterministic min-effort plan). Pin the
    // world egg-hatch time to 2h via BreedingSetup so the golden effort is
    // calibrated in the original regime (independent of the 72h vanilla default)
    // — this also exercises setup threading through a full solve.
    let regime = BreedingSetup { egg_hatch_hours: 2.0, ..BreedingSetup::default() };
    let normal_cfg =
        SolverConfig { include_wild: false, setup: regime, ..SolverConfig::default() };
    let normal = solve(gd, &spec, &save.pals, &normal_cfg);
    assert!(!normal.is_empty(), "Normal cake must find a plan");
    let n0 = &normal[0];
    // Pinned golden: 7-step, ~9h20m (33600s) best plan at the 2h hatch regime.
    assert_eq!(n0.total_steps, 7, "golden step count");
    assert!(
        (n0.total_time_secs - 33_600.0).abs() < 120.0,
        "golden best time ~9h20m, got {}s",
        n0.total_time_secs
    );
    assert_eq!(n0.cake_count, 0, "Normal cake consumes no cakes");

    // Solving twice yields the same best-plan effort (deterministic).
    let normal2 = solve(gd, &spec, &save.pals, &normal_cfg);
    assert!(close(normal2[0].total_time_secs, n0.total_time_secs));

    // Special cake: forces X=4, collapsing the multi-passive path. The best
    // plan's root success probability jumps to the ceiling and the plan reports
    // the cakes it needs.
    let special_cfg = SolverConfig {
        cake: CakeKind::Special,
        include_wild: false,
        setup: regime,
        ..SolverConfig::default()
    };
    let special = solve(gd, &spec, &save.pals, &special_cfg);
    assert!(!special.is_empty(), "Special cake must find a plan");
    let s0 = &special[0];
    assert!(s0.cake_count > 0, "Special cake consumes cakes");
    assert!(
        s0.root.probability > n0.root.probability,
        "Special must raise the root success probability: {} vs {}",
        s0.root.probability,
        n0.root.probability
    );
    // Special is never slower than the vanilla path.
    assert!(s0.total_time_secs <= n0.total_time_secs + 1.0);

    eprintln!(
        "golden Anubis[Swift,Runner]: Normal {:.0}s p={:.4} steps={} | Special {:.0}s p={:.4} steps={} cakes~{}",
        n0.total_time_secs,
        n0.root.probability,
        n0.total_steps,
        s0.total_time_secs,
        s0.root.probability,
        s0.total_steps,
        s0.cake_count
    );
}
