//! Memory/latency safeguards in the breeding search (Wave: OOM fix):
//!   (a) the plan-step reachability prune in `breed_pair`,
//!   (b) the wall-clock search budget (`SolverConfig::search_budget_secs` ->
//!       `ModeResult::truncated`),
//!   (c) determinism of the per-chunk reduction.
//!
//! All fixtures are synthetic owned sets over the embedded pack (never a real
//! save); species/target triples are discovered from the pack's breeding graph
//! so the tests stay valid as data evolves.

use pal_data::gamedata::UNREACHABLE;
use pal_data::types::{ContainerKind, Gender, IvSet, OwnedPal};
use pal_data::GameData;
use pal_solver::solver::config::SolverConfig;
use pal_solver::solver::results::PlanNode;
use pal_solver::solver::spec::{TargetPal, TargetSpec};
use pal_solver::solver::{solve_with_catching, Catching};

/// A synthetic owned pal of `species`/`gender`, no passives, level 1.
fn owned(gd: &GameData, species: u16, gender: Gender) -> OwnedPal {
    OwnedPal {
        instance_id: [0u8; 16],
        character_id: gd.species_at(species).unwrap().internal_name.clone(),
        is_boss: false,
        is_lucky: false,
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

/// Both genders of every species in `roster` (so the solver can pair freely).
fn pool_both(gd: &GameData, roster: &[u16]) -> Vec<OwnedPal> {
    roster
        .iter()
        .flat_map(|&s| [owned(gd, s, Gender::Male), owned(gd, s, Gender::Female)])
        .collect()
}

fn collect_species(node: &PlanNode, out: &mut Vec<u16>) {
    out.push(node.species);
    for c in &node.children {
        collect_species(c, out);
    }
}

/// Find `(a, b, target)` such that `a x b -> c` and `c x {a|b|c} -> target`
/// (a genuine 2-step chain), where `target` is NOT directly breedable from
/// `{a, b}` in a single step (so the minimal path is 2 breeding steps).
fn two_step_fixture(gd: &GameData) -> Option<(u16, u16, u16)> {
    let n = gd.species_count() as u16;
    let orient = [(Gender::Male, Gender::Female), (Gender::Female, Gender::Male)];
    for a in 0..n {
        for b in a..n {
            let c = match gd.child_of(a, Gender::Male, b, Gender::Female) {
                Some(c) if c != a && c != b => c,
                _ => continue,
            };
            for &d in &[a, b, c] {
                for &(ga, gb) in &orient {
                    let t = match gd.child_of(c, ga, d, gb) {
                        Some(t) if t != a && t != b && t != c => t,
                        _ => continue,
                    };
                    // Reject targets reachable from {a, b} in one step.
                    let direct = [(a, a), (a, b), (b, b)].iter().any(|&(x, y)| {
                        orient
                            .iter()
                            .any(|&(gx, gy)| gd.child_of(x, gx, y, gy) == Some(t))
                    });
                    if !direct {
                        return Some((a, b, t));
                    }
                }
            }
        }
    }
    None
}

/// A species breedable directly from `pool` but graph-unreachable to `target`
/// (so the reachability prune must exclude it from every plan).
fn far_breedable_child(gd: &GameData, pool: &[u16], target: u16) -> Option<u16> {
    for &p in pool {
        for &q in pool {
            if let Some(c) = gd.child_of(p, Gender::Male, q, Gender::Female) {
                if c != target && gd.min_steps(c, target) == UNREACHABLE {
                    return Some(c);
                }
            }
        }
    }
    None
}

/// (a) The reachability prune excludes breedable-but-too-far children while the
/// in-budget path to the target is still found, and every surviving plan node
/// respects the step budget.
#[test]
fn reachability_prune_keeps_in_budget_path_drops_far_children() {
    let gd = GameData::get();
    let (a, b, target) = two_step_fixture(gd).expect("pack has a 2-step breeding chain");
    let roster = pool_both(gd, &[a, b]);
    let spec = TargetSpec::new(TargetPal::Species(target));

    // max_breeding_steps == 2: exactly the chain length. The prune is at its
    // tightest, yet the 2-step path must survive.
    let cfg = SolverConfig {
        include_wild: false,
        max_breeding_steps: 2,
        search_budget_secs: 0.0, // unlimited — isolate the reachability prune
        ..Default::default()
    };
    let res = solve_with_catching(gd, &spec, &roster, &cfg, Catching::BreedingOnly);

    assert!(!res.truncated, "unlimited budget must not truncate");
    assert!(!res.plans.is_empty(), "the in-budget 2-step path must be found");
    assert_eq!(res.plans[0].root.species, target, "best plan produces the target");

    // Invariant guaranteed by the prune: every node species is reachable to the
    // target within the step budget, and no plan exceeds it.
    for p in &res.plans {
        assert!(p.total_steps <= cfg.max_breeding_steps, "plan within step budget");
        let mut species = Vec::new();
        collect_species(&p.root, &mut species);
        for s in species {
            assert!(
                (gd.min_steps(s, target) as u32) <= cfg.max_breeding_steps,
                "node species {s} must be within the reachability budget of the target",
            );
        }
    }

    // A breedable-but-unreachable child must never appear in a plan.
    if let Some(x) = far_breedable_child(gd, &[a, b], target) {
        for p in &res.plans {
            let mut species = Vec::new();
            collect_species(&p.root, &mut species);
            assert!(
                !species.contains(&x),
                "breedable-but-too-far child {x} must be pruned from every plan",
            );
        }
    }
}

/// (b) A tiny wall-clock budget truncates a multi-step search (setting
/// `truncated`) without panicking; an in-budget solve of the same problem
/// finishes with `truncated == false`.
#[test]
fn search_budget_truncates_tiny_and_not_when_ample() {
    let gd = GameData::get();
    let (a, b, target) = two_step_fixture(gd).expect("pack has a 2-step breeding chain");
    let roster = pool_both(gd, &[a, b]);
    let spec = TargetSpec::new(TargetPal::Species(target));

    let tiny = SolverConfig {
        include_wild: false,
        max_breeding_steps: 3,
        max_solver_iterations: 6,
        search_budget_secs: 1e-9,
        ..Default::default()
    };
    let truncated = solve_with_catching(gd, &spec, &roster, &tiny, Catching::BreedingOnly);
    assert!(truncated.truncated, "a 1e-9s budget must truncate a multi-step search");

    let ample = SolverConfig {
        search_budget_secs: 120.0,
        ..tiny.clone()
    };
    let done = solve_with_catching(gd, &spec, &roster, &ample, Catching::BreedingOnly);
    assert!(!done.truncated, "an in-budget solve must not be truncated");
    assert!(!done.plans.is_empty(), "the target is reachable within the budget");
}

/// (c) The per-chunk reduction is deterministic: repeated solves of the same
/// synthetic problem yield an identical plan set. Because each chunk is folded
/// into the step's working set in pair-lexicographic order (identical to a
/// single reduction over the concatenated chunks), the optimization result is
/// stable across runs.
///
/// NOTE: the *exact tree* chosen among plans tied on effort depends on
/// `WorkingSet` (HashMap) iteration order, which is randomized per process and
/// orthogonal to this change — so the fixture compares each plan's value +
/// species-multiset signature (which the per-chunk reduction fully determines),
/// not the concrete owned-instance parents of a tie. `result_limit` is
/// unbounded so no top-N boundary tie can mask a difference.
#[test]
fn per_chunk_reduction_is_deterministic() {
    let gd = GameData::get();
    let (a, b, target) = two_step_fixture(gd).expect("pack has a 2-step breeding chain");
    let roster = pool_both(gd, &[a, b]);
    let spec = TargetSpec::new(TargetPal::Species(target));

    let cfg = SolverConfig {
        include_wild: false,
        max_breeding_steps: 3,
        max_solver_iterations: 6,
        result_limit: usize::MAX, // keep every distinct plan — no boundary tie
        search_budget_secs: 0.0,  // unlimited — determinism, not truncation
        ..Default::default()
    };

    // Per-plan signature the per-chunk reduction fully determines: sorted node
    // species multiset + total steps + wild count + effort bits. Sorted across
    // plans so returned-order ties (also HashMap-driven) do not matter.
    let run = || {
        let r = solve_with_catching(gd, &spec, &roster, &cfg, Catching::BreedingOnly);
        assert!(!r.truncated, "unlimited budget must not truncate");
        let mut sigs: Vec<(Vec<u16>, u32, u32, u64)> = r
            .plans
            .iter()
            .map(|p| {
                let mut species = Vec::new();
                collect_species(&p.root, &mut species);
                species.sort_unstable();
                (species, p.total_steps, p.total_wild_pals, p.total_time_secs.to_bits())
            })
            .collect();
        sigs.sort();
        sigs
    };

    let fixture = run();
    assert!(!fixture.is_empty(), "solve must yield plans");
    for _ in 0..2 {
        assert_eq!(run(), fixture, "per-chunk reduction must be value-deterministic");
    }
}
