//! The breeding search: build an initial working set from owned (+ wild) pals,
//! then iteratively breed all cross pairs, keeping the cheapest instance of each
//! distinct pal, until no new optimal pal appears or the iteration budget is hit.
//!
//! Ported from palcalc `BreedingSolver` + `BreedingBatchSolver`. Concurrency uses
//! rayon over the pair batch on plain owned data — no object pools or manual
//! threads (palcalc fights the C# GC; Rust does not need to).
//!
//! This is the ONLY module that calls [`crate::probabilities`]; those bodies are
//! `todo!()` until the sibling slice lands, so [`solve`] must not be run under
//! unit tests (the CLI and `#[ignore]`d tests exercise it once probabilities are real).

use std::collections::{HashMap, HashSet};

use pal_data::types::{Gender, PassiveId};
use pal_data::{GameData, InheritanceWeights, OwnedPal};
use rayon::prelude::*;

use crate::probabilities::{prob_inherited_target_ivs, prob_inherited_target_passives};
use crate::solver::config::SolverConfig;
use crate::solver::refs::{
    BredPalRef, EffPassive, OwnedInstance, OwnedPalRef, PalRef, RefGender, SolverIv, SolverIvSet,
    WildPalRef, MULTIPLE_BREEDING_FARMS,
};
use crate::solver::results::BreedingPlan;
use crate::solver::spec::{TargetPal, TargetSpec};
use crate::solver::working_set::WorkingSet;

const MAX_TOTAL_PASSIVES: usize = 4;

/// palcalc `PreferredLocationPruning` ordering (palbox first, then base, party…).
fn location_order(c: pal_data::types::ContainerKind) -> u8 {
    use pal_data::types::ContainerKind::*;
    match c {
        Palbox => 0,
        Base => 1,
        Party => 2,
        ViewingCage => 3,
        GlobalPalStorage => 4,
        DimensionalPalStorage => 5,
        Unknown => 6,
    }
}

fn iv_of(threshold: u8, value: u8) -> SolverIv {
    SolverIv::fixed(threshold != 0 && value >= threshold, value)
}

fn owned_iv_set(spec: &TargetSpec, p: &OwnedPal) -> SolverIvSet {
    SolverIvSet {
        hp: iv_of(spec.iv_hp, p.ivs.hp),
        attack: iv_of(spec.iv_attack, p.ivs.attack),
        defense: iv_of(spec.iv_defense, p.ivs.defense),
    }
}

/// A qualifying owned pal, reduced to the properties the solver groups on.
struct OwnedCandidate {
    species: u16,
    gender: Gender,
    relevant_desired: Vec<PassiveId>,
    iv_relevance: (bool, bool, bool),
    effective_passives: Vec<EffPassive>,
    ivs: SolverIvSet,
    instance: OwnedInstance,
    actual_count: usize,
}

