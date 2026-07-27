//! Gender-reverser tests: a pairing blocked ONLY because both parents share a
//! concrete gender becomes viable when `SolverConfig::gender_reverser` is set —
//! one parent is flipped (flagged `gender_reversed`), the step's effort gains
//! `cost_secs`, and the resolution is deterministic (no re-roll). Same-species /
//! no-recipe pairs the game forbids stay forbidden (the `child_of` gate). Drives
//! the full `solve` pipeline against the embedded pack with synthetic owned sets.

use pal_data::types::{ContainerKind, Gender, IvSet, OwnedPal};
use pal_data::GameData;
use pal_solver::solver::config::{GenderReverserConfig, SolverConfig};
use pal_solver::solver::results::PlanSource;
use pal_solver::solver::spec::{TargetPal, TargetSpec};
use pal_solver::solver::{resolve_species, solve, PlanNode};

/// A synthetic owned pal of `species`/`gender`, no passives, level 1.
fn owned(gd: &GameData, species: u16, gender: Gender) -> OwnedPal {
    OwnedPal {
        instance_id: [species as u8; 16],
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

/// The first cross-species recipe `(a, b) -> t` (three distinct species),
/// oriented `(a Female, b Male)`.
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

fn with_reverser(cost_secs: f64) -> SolverConfig {
    SolverConfig {
        gender_reverser: Some(GenderReverserConfig { cost_secs }),
        ..owned_only()
    }
}

/// Count `gender_reversed` flags across a plan tree.
fn count_reversed(node: &PlanNode) -> u32 {
    let mut n = if node.gender_reversed { 1 } else { 0 };
    for c in &node.children {
        n += count_reversed(c);
    }
    n
}

/// (e) A pool whose only viable recipe is blocked on gender (both parents male):
/// no plan without the reverser; WITH it a flagged plan appears, exactly one
/// parent is reversed, and the reverser cost is folded into the plan effort.
#[test]
fn same_gender_pair_needs_reverser() {
    let gd = GameData::get();
    let (a, b, t) = find_recipe(gd);
    // Own one male of each parent species: opposite-gender pairing impossible,
    // so `a + b -> t` (the only route to `t`) is gender-blocked.
    let pool = vec![owned(gd, a, Gender::Male), owned(gd, b, Gender::Male)];
    let spec = TargetSpec::new(TargetPal::Species(t));

    // No reverser: the same-gender pair cannot breed and `t` is unreachable.
    assert!(
        solve(gd, &spec, &pool, &owned_only()).is_empty(),
        "two males of distinct species cannot breed without a reverser"
    );

    // With the reverser: a plan appears, rooted at `t`, with exactly one parent
    // flipped.
    let plans = solve(gd, &spec, &pool, &with_reverser(300.0));
    assert!(!plans.is_empty(), "the reverser unblocks the same-gender pairing");
    let plan = &plans[0];
    assert_eq!(plan.root.species, t, "child_of gates the reversed pairing to the real recipe");
    assert!(matches!(plan.root.source, PlanSource::Bred));
    assert_eq!(plan.total_steps, 1);
    assert_eq!(count_reversed(&plan.root), 1, "exactly one parent is gender-reversed");
    // The reversed parent is a child (parent) node, never the root/target.
    assert!(!plan.root.gender_reversed, "the delivered target is not itself reversed");
    // The reversed parent now carries a concrete gender (deterministic, no re-roll).
    let reversed = plan
        .root
        .children
        .iter()
        .find(|c| c.gender_reversed)
        .expect("a reversed parent node");
    assert!(reversed.gender.is_some(), "a reversed parent resolves to a concrete gender");

    // Effort includes the reverser cost: same tree at cost 0 vs 300 differs by 300.
    let free = solve(gd, &spec, &pool, &with_reverser(0.0));
    assert!(!free.is_empty());
    let delta = plan.total_time_secs - free[0].total_time_secs;
    assert!((delta - 300.0).abs() < 1e-6, "reverser cost must be added to plan effort, got {delta}");
}

/// The reverser only unblocks GENDER: a target the pool cannot reach even with an
/// opposite-gender pair stays unreachable (the reverser fabricates no recipe).
#[test]
fn reverser_does_not_fabricate_recipes() {
    let gd = GameData::get();
    // A self-pair-only legendary is bred only from its own species pair, so NO
    // other species can reach it. Owning two males of unrelated common species
    // lets the reverser breed THEM together, but the child still cannot reach
    // Jetragon — the reverser unblocks gender, never invents a missing recipe.
    let jet = resolve_species(gd, "JetDragon").expect("Jetragon");
    let lamball = resolve_species(gd, "SheepBall")
        .or_else(|| resolve_species(gd, "Lamball"))
        .expect("a common filler species");
    let cattiva = resolve_species(gd, "PinkCat")
        .or_else(|| resolve_species(gd, "Cattiva"))
        .expect("a second common filler species");
    assert!(lamball != jet && cattiva != jet && lamball != cattiva);
    let pool = vec![owned(gd, lamball, Gender::Male), owned(gd, cattiva, Gender::Male)];
    let spec = TargetSpec::new(TargetPal::Species(jet));
    assert!(
        solve(gd, &spec, &pool, &with_reverser(300.0)).is_empty(),
        "the reverser cannot invent a path the breeding graph does not have"
    );
}
