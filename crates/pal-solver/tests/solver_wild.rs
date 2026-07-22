//! Wild-pal seeding ("include pals I don't own"): owned-only vs `include_wild`.
//!
//! These exercise the full `solve` pipeline (probability model included) against
//! the embedded pack, driven by synthetic owned sets (never the real save).
//!
//! Diagnosis backdrop (see the slice report): every owned-only no-plan species
//! in the shipped data is a *self-pair-only breeder* — its only breeding recipe
//! is a same-species pair (`child_of(s, F, s, M) == s`). With no owned instance,
//! such a target is genuinely unreachable owned-only; `include_wild` unlocks it
//! by catching the pal directly (when wild-spawnable) or catching its catchable
//! parents and breeding (when not).

use pal_data::types::{ContainerKind, Gender, IvSet, OwnedPal};
use pal_data::GameData;
use pal_solver::solver::config::SolverConfig;
use pal_solver::solver::results::PlanSource;
use pal_solver::solver::spec::{TargetPal, TargetSpec};
use pal_solver::solver::{resolve_species, solve, PlanNode};

/// A synthetic owned pal of `species`/`gender`, no passives, level 1.
fn owned(gd: &GameData, species: u16, gender: Gender) -> OwnedPal {
    OwnedPal {
        instance_id: [0u8; 16],
        character_id: gd.species_at(species).unwrap().internal_name.clone(),
        is_boss: false,
        gender: Some(gender),
        level: 1,
        rank: 0,
        passives: vec![],
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

fn owned_only() -> SolverConfig {
    SolverConfig { include_wild: false, ..SolverConfig::default() }
}
fn with_wild() -> SolverConfig {
    SolverConfig { include_wild: true, ..SolverConfig::default() }
}

fn tally(node: &PlanNode, wild: &mut u32, bred: &mut u32, ownd: &mut u32) {
    match &node.source {
        PlanSource::Wild { .. } => *wild += 1,
        PlanSource::Bred => *bred += 1,
        PlanSource::Owned { .. } => *ownd += 1,
    }
    for c in &node.children {
        tally(c, wild, bred, ownd);
    }
}

fn catchable(gd: &GameData, s: u16) -> bool {
    gd.species_at(s).map(|x| x.wild_levels.0 > 0).unwrap_or(false)
}

/// (a) A self-pair-only legendary that is not owned has NO owned-only plan, but
/// `include_wild` reaches it. Jetragon is wild-catchable, so the optimal plan is
/// a single catch (strictly cheaper than catching two and breeding).
#[test]
fn jetragon_unreachable_owned_only_but_catchable_with_wild() {
    let gd = GameData::get();
    let jet = resolve_species(gd, "JetDragon").expect("Jetragon in pack");
    assert!(catchable(gd, jet), "Jetragon must be wild-spawnable for this test");
    // Sanity: Jetragon breeds only from a Jetragon pair.
    assert_eq!(
        gd.child_of(jet, Gender::Female, jet, Gender::Male),
        Some(jet),
        "Jetragon self-pair must yield Jetragon"
    );

    // A roster of common, non-Jetragon pals — no owned path can ever reach a
    // self-pair-only legendary.
    let lamball = resolve_species(gd, "SheepBall").or_else(|| resolve_species(gd, "Lamball"));
    let cattiva = resolve_species(gd, "PinkCat").or_else(|| resolve_species(gd, "Cattiva"));
    let mut roster = Vec::new();
    if let Some(s) = lamball {
        roster.push(owned(gd, s, Gender::Male));
        roster.push(owned(gd, s, Gender::Female));
    }
    if let Some(s) = cattiva {
        roster.push(owned(gd, s, Gender::Male));
        roster.push(owned(gd, s, Gender::Female));
    }

    let spec = TargetSpec::new(TargetPal::Species(jet));

    let owned_plans = solve(gd, &spec, &roster, &owned_only());
    assert!(
        owned_plans.is_empty(),
        "owned-only must find no Jetragon plan (self-pair-only, none owned)"
    );

    let wild_plans = solve(gd, &spec, &roster, &with_wild());
    assert!(!wild_plans.is_empty(), "include_wild must reach Jetragon");
    let best = &wild_plans[0];
    // Optimal is a single direct catch.
    match &best.root.source {
        PlanSource::Wild { captures, min_wild_level } => {
            assert_eq!(best.root.species, jet, "wild node is Jetragon");
            assert!(*captures >= 1, "at least one catch");
            assert_eq!(
                *min_wild_level as u8,
                gd.species_at(jet).unwrap().wild_levels.0,
                "min_wild_level surfaced from the pack"
            );
        }
        other => panic!("expected a direct wild catch for Jetragon, got {other:?}"),
    }
    assert_eq!(best.total_wild_pals, 1, "single catch uses one wild pal");
    assert_eq!(best.total_steps, 0, "single catch is zero breeding steps");
}

/// (b) A target reachable only via an intermediate bred pal from wild parents:
/// with an EMPTY owned set, `include_wild` must produce a catch->breed chain —
/// a bred root whose leaves are wild catches. Data-driven: we scan for the first
/// non-wild-catchable species that is breedable from two wild-catchable parents.
#[test]
fn wild_parents_breed_into_uncatchable_target() {
    let gd = GameData::get();
    let n = gd.species_count() as u16;
    let cfg = SolverConfig {
        include_wild: true,
        max_breeding_steps: 4,
        max_solver_iterations: 4,
        ..SolverConfig::default()
    };
    let no_pals: Vec<OwnedPal> = vec![];

    let mut proven = false;
    for t in 0..n {
        if catchable(gd, t) {
            continue; // catchable target => single catch dominates, no chain
        }
        // Must have at least one recipe from two catchable parents.
        let mut has_catchable_recipe = false;
        'r: for a in 0..n {
            for b in a..n {
                if gd.child_of(a, Gender::Female, b, Gender::Male) == Some(t)
                    && catchable(gd, a)
                    && catchable(gd, b)
                {
                    has_catchable_recipe = true;
                    break 'r;
                }
            }
        }
        if !has_catchable_recipe {
            continue;
        }

        let spec = TargetSpec::new(TargetPal::Species(t));
        // Owned-only with no pals can never reach it.
        assert!(
            solve(gd, &spec, &no_pals, &owned_only()).is_empty(),
            "owned-only (no pals) must yield no plan for species {t}"
        );

        let plans = solve(gd, &spec, &no_pals, &cfg);
        let Some(best) = plans.first() else { continue };
        let (mut w, mut b, mut o) = (0, 0, 0);
        tally(&best.root, &mut w, &mut b, &mut o);
        if matches!(best.root.source, PlanSource::Bred) && w >= 2 && b >= 1 {
            assert_eq!(o, 0, "no owned nodes when nothing is owned");
            assert!(best.total_steps >= 1, "a breed step is present");
            assert!(best.total_wild_pals >= 2, "chain catches >= 2 wild pals");
            proven = true;
            break;
        }
    }
    assert!(
        proven,
        "expected at least one non-catchable target breedable from wild parents (catch->breed chain)"
    );
}

/// (c) Self-pair sanity for the same-species-only legendaries: each breeds from
/// its own species pair. Guards the child-of index / gender handling that the
/// owned-only no-plan diagnosis rests on.
#[test]
fn legendary_self_pairs_breed_true() {
    let gd = GameData::get();
    for name in ["Jetragon", "Frostallion", "Paladius", "Necromus"] {
        let s = resolve_species(gd, name).unwrap_or_else(|| panic!("{name} in pack"));
        assert_eq!(
            gd.child_of(s, Gender::Female, s, Gender::Male),
            Some(s),
            "{name} self-pair (F x M) must breed {name}"
        );
        // Orientation-independent.
        assert_eq!(
            gd.child_of(s, Gender::Male, s, Gender::Female),
            Some(s),
            "{name} self-pair (M x F) must breed {name}"
        );
    }
}