/// Step (1): build the reduced initial working-set content from owned pals
/// (best representative per species/gender/passive-subset/IV-relevance, with
/// male+female pairs consolidated into wildcard composites) plus optional wild pals.
pub fn build_initial_content(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
) -> Vec<PalRef> {
    let desired = spec.desired_set();
    let within_steps = |species: u16| match spec.pal {
        TargetPal::Species(t) => gd.min_steps(species, t) as u32 <= cfg.max_breeding_steps,
        TargetPal::Any => true,
    };

    // Map + filter owned pals into candidates.
    let mut candidates: Vec<OwnedCandidate> = Vec::new();
    for p in owned {
        let Some(gender) = p.gender else { continue };
        let Some(species) = gd.species_index(&p.character_id) else { continue };
        if !within_steps(species) {
            continue;
        }
        let irrelevant = p.passives.iter().filter(|id| !desired.contains(*id)).count();
        if irrelevant > cfg.max_input_irrelevant_passives as usize {
            continue;
        }
        let effective = OwnedPalRef::effective_of(&p.passives, &desired);
        let ivs = owned_iv_set(spec, p);
        let mut relevant_desired: Vec<PassiveId> =
            p.passives.iter().filter(|id| desired.contains(*id)).cloned().collect();
        relevant_desired.sort();
        relevant_desired.dedup();
        candidates.push(OwnedCandidate {
            species,
            gender,
            relevant_desired,
            iv_relevance: ivs.relevance(),
            effective_passives: effective,
            ivs,
            instance: OwnedInstance {
                instance_id: p.instance_id,
                gender,
                container: p.container_kind,
                real_passives: p.passives.clone(),
                ivs,
            },
            actual_count: p.passives.len(),
        });
    }

    // Group by (species, relevant_desired, iv_relevance, gender); keep the best:
    // fewest actual passives, then preferred location, then highest IVs.
    type GroupKey = (u16, Vec<PassiveId>, (bool, bool, bool), Gender);
    let mut groups: HashMap<GroupKey, OwnedCandidate> = HashMap::new();
    for c in candidates {
        let key = (c.species, c.relevant_desired.clone(), c.iv_relevance, c.gender);
        match groups.get(&key) {
            Some(existing) if !better_owned(&c, existing) => {}
            _ => {
                groups.insert(key, c);
            }
        }
    }

    // Regroup ignoring gender to form composites.
    type NoGenderKey = (u16, Vec<PassiveId>, (bool, bool, bool));
    let mut by_no_gender: HashMap<NoGenderKey, Vec<OwnedCandidate>> = HashMap::new();
    for (_, c) in groups {
        by_no_gender
            .entry((c.species, c.relevant_desired.clone(), c.iv_relevance))
            .or_default()
            .push(c);
    }

    let mut content: Vec<PalRef> = Vec::new();
    for (_, members) in by_no_gender {
        // Individual owned refs.
        for c in &members {
            content.push(PalRef::Owned(OwnedPalRef {
                species: c.species,
                gender: c.gender.into(),
                effective_passives: c.effective_passives.clone(),
                ivs: c.ivs,
                primary: c.instance.clone(),
                alt: None,
            }));
        }
        // Composite (wildcard) ref for a male+female pair.
        if members.len() == 2 {
            let male = members.iter().find(|c| c.gender == Gender::Male);
            let female = members.iter().find(|c| c.gender == Gender::Female);
            if let (Some(m), Some(f)) = (male, female) {
                content.push(PalRef::Owned(OwnedPalRef::composite(
                    m.species,
                    m.instance.clone(),
                    m.effective_passives.clone(),
                    f.instance.clone(),
                    f.effective_passives.clone(),
                )));
            }
        }
    }

    // Optional wild pals.
    let max_wild = cfg.effective_max_wild();
    if max_wild > 0 {
        let owned_species: HashSet<u16> =
            owned.iter().filter_map(|p| gd.species_index(&p.character_id)).collect();
        for sp in gd.species() {
            let Some(species) = gd.species_index(&sp.internal_name) else { continue };
            if owned_species.contains(&species) || !within_steps(species) {
                continue;
            }
            let guaranteed_desired: Vec<PassiveId> =
                sp.guaranteed_passives.iter().filter(|id| desired.contains(*id)).cloned().collect();
            let num_irrelevant_guaranteed =
                sp.guaranteed_passives.len() - guaranteed_desired.len();
            let max_input = cfg.max_input_irrelevant_passives as i32;
            let min_bound = if num_irrelevant_guaranteed as i32 > max_input { 0 } else { 1 };
            let max_bound = (MAX_TOTAL_PASSIVES as i32 - sp.guaranteed_passives.len() as i32).max(0);
            let count = (max_input - num_irrelevant_guaranteed as i32).clamp(min_bound, max_bound);
            for num_random in 0..count {
                let w = WildPalRef::new(gd, species, guaranteed_desired.clone(), num_random as u8);
                if PalRef::Wild(w.clone()).total_effort() <= cfg.max_effort_secs {
                    content.push(PalRef::Wild(w));
                }
            }
        }
    }

    content
}

fn better_owned(c: &OwnedCandidate, existing: &OwnedCandidate) -> bool {
    // fewer actual passives is better
    match c.actual_count.cmp(&existing.actual_count) {
        std::cmp::Ordering::Less => return true,
        std::cmp::Ordering::Greater => return false,
        std::cmp::Ordering::Equal => {}
    }
    // preferred location (lower order value) is better
    match location_order(c.instance.container).cmp(&location_order(existing.instance.container)) {
        std::cmp::Ordering::Less => return true,
        std::cmp::Ordering::Greater => return false,
        std::cmp::Ordering::Equal => {}
    }
    // higher IV total is better
    let sum = |ivs: &SolverIvSet| ivs.hp.max as u32 + ivs.attack.max as u32 + ivs.defense.max as u32;
    sum(&c.ivs) > sum(&existing.ivs)
}

#[inline]
fn combined_effort(p1: &PalRef, p2: &PalRef) -> f64 {
    if MULTIPLE_BREEDING_FARMS && p1.is_bred() && p2.is_bred() {
        p1.total_effort().max(p2.total_effort())
    } else {
        p1.total_effort() + p2.total_effort()
    }
}

/// Enumerate the gender assignments to try for a pair (palcalc
/// `PreferredParentsGenders`, without the `OPPOSITE_WILDCARD` deferral).
fn gender_options(p1: &PalRef, p2: &PalRef) -> Vec<(RefGender, RefGender)> {
    use RefGender::*;
    match (p1.gender(), p2.gender()) {
        (Wildcard, Wildcard) => vec![(Male, Female), (Female, Male)],
        (Wildcard, g) => vec![(g.opposite(), g)],
        (g, Wildcard) => vec![(g, g.opposite())],
        (a, b) if a != b => vec![(a, b)],
        _ => vec![], // same concrete gender -> cannot breed
    }
}

/// For a parent pair, produce the distinct child species with the cheapest valid
/// gender-resolved parents for each.
fn candidate_children(gd: &GameData, p1: &PalRef, p2: &PalRef) -> Vec<(u16, PalRef, PalRef)> {
    let mut best: HashMap<u16, (f64, PalRef, PalRef)> = HashMap::new();
    for (g1, g2) in gender_options(p1, p2) {
        let (Some(r1), Some(r2)) = (p1.with_gender(gd, g1), p2.with_gender(gd, g2)) else {
            continue;
        };
        let (Some(cg1), Some(cg2)) = (g1.concrete(), g2.concrete()) else { continue };
        let Some(child) = gd.child_of(r1.species(), cg1, r2.species(), cg2) else { continue };
        let effort = combined_effort(&r1, &r2);
        match best.get(&child) {
            Some((e, _, _)) if *e <= effort => {}
            _ => {
                best.insert(child, (effort, r1, r2));
            }
        }
    }
    best.into_iter().map(|(child, (_, r1, r2))| (child, r1, r2)).collect()
}

/// IV probability inputs: relevant categories, and those relevant on only one parent.
fn iv_prob_inputs(p1: &PalRef, p2: &PalRef) -> (usize, usize) {
    let a = p1.ivs();
    let b = p2.ivs();
    let stats = [(a.hp, b.hp), (a.attack, b.attack), (a.defense, b.defense)];
    let mut required = 0;
    let mut single = 0;
    for (x, y) in stats {
        if x.relevant || y.relevant {
            required += 1;
            if x.relevant != y.relevant {
                single += 1;
            }
        }
    }
    (required, single)
}

/// Combined, deduplicated parent passive pool (named ids + random count).
fn parent_pool(p1: &PalRef, p2: &PalRef) -> (HashSet<PassiveId>, u32) {
    let (n1, r1) = p1.pool_contribution();
    let (n2, r2) = p2.pool_contribution();
    let mut named: HashSet<PassiveId> = n1.into_iter().collect();
    named.extend(n2);
    (named, r1 + r2)
}

/// Passive-subset permutations: required passives, each augmented with a
/// combination of optional passives up to the free-slot budget (palcalc
/// `PassiveSkillPermutations`).
fn passive_permutations(required: &[PassiveId], optional: &[PassiveId]) -> Vec<Vec<PassiveId>> {
    if optional.is_empty() || required.len() >= MAX_TOTAL_PASSIVES {
        return vec![required.to_vec()];
    }
    let max_optional = MAX_TOTAL_PASSIVES - required.len();
    let mut res = Vec::new();
    for k in 0..=max_optional.min(optional.len()) {
        for combo in combinations(optional, k) {
            let mut v = required.to_vec();
            v.extend(combo);
            res.push(v);
        }
    }
    res
}

fn combinations(items: &[PassiveId], k: usize) -> Vec<Vec<PassiveId>> {
    if k == 0 {
        return vec![Vec::new()];
    }
    if k > items.len() {
        return Vec::new();
    }
    let mut res = Vec::new();
    for i in 0..=items.len() - k {
        for mut tail in combinations(&items[i + 1..], k - 1) {
            let mut combo = vec![items[i].clone()];
            combo.append(&mut tail);
            res.push(combo);
        }
    }
    res
}

/// Breed a single parent pair, producing all relevant children (calls the
/// probability model — do not invoke under tests while it is `todo!()`).
fn breed_pair(
    gd: &GameData,
    spec: &TargetSpec,
    cfg: &SolverConfig,
    weights: &InheritanceWeights,
    ws: &WorkingSet,
    step_index: u32,
    p1: &PalRef,
    p2: &PalRef,
) -> Vec<PalRef> {
    let mut out = Vec::new();

    if !p1.gender().compatible_with(p2.gender()) {
        return out;
    }
    if p1.num_wild_pals() + p2.num_wild_pals() > cfg.effective_max_wild() {
        return out;
    }
    if p1.num_breeding_steps() + p2.num_breeding_steps() >= cfg.max_breeding_steps {
        return out;
    }

    // If no irrelevant passives are allowed, a pair where one parent has passives
    // but neither has a required passive can never yield a clean child.
    if spec.max_irrelevant == 0 {
        let valid = |p: &PalRef| {
            let held: HashSet<&PassiveId> =
                p.effective_passives().iter().filter_map(EffPassive::desired).collect();
            spec.required_passives.iter().any(|r| held.contains(r)) || p.effective_passives().is_empty()
        };
        if !valid(p1) && !valid(p2) {
            return out;
        }
    }

    let (ivs_required, ivs_single) = iv_prob_inputs(p1, p2);
    let ivs_prob = prob_inherited_target_ivs(ivs_required, ivs_single, weights);

    let (pool_named, pool_random) = parent_pool(p1, p2);
    let pool_size = pool_named.len() + pool_random as usize;
    let avail_required: Vec<PassiveId> =
        spec.required_passives.iter().filter(|id| pool_named.contains(*id)).cloned().collect();
    let avail_optional: Vec<PassiveId> =
        spec.optional_passives.iter().filter(|id| pool_named.contains(*id)).cloned().collect();

    let remaining = cfg.max_solver_iterations.saturating_sub(step_index + 1);

    for (child, r1, r2) in candidate_children(gd, p1, p2) {
        // Reachability: skip children that cannot reach the target in time.
        if let TargetPal::Species(t) = spec.pal {
            if gd.min_steps(child, t) as u32 > remaining {
                continue;
            }
        }
        let child_ivs = SolverIvSet::merge(r1.ivs(), r2.ivs());

        for target_passives in passive_permutations(&avail_required, &avail_optional) {
            let num_desired = target_passives.len();
            let mut prob_accum = 0.0f64;
            let max_final = MAX_TOTAL_PASSIVES.min(num_desired + spec.max_irrelevant as usize);
            for num_final in num_desired..=max_final {
                prob_accum += prob_inherited_target_passives(pool_size, num_desired, num_final, weights);
                if prob_accum <= 0.0 {
                    continue;
                }
                let mut effective: Vec<EffPassive> =
                    target_passives.iter().cloned().map(EffPassive::Desired).collect();
                for _ in num_desired..num_final {
                    effective.push(EffPassive::Random);
                }
                let bred = BredPalRef::new(
                    gd,
                    child,
                    r1.clone(),
                    r2.clone(),
                    effective,
                    prob_accum,
                    child_ivs,
                    ivs_prob,
                );
                let bred = PalRef::Bred(Box::new(bred));
                if bred.total_effort() <= cfg.max_effort_secs
                    && (spec.is_satisfied_by(&bred) || ws.is_optimal(&bred))
                {
                    out.push(bred);
                }
            }
        }
    }
    out
}

/// Run the solver, returning up to `cfg.result_limit` breeding plans, best-first.
pub fn solve(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
) -> Vec<BreedingPlan> {
    let mut spec = spec.clone();
    spec.normalize();
    let weights = gd.inheritance();

    let initial = build_initial_content(gd, &spec, owned, cfg);

    let mut ws = WorkingSet::new();
    let mut results: Vec<PalRef> = Vec::new();
    for r in &initial {
        if spec.is_satisfied_by(r) {
            results.push(r.clone());
        }
        ws.insert(r.clone());
    }

    for step in 0..cfg.max_solver_iterations {
        let pals = ws.to_vec();
        let n = pals.len();
        let pairs: Vec<(usize, usize)> =
            (0..n).flat_map(|i| (i + 1..n).map(move |j| (i, j))).collect();

        let children: Vec<PalRef> = pairs
            .par_iter()
            .flat_map_iter(|&(i, j)| {
                breed_pair(gd, &spec, cfg, weights, &ws, step, &pals[i], &pals[j]).into_iter()
            })
            .collect();

        // Reduce to the best instance per key, then merge into the working set.
        let mut step_best = WorkingSet::new();
        for c in &children {
            if spec.is_satisfied_by(c) {
                results.push(c.clone());
            }
            step_best.insert(c.clone());
        }

        let mut changed = false;
        for c in step_best.to_vec() {
            if ws.insert(c) {
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let pruned = crate::solver::pruning::prune_results(results, cfg.result_limit);
    pruned.iter().map(|r| BreedingPlan::from_ref(gd, r)).collect()
}
