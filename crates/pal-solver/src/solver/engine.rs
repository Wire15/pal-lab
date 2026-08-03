//! The breeding search: build an initial working set from owned (+ wild) pals,
//! then iteratively breed all cross pairs, keeping the cheapest instance of each
//! distinct pal, until no new optimal pal appears or the iteration budget is hit.
//!
//! Ported from palcalc `BreedingSolver` + `BreedingBatchSolver`. Concurrency uses
//! rayon over the pair batch on plain owned data — no object pools or manual
//! threads (palcalc fights the C# GC; Rust does not need to).
//!
//! This is the ONLY module that calls [`crate::probabilities`]; those bodies are
//! fully implemented and oracle-pinned, so [`solve`] runs under the normal test
//! suite (the golden + mode tests exercise it end to end).

use std::collections::{HashMap, HashSet};

use pal_data::types::{Gender, Guid, PassiveId};
use pal_data::{GameData, InheritanceWeights, OwnedPal};
#[cfg(not(target_arch = "wasm32"))]
use rayon::prelude::*;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
#[cfg(target_arch = "wasm32")]
use web_time::Instant;

use crate::probabilities::{
    prob_inherited_target_ivs, prob_inherited_target_passives,
    prob_inherited_target_passives_forced,
};
use crate::solver::config::{IvModel, SolverConfig, SurgeryConfig, ACTIVE_INHERIT_RATE};
use crate::solver::refs::{
    BredPalRef, EffPassive, OwnedInstance, OwnedPalRef, PalRef, RefGender, SolverIv, SolverIvSet,
    WildPalRef, MULTIPLE_BREEDING_FARMS,
};
use crate::solver::results::{BreedingPlan, SolvedRef};
use crate::solver::diagnose::{resolve_moves, MovePlan};
use crate::solver::spec::{TargetPal, TargetSpec};
use crate::solver::working_set::{key_of, RefKey, WorkingSet};
use crate::solver::progress::{SolveCancelled, SolveMonitor, SolvePhase, SolveProgress};

const MAX_TOTAL_PASSIVES: usize = 4;

/// Pair-batch chunk size for the step loop. Each chunk is bred in parallel then
/// concatenated in pair order (so results are byte-identical to a single
/// `par_iter`), while cancellation is polled and progress reported between
/// chunks — bounding cancel latency to one chunk's wall time even mid-step.
const PAIR_CHUNK: usize = 8192;

/// Threaded-move context for a solve: the move threaded through breeding, the
/// community-measured per-egg inherit rate, and the per-species equipped-move
/// estimate base. `None` when no move is threaded (all move logic skipped —
/// byte-identical to pre-moves behavior).
struct MoveCtx {
    /// The threaded move's stripped waza id.
    threaded: String,
    /// Per-egg inherit rate (see [`ACTIVE_INHERIT_RATE`]; COMMUNITY-MEASURED).
    rate: f64,
    /// Per-species equipped estimate: the first 3 level-1 learnset moves that are
    /// `can_inherit`. Used for BRED/WILD parents, whose real equipped moveset the
    /// solver does not track. A parent's estimated pool is this base (plus the
    /// threaded move when the parent carries it) to size |U|.
    base_by_species: HashMap<u16, Vec<String>>,
    /// Owned instances' REAL equipped `can_inherit` move ids, keyed by instance
    /// id. Owned parents size |U| from their actual moveset (accurate) instead of
    /// the per-species estimate. Composite (wildcard) refs union both members.
    owned_can_inherit: HashMap<Guid, Vec<String>>,
}

impl MoveCtx {
    /// A parent's estimated equipped `can_inherit` move ids. OWNED parents expose
    /// their REAL equipped can_inherit moves (accurate |U|); BRED/WILD parents
    /// fall back to the per-species estimate. Either way the threaded move is
    /// appended iff this ref carries it.
    fn equipped(&self, r: &PalRef) -> Vec<String> {
        let mut v = match r {
            PalRef::Owned(o) => {
                let mut real =
                    self.owned_can_inherit.get(&o.primary.instance_id).cloned().unwrap_or_default();
                // A composite (wildcard) pair contributes both members' pools.
                if let Some(alt) = &o.alt {
                    if let Some(alt_moves) = self.owned_can_inherit.get(&alt.instance_id) {
                        for m in alt_moves {
                            if !real.contains(m) {
                                real.push(m.clone());
                            }
                        }
                    }
                }
                real
            }
            _ => self.base_by_species.get(&r.species()).cloned().unwrap_or_default(),
        };
        if r.carries_move() && !v.iter().any(|m| m == &self.threaded) {
            v.push(self.threaded.clone());
        }
        v
    }

    /// Per-egg probability the threaded move passes from this pairing:
    /// `rate / |U|`, U = deduped union of both parents' equipped can_inherit
    /// moves. `0.0` when neither parent carries it (M ∉ U — cannot pass).
    fn pass_prob(&self, p1: &PalRef, p2: &PalRef) -> f64 {
        if !p1.carries_move() && !p2.carries_move() {
            return 0.0;
        }
        let mut union: HashSet<String> = self.equipped(p1).into_iter().collect();
        union.extend(self.equipped(p2));
        self.rate / union.len().max(1) as f64
    }
}

/// Per-species equipped-move estimate base: the first 3 level-1 learnset moves
/// that are `can_inherit`. One-time precompute, only when a move is threaded.
fn move_estimate_base(gd: &GameData) -> HashMap<u16, Vec<String>> {
    let mut map = HashMap::new();
    for s in 0..gd.species_count() as u16 {
        let base: Vec<String> = gd
            .learnset(s)
            .iter()
            .filter(|lm| lm.level <= 1)
            .filter(|lm| gd.active_skill(&lm.waza_id).is_some_and(|a| a.can_inherit))
            .map(|lm| lm.waza_id.clone())
            .take(3)
            .collect();
        if !base.is_empty() {
            map.insert(s, base);
        }
    }
    map
}

/// Owned instances' REAL equipped `can_inherit` move ids, keyed by instance id.
/// Owned parents size the threaded-move pool |U| from their actual equipped
/// moveset rather than the per-species estimate. Built once, only when a move is
/// threaded; instances with no inheritable equipped move are omitted.
fn owned_can_inherit_map(gd: &GameData, owned: &[OwnedPal]) -> HashMap<Guid, Vec<String>> {
    let mut map = HashMap::new();
    for p in owned {
        let moves: Vec<String> = p
            .active_skills
            .iter()
            .filter(|id| gd.active_skill(id).is_some_and(|a| a.can_inherit))
            .cloned()
            .collect();
        if !moves.is_empty() {
            map.insert(p.instance_id, moves);
        }
    }
    map
}

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
    /// Whether this pal carries the solve's threaded move (grouping axis so a
    /// carrier and non-carrier are never collapsed or composited together).
    carries_move: bool,
}

/// Step (1): build the reduced initial working-set content from owned pals
/// (best representative per species/gender/passive-subset/IV-relevance, with
/// male+female pairs consolidated into wildcard composites) plus optional wild pals.
pub fn build_initial_content(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
    threaded_move: Option<&str>,
) -> Vec<PalRef> {
    let desired = spec.desired_set();
    // Whether an owned pal carries the solve's THREADED move (the sole move axis
    // lifted from `OwnedPal.active_skills` — the full moveset is dropped);
    // always `false` when no move is threaded (axis collapses).
    let carries = |p: &OwnedPal| threaded_move.is_some_and(|m| p.active_skills.iter().any(|s| s == m));
    let within_steps = |species: u16| match spec.pal {
        TargetPal::Species(t) => gd.min_steps(species, t) as u32 <= cfg.max_breeding_steps,
        TargetPal::Any => true,
    };

    // Pinned owned instances (Wave A): always retained as individually-
    // addressable single refs, EXEMPT from the irrelevant-passive filter and
    // the group/composite reduction below. They are emitted FIRST and any
    // non-pinned owned ref that would share their working-set key is dropped,
    // so the specific pinned instance id occupies (and holds) that slot — a
    // reduction can no longer collapse a pin into a sibling or a composite.
    let pinned: HashSet<Guid> = spec.pinned_parents.iter().copied().collect();
    let mut pinned_refs: Vec<PalRef> = Vec::new();
    for p in owned {
        if !pinned.contains(&p.instance_id) {
            continue;
        }
        let Some(gender) = p.gender else { continue };
        let Some(species) = gd.species_index(&p.character_id) else { continue };
        if !within_steps(species) {
            continue;
        }
        let ivs = owned_iv_set(spec, p);
        pinned_refs.push(PalRef::Owned(OwnedPalRef {
            species,
            gender: gender.into(),
            effective_passives: OwnedPalRef::effective_of(&p.passives, &desired),
            ivs,
            primary: OwnedInstance {
                instance_id: p.instance_id,
                gender,
                container: p.container_kind,
                real_passives: p.passives.clone(),
                ivs,
            },
            alt: None,
            carries_move: carries(p),
        }));
    }
    let pinned_keys: HashSet<RefKey> = pinned_refs.iter().map(key_of).collect();

    // Map + filter owned pals into candidates.
    let mut candidates: Vec<OwnedCandidate> = Vec::new();
    for p in owned {
        let Some(gender) = p.gender else { continue };
        let Some(species) = gd.species_index(&p.character_id) else { continue };
        if pinned.contains(&p.instance_id) {
            continue; // emitted above as an individually-addressable pinned ref
        }
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
            carries_move: carries(p),
        });
    }

    // Group by (species, relevant_desired, iv_relevance, gender); keep the best:
    // fewest actual passives, then preferred location, then highest IVs.
    type GroupKey = (u16, Vec<PassiveId>, (bool, bool, bool), Gender, bool);
    let mut groups: HashMap<GroupKey, OwnedCandidate> = HashMap::new();
    for c in candidates {
        let key = (c.species, c.relevant_desired.clone(), c.iv_relevance, c.gender, c.carries_move);
        match groups.get(&key) {
            Some(existing) if !better_owned(&c, existing) => {}
            _ => {
                groups.insert(key, c);
            }
        }
    }

    // Regroup ignoring gender to form composites.
    type NoGenderKey = (u16, Vec<PassiveId>, (bool, bool, bool), bool);
    let mut by_no_gender: HashMap<NoGenderKey, Vec<OwnedCandidate>> = HashMap::new();
    for (_, c) in groups {
        by_no_gender
            .entry((c.species, c.relevant_desired.clone(), c.iv_relevance, c.carries_move))
            .or_default()
            .push(c);
    }

    let mut content: Vec<PalRef> = pinned_refs;
    for (_, members) in by_no_gender {
        // Individual owned refs (skipping any that would collide with a pinned
        // ref's working-set key, so the pin keeps its slot).
        for c in &members {
            let r = PalRef::Owned(OwnedPalRef {
                species: c.species,
                gender: c.gender.into(),
                effective_passives: c.effective_passives.clone(),
                ivs: c.ivs,
                primary: c.instance.clone(),
                alt: None,
                carries_move: c.carries_move,
            });
            if pinned_keys.contains(&key_of(&r)) {
                continue;
            }
            content.push(r);
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
                    m.carries_move,
                )));
            }
        }
    }

    // Wild seeds: one hypothetical to-be-caught pal per wild-spawnable species
    // (min wild level > 0), gated on the target being reachable within the step
    // budget. Owned pals are NOT excluded here — working-set dominance drops any
    // wild seed whose (species, gender, passives, IV) key an owned zero-effort
    // pal already fills, while wild seeds of an unowned gender survive. That last
    // case is what makes self-only-breeding legendaries reachable: owning one
    // gender of a Jetragon is not enough (it breeds only from a Jetragon pair),
    // so the search still needs a wild seed for the missing side.
    let max_wild = cfg.effective_max_wild();
    if max_wild > 0 {
        for sp in gd.species() {
            let Some(species) = gd.species_index(&sp.internal_name) else { continue };
            if sp.wild_levels.0 == 0 || !within_steps(species) {
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
fn candidate_children(
    gd: &GameData,
    cfg: &SolverConfig,
    p1: &PalRef,
    p2: &PalRef,
) -> Vec<(u16, PalRef, PalRef, Option<(f64, u8)>)> {
    let opts = gender_options(p1, p2);
    // Normal (gender-viable) path: no reverser, fourth tuple slot `None`.
    if !opts.is_empty() {
        let mut best: HashMap<u16, (f64, PalRef, PalRef)> = HashMap::new();
        for (g1, g2) in opts {
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
        return best.into_iter().map(|(child, (_, r1, r2))| (child, r1, r2, None)).collect();
    }

    // Gender-blocked (both parents the same concrete gender). Only the gender
    // reverser can unblock it, and only when enabled: flip ONE parent, pay
    // `cost_secs`, resolve deterministically. Same-species pairs the game forbids
    // outright still yield no `child_of`, so they stay forbidden.
    let Some(rev) = cfg.gender_reverser else { return Vec::new() };
    let cost = rev.cost_secs;
    let g = p1.gender();
    let opp = g.opposite();
    // `side` 1 reverses p1, 2 reverses p2 (the cheaper legal order wins on tie).
    let mut best: HashMap<u16, (f64, PalRef, PalRef, u8)> = HashMap::new();
    for side in [1u8, 2u8] {
        let (gr1, gr2) = if side == 1 { (opp, g) } else { (g, opp) };
        let (Some(r1), Some(r2)) = (p1.force_gender(gd, gr1), p2.force_gender(gd, gr2)) else {
            continue;
        };
        let (Some(cg1), Some(cg2)) = (gr1.concrete(), gr2.concrete()) else { continue };
        let Some(child) = gd.child_of(r1.species(), cg1, r2.species(), cg2) else { continue };
        let effort = combined_effort(&r1, &r2) + cost;
        match best.get(&child) {
            Some((e, _, _, _)) if *e <= effort => {}
            _ => {
                best.insert(child, (effort, r1, r2, side));
            }
        }
    }
    best.into_iter().map(|(child, (_, r1, r2, side))| (child, r1, r2, Some((cost, side)))).collect()
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
/// probability model).
fn breed_pair(
    gd: &GameData,
    spec: &TargetSpec,
    cfg: &SolverConfig,
    weights: &InheritanceWeights,
    ws: &WorkingSet,
    p1: &PalRef,
    p2: &PalRef,
    move_ctx: Option<&MoveCtx>,
) -> Vec<PalRef> {
    let mut out = Vec::new();

    // A same-gender pairing is only breedable through the gender reverser; skip
    // it outright when the reverser is off (identical to pre-reverser behavior).
    if !p1.gender().compatible_with(p2.gender()) && cfg.gender_reverser.is_none() {
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

    let child_steps = p1.num_breeding_steps() + p2.num_breeding_steps() + 1;
    // Per-egg pass probability of the threaded move for this pairing (0.0 when no
    // move is threaded or neither parent carries it). Gender-invariant, so it is
    // computed once from the original parents and reused for every child.
    let move_prob = move_ctx.map(|c| c.pass_prob(p1, p2)).unwrap_or(0.0);

    for (child, r1, r2, reverser) in candidate_children(gd, cfg, p1, p2) {
        // Reachability budget: any final plan containing this child uses at
        // least `child_steps + min_steps(child -> target)` breeding steps (the
        // child's own subtree plus the breeding-graph-distance up-path to the
        // target); if that exceeds `max_breeding_steps` the child can never
        // appear in a result, so pruning it here is result-preserving.
        if let TargetPal::Species(t) = spec.pal {
            if gd.min_steps(child, t) as u32 + child_steps > cfg.max_breeding_steps {
                continue;
            }
        }
        let child_ivs = SolverIvSet::merge(r1.ivs(), r2.ivs());

        for target_passives in passive_permutations(&avail_required, &avail_optional) {
            let num_desired = target_passives.len();
            let mut prob_accum = 0.0f64;
            let max_final = MAX_TOTAL_PASSIVES.min(num_desired + spec.max_irrelevant as usize);
            for num_final in num_desired..=max_final {
                prob_accum += if cfg.cake.forces_all_passives() {
                    prob_inherited_target_passives_forced(pool_size, num_desired, num_final, weights)
                } else {
                    prob_inherited_target_passives(pool_size, num_desired, num_final, weights)
                };
                if prob_accum <= 0.0 {
                    continue;
                }
                let mut effective: Vec<EffPassive> =
                    target_passives.iter().cloned().map(EffPassive::Desired).collect();
                for _ in num_desired..num_final {
                    effective.push(EffPassive::Random);
                }
                // Effective egg multiplier: cake BreedCount * (1 + extra-egg boost).
                // Folded into construction (with the setup) so the hot loop never
                // clones a freshly built ref just to reset these fields.
                let egg_mult = cfg.cake.egg_multiplier() * (1.0 + cfg.setup.extra_egg_chance);
                let bred = BredPalRef::new(
                    gd,
                    child,
                    r1.clone(),
                    r2.clone(),
                    effective,
                    prob_accum,
                    child_ivs,
                    ivs_prob,
                    &cfg.setup,
                    egg_mult,
                );
                // Gender-reverser pairings carry the item cost + reversed-parent
                // flag; recomputes effort so ranking sees the added cost.
                let bred = match reverser {
                    Some((cost, side)) => bred.with_reverser(gd, cost, side),
                    None => bred,
                };
                // WITH-move variant: an independent per-egg roll (prob move_prob)
                // folds into the success rate, raising the egg count. Emitted only
                // when a parent carries the threaded move; competes on effort with
                // the ordinary (without-move) child below. No move threaded =>
                // move_prob 0.0 => this block is skipped (byte-identical path).
                if move_prob > 0.0 {
                    let with_move =
                        PalRef::Bred(Box::new(bred.clone().with_threaded(gd, move_prob, true)));
                    if with_move.total_effort() <= cfg.max_effort_secs
                        && (spec.is_satisfied_by(&with_move) || ws.is_optimal(&with_move))
                    {
                        out.push(with_move);
                    }
                }
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

/// Build a [`SolvedRef`] for `c` when it satisfies the spec under BOTH the
/// surgery (passive-implant) and Skill-Fruit (move) terminal relaxations, else
/// `None`. The two relaxations are orthogonal: surgery covers missing REQUIRED
/// passives, fruit covers REQUIRED moves not delivered by breeding.
#[allow(clippy::too_many_arguments)]
fn try_solved(
    gd: &GameData,
    spec: &TargetSpec,
    c: &PalRef,
    max_implants: u8,
    surgery_cost: f64,
    unimplantable: &HashSet<PassiveId>,
    move_plan: &MovePlan,
    fruit_cost: f64,
) -> Option<SolvedRef> {
    let implants = spec.satisfied_with_surgery(c, max_implants, unimplantable)?;
    let fruits = move_plan.satisfied_fruits(gd, c)?;
    Some(SolvedRef {
        reference: c.clone(),
        implants,
        surgery_cost_each: surgery_cost,
        fruits,
        fruit_cost_each: fruit_cost,
        threaded_move_name: move_plan.threaded_move_name.clone(),
        levelup_moves: move_plan.levelup_moves.clone(),
    })
}

/// Fold one bred chunk into the current step's reduction, in pair-lexicographic
/// order: satisfied refs are recorded in `results`; every ref is offered to
/// `step_best` (tie-keeps-incumbent). Folding chunk-by-chunk (rather than
/// accumulating a step-wide candidate vec) bounds memory by the working-set key
/// space instead of the candidate count — the insert order is identical to a
/// single reduction over the concatenated chunks, so results are unchanged.
#[allow(clippy::too_many_arguments)]
fn fold_chunk(
    gd: &GameData,
    part: Vec<PalRef>,
    spec: &TargetSpec,
    max_implants: u8,
    surgery_cost: f64,
    unimplantable: &HashSet<PassiveId>,
    move_plan: &MovePlan,
    fruit_cost: f64,
    step_best: &mut WorkingSet,
    results: &mut Vec<SolvedRef>,
) {
    for c in part {
        // Surgery-aware (passives) + Skill-Fruit-aware (moves) terminal
        // satisfaction: a candidate missing up to `max_implants` REQUIRED
        // passives and/or lacking fruitable REQUIRED moves is recorded as a
        // result carrying those relaxations. The working set below is untouched
        // by either relaxation — dominance stays exact.
        if let Some(sr) =
            try_solved(gd, spec, &c, max_implants, surgery_cost, unimplantable, move_plan, fruit_cost)
        {
            results.push(sr);
        }
        step_best.insert(c);
    }
    // Results cap: a satisfied-heavy search can grow `results` without bound.
    // Compact best-first to 1024 once past 4096. Determinism tradeoff:
    // `prune_results` keeps best-first order and the same signature-collapse the
    // final prune uses, so the returned top-N is unaffected except under a
    // pathological >1024-way tie among distinct-signature best plans.
    if results.len() > 4096 {
        let compacted = crate::solver::pruning::prune_results(std::mem::take(results), 1024);
        *results = compacted;
    }
}

/// Every owned instance id reachable as a leaf of a reference tree (owned
/// composites contribute both members).
fn collect_owned_ids(r: &PalRef, out: &mut HashSet<Guid>) {
    match r {
        PalRef::Owned(o) => {
            out.insert(o.primary.instance_id);
            if let Some(alt) = &o.alt {
                out.insert(alt.instance_id);
            }
        }
        PalRef::Wild(_) => {}
        PalRef::Bred(b) => {
            collect_owned_ids(&b.parent1, out);
            collect_owned_ids(&b.parent2, out);
        }
    }
}

/// True when `r`'s tree contains every pinned owned instance id as a leaf.
fn ref_contains_all_pins(r: &PalRef, pins: &[Guid]) -> bool {
    if pins.is_empty() {
        return true;
    }
    let mut ids = HashSet::new();
    collect_owned_ids(r, &mut ids);
    pins.iter().all(|p| ids.contains(p))
}

/// Map best-first solved references to serializable plans, tagged with `cake`.
/// `iv_thresholds` are the cake-effective spec IV floors for bred `iv_targets`;
/// each [`SolvedRef`]'s surgery relaxation is folded in via
/// [`BreedingPlan::from_solved`].
#[inline]
fn plans_of(
    gd: &GameData,
    refs: &[SolvedRef],
    cake: crate::solver::config::CakeKind,
    iv_thresholds: [u8; 3],
) -> Vec<BreedingPlan> {
    refs.iter().map(|r| BreedingPlan::from_solved(gd, r, cake, iv_thresholds)).collect()
}

/// Run the solver, returning up to `cfg.result_limit` breeding plans, best-first.
/// When [`TargetSpec::pinned_parents`] is non-empty, only plans whose tree
/// contains every pinned owned instance survive (see [`solve_reporting`]).
pub fn solve(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
) -> Vec<BreedingPlan> {
    solve_reporting(gd, spec, owned, cfg).0
}

/// [`solve`] plus a `pins_satisfied` flag (see [`solve_core`]).
pub fn solve_reporting(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
) -> (Vec<BreedingPlan>, bool) {
    let (refs, pins_satisfied, _truncated) =
        solve_core(gd, spec, owned, cfg, SolveMonitor::noop()).expect("noop monitor never cancels");
    (plans_of(gd, &refs, cfg.cake, cfg.cake.effective_iv_thresholds(spec)), pins_satisfied)
}

/// Core search: pruned, pin-filtered best-first references plus a
/// `pins_satisfied` flag. The flag is `false` only when a pin constraint
/// eliminated an otherwise-non-empty result set (refs then empty); `true` when
/// there are no pins, a pinned ref survives, or the target was unreachable
/// regardless of pins. Callers map the refs to [`BreedingPlan`]s with the cake.
fn solve_core(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
    monitor: SolveMonitor,
) -> Result<(Vec<SolvedRef>, bool, bool), SolveCancelled> {
    let mut spec = spec.clone();
    spec.normalize();
    // Mushroom/DeluxeVegetable cakes raise the egg's IV floor; model it by
    // lowering the spec's IV thresholds before the search (single source of
    // truth for owned relevance, IV probability, and satisfaction checks).
    cfg.cake.apply_iv_floor(&mut spec);
    // IV inherit-count distribution: Empirical uses the pack's `talent_inherit`
    // weights (50/25/25, oracle-pinned); Cdo swaps in the game-file
    // `combi_talent_inherit_num` weights ([3,2,1] -> 50/33.3/16.7). Only the
    // `talent_inherit` array differs; passive weights are shared.
    let cdo_weights;
    let weights = match cfg.iv_model {
        IvModel::Empirical => gd.inheritance(),
        IvModel::Cdo => {
            cdo_weights = InheritanceWeights {
                talent_inherit: gd
                    .game_settings()
                    .combi_talent_inherit_num
                    .iter()
                    .map(|&w| w as f32)
                    .collect(),
                ..gd.inheritance().clone()
            };
            &cdo_weights
        }
    };

    // Surgery-table relaxation (terminal): implants may cover up to
    // `max_implants` missing REQUIRED passives on any result, each costing
    // `surgery_cost`. `0`/`0.0` = off (exact satisfaction, unchanged behavior).
    // Special lottery-tier passives (Rainbow/WorldTree) are refused by the
    // in-game surgery table, so they can never be covered by implants.
    let max_implants = cfg.surgery.as_ref().map(SurgeryConfig::implants).unwrap_or(0);
    let surgery_cost = cfg.surgery.as_ref().map(|s| s.cost_secs).unwrap_or(0.0);
    // A missing required passive is implant-coverable only if it is tier-eligible
    // (as above) AND not excluded by the surgery allowlist (when one is set).
    // Folding allowlist exclusions into `unimplantable` keeps enforcement in the
    // single `satisfied_with_surgery` predicate; `None` = any eligible passive.
    let allowed = cfg.surgery.as_ref().and_then(|s| s.allowed_passives.as_ref());
    let unimplantable: HashSet<PassiveId> = spec
        .required_passives
        .iter()
        .filter(|p| {
            gd.passive_by_id(p).is_some_and(|ps| ps.tier.is_some())
                || allowed.is_some_and(|l| !l.contains(*p))
        })
        .cloned()
        .collect();

    // Active-skill move resolution: learnset moves auto-satisfy (surfaced as
    // `levelup_moves`), AT MOST ONE move threads through breeding (a working-set
    // axis + per-egg probability), and remaining required moves need Skill Fruit
    // (a terminal result-layer step, like surgery). Unsatisfiable move
    // requirements short-circuit to no plans; `diagnose_no_path` reports why.
    let move_plan = resolve_moves(gd, &spec, owned, cfg);
    if move_plan.blocked() {
        return Ok((Vec::new(), true, false));
    }
    let fruit_cost = cfg.skill_fruit.as_ref().map(|f| f.cost_secs).unwrap_or(0.0);
    let move_ctx = move_plan.threaded_move.as_ref().map(|m| MoveCtx {
        threaded: m.clone(),
        rate: ACTIVE_INHERIT_RATE,
        base_by_species: move_estimate_base(gd),
        owned_can_inherit: owned_can_inherit_map(gd, owned),
    });

    let initial = build_initial_content(gd, &spec, owned, cfg, move_plan.threaded_move.as_deref());

    let mut ws = WorkingSet::new();
    let mut results: Vec<SolvedRef> = Vec::new();
    for r in &initial {
        // Zero-step owned/wild seeds can satisfy directly — surgery-aware
        // (passives) AND fruit-aware (moves): an owned target-species pal missing
        // a few required passives, and/or carrying the threaded move / needing a
        // fruit step, is a valid 0-breeding-step result.
        if let Some(sr) =
            try_solved(gd, &spec, r, max_implants, surgery_cost, &unimplantable, &move_plan, fruit_cost)
        {
            results.push(sr);
        }
        ws.insert(r.clone());
    }

    // Phase: seeding — working set built from owned (+ wild), no breeding yet.
    let max_steps = cfg.max_solver_iterations;
    monitor.report(SolveProgress {
        phase: SolvePhase::Seeding,
        step: 0,
        max_steps,
        pairs_done: 0,
        pairs_total: 0,
        working_set: ws.len(),
    });

    // Incremental frontier: only breed pairs touching a ref added or improved in
    // the PREVIOUS step. `breed_pair` is now fully step-independent (its
    // reachability prune is a function of the pair and the target, not the step)
    // and deterministic, so a pair of two unchanged refs breeds identically to
    // when it was last bred — its children are already in the working set
    // (dominated on tie) and re-breeding yields nothing new. Skipping such pairs
    // is result-preserving. All seeded refs start on the frontier.
    let mut frontier: HashSet<RefKey> = ws.iter().map(key_of).collect();

    // Wall-clock search budget: bounds runaway searches (combinatorial pair
    // growth) without touching the result set on searches that finish in time.
    let start = Instant::now();
    let over_budget = |start: &Instant| {
        cfg.search_budget_secs > 0.0 && start.elapsed().as_secs_f64() > cfg.search_budget_secs
    };
    let mut truncated = false;

    for step in 0..cfg.max_solver_iterations {
        monitor.check()?;
        // Budget check at the step boundary: stop expanding, finalize best-so-far.
        if over_budget(&start) {
            truncated = true;
            break;
        }
        let pals = ws.to_vec();
        let n = pals.len();
        let is_new: Vec<bool> = pals.iter().map(|r| frontier.contains(&key_of(r))).collect();
        let n_old = is_new.iter().filter(|&&b| !b).count();
        // pairs_total = C(n,2) - C(n_old,2): all cross pairs minus the all-old
        // pairs the `is_new[i] || is_new[j]` frontier filter drops. Computed
        // arithmetically — the O(ws^2) pair vec is never materialized.
        let c2 = |m: usize| (m as u64) * (m.saturating_sub(1) as u64) / 2;
        let pairs_total = c2(n) - c2(n_old);

        // Step boundary (always emitted): batch sized, nothing bred yet.
        monitor.report(SolveProgress {
            phase: SolvePhase::Step,
            step: step + 1,
            max_steps,
            pairs_done: 0,
            pairs_total,
            working_set: ws.len(),
        });

        // Breed lazily: stream pairs in pair-lexicographic (i, j) order into a
        // buffer of at most PAIR_CHUNK, breed each full buffer in parallel, then
        // fold it straight into `step_best` (per-chunk reduction). Per-chunk
        // memory is bounded to ~PAIR_CHUNK pairs plus one chunk's candidates.
        let breed = |buf: &[(usize, usize)]| -> Vec<PalRef> {
            let expand = |&(i, j): &(usize, usize)| {
                breed_pair(gd, &spec, cfg, weights, &ws, &pals[i], &pals[j], move_ctx.as_ref()).into_iter()
            };
            // wasm32 is single-threaded this wave: same chunk, serial iterator.
            // Order (pair-lexicographic) is identical, so results stay
            // byte-identical across both paths.
            #[cfg(not(target_arch = "wasm32"))]
            {
                buf.par_iter().flat_map_iter(expand).collect()
            }
            #[cfg(target_arch = "wasm32")]
            {
                buf.iter().flat_map(expand).collect()
            }
        };

        let mut step_best = WorkingSet::new();
        let mut pairs_done: u64 = 0;
        let mut buf: Vec<(usize, usize)> = Vec::with_capacity(PAIR_CHUNK);
        'chunks: for i in 0..n {
            for j in (i + 1)..n {
                if !(is_new[i] || is_new[j]) {
                    continue;
                }
                buf.push((i, j));
                if buf.len() == PAIR_CHUNK {
                    monitor.check()?;
                    let part = breed(&buf);
                    pairs_done += buf.len() as u64;
                    buf.clear();
                    fold_chunk(gd, part, &spec, max_implants, surgery_cost, &unimplantable, &move_plan, fruit_cost, &mut step_best, &mut results);
                    monitor.report(SolveProgress {
                        phase: SolvePhase::Step,
                        step: step + 1,
                        max_steps,
                        pairs_done,
                        pairs_total,
                        working_set: ws.len(),
                    });
                    // Budget check at the chunk boundary.
                    if over_budget(&start) {
                        truncated = true;
                        break 'chunks;
                    }
                }
            }
        }
        // Trailing partial chunk (only when the budget did not already trip).
        if !truncated && !buf.is_empty() {
            monitor.check()?;
            let part = breed(&buf);
            pairs_done += buf.len() as u64;
            fold_chunk(gd, part, &spec, max_implants, surgery_cost, &unimplantable, &move_plan, fruit_cost, &mut step_best, &mut results);
            monitor.report(SolveProgress {
                phase: SolvePhase::Step,
                step: step + 1,
                max_steps,
                pairs_done,
                pairs_total,
                working_set: ws.len(),
            });
        }

        if truncated {
            // Budget tripped mid-step: finalize with best-so-far results (already
            // recorded during folding); no need to merge `step_best` into `ws`.
            break;
        }

        // Merge, recording which keys were added/improved — next step's frontier.
        let mut next_frontier: HashSet<RefKey> = HashSet::new();
        for c in step_best.to_vec() {
            let k = key_of(&c);
            if ws.insert(c) {
                next_frontier.insert(k);
            }
        }
        if next_frontier.is_empty() {
            break;
        }
        frontier = next_frontier;
    }

    // Phase: finalizing — search done, about to pin-filter / prune / map.
    monitor.report(SolveProgress {
        phase: SolvePhase::Finalizing,
        step: 0,
        max_steps,
        pairs_done: 0,
        pairs_total: 0,
        working_set: ws.len(),
    });

    // Pin post-filter (Wave A): keep only plans whose tree contains every
    // pinned owned instance. `pins_satisfied` distinguishes "pinning killed a
    // real result" (false) from "target unreachable anyway" (true).
    let had_results = !results.is_empty();
    if !spec.pinned_parents.is_empty() {
        results.retain(|r| ref_contains_all_pins(&r.reference, &spec.pinned_parents));
    }
    let pins_satisfied = spec.pinned_parents.is_empty() || !(had_results && results.is_empty());

    let pruned = crate::solver::pruning::prune_results(results, cfg.result_limit);
    Ok((pruned, pins_satisfied, truncated))
}

/// Catch policy for a wild-enabled solve (only consulted when
/// [`SolverConfig::include_wild`] is set — owned-only solves ignore it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Catching {
    /// Prefer pure owned-breeding plans; catches are a last resort. The solve
    /// runs owned-only FIRST and returns those plans if any exist; only when the
    /// target is unreachable owned-only does it fall back to a catch-assisted
    /// run (flagged via [`ModeResult::fallback_used`]).
    #[default]
    BreedingOnly,
    /// Catches may fill ingredient gaps freely; a single owned-or-wild run.
    Allowed,
}

/// Outcome of [`solve_with_catching`]: the plans, whether a `BreedingOnly`
/// request had to fall back to catch-assisted plans (no pure-breeding path),
/// and whether the pin constraint was satisfiable (see [`solve_reporting`]).
#[derive(Debug, Clone)]
pub struct ModeResult {
    pub plans: Vec<BreedingPlan>,
    pub fallback_used: bool,
    pub pins_satisfied: bool,
    /// Whether the search hit the wall-clock budget
    /// ([`crate::solver::config::SolverConfig::search_budget_secs`]) and
    /// finalized with best-so-far results instead of exhausting the frontier.
    pub truncated: bool,
}

/// True for a bare wild ref — a "just catch the target" plan (ref-level mirror
/// of [`crate::solver::results::is_trivial_wild_plan`]).
fn is_trivial_wild_ref(r: &SolvedRef) -> bool {
    matches!(r.reference, PalRef::Wild(_))
}

/// Drop trivial catch-the-target refs whenever any non-trivial ref survives;
/// otherwise return unchanged (ref-level mirror of [`filter_trivial_wild`]).
fn filter_trivial_wild_refs(refs: Vec<SolvedRef>) -> Vec<SolvedRef> {
    if refs.iter().any(|r| !is_trivial_wild_ref(r)) {
        refs.into_iter().filter(|r| !is_trivial_wild_ref(r)).collect()
    } else {
        refs
    }
}

/// Catching-mode-aware search returning best-first references — the shared core
/// of [`solve_with_catching`] and [`solve_queue`]. Returns
/// `(refs, fallback_used, pins_satisfied)`; see [`solve_with_catching`] for the
/// mode semantics.
pub fn solve_modes(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
    catching: Catching,
) -> (Vec<SolvedRef>, bool, bool, bool) {
    solve_modes_monitored(gd, spec, owned, cfg, catching, SolveMonitor::noop())
        .expect("noop monitor never cancels")
}

/// [`solve_modes`] threaded with a [`SolveMonitor`] for progress + cancellation.
/// Returns `Err(SolveCancelled)` if the monitor's cancel flag tripped mid-search
/// (checked at chunk/step boundaries inside [`solve_core`]).
pub fn solve_modes_monitored(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
    catching: Catching,
    monitor: SolveMonitor,
) -> Result<(Vec<SolvedRef>, bool, bool, bool), SolveCancelled> {
    if !cfg.include_wild {
        let (refs, pins, trunc) = solve_core(gd, spec, owned, cfg, monitor)?;
        return Ok((refs, false, pins, trunc));
    }
    match catching {
        Catching::Allowed => {
            let (refs, pins, trunc) = solve_core(gd, spec, owned, cfg, monitor)?;
            Ok((filter_trivial_wild_refs(refs), false, pins, trunc))
        }
        Catching::BreedingOnly => {
            let owned_cfg = SolverConfig { include_wild: false, ..cfg.clone() };
            let (owned_refs, owned_pins, owned_trunc) =
                solve_core(gd, spec, owned, &owned_cfg, monitor)?;
            if !owned_refs.is_empty() {
                Ok((owned_refs, false, owned_pins, owned_trunc))
            } else {
                // No pure-owned path: re-run with catching allowed.
                monitor.report(SolveProgress {
                    phase: SolvePhase::CatchFallback,
                    step: 0,
                    max_steps: cfg.max_solver_iterations,
                    pairs_done: 0,
                    pairs_total: 0,
                    working_set: 0,
                });
                let (wild_refs, wild_pins, wild_trunc) = solve_core(gd, spec, owned, cfg, monitor)?;
                Ok((filter_trivial_wild_refs(wild_refs), true, wild_pins, wild_trunc))
            }
        }
    }
}

/// Catching-mode-aware solve orchestration (the engine [`solve`] stays
/// single-mode). Trivial "catch the target" plans are dropped whenever a real
/// plan survives.
///
/// - Owned-only (`!cfg.include_wild`): `catching` is ignored; a single owned
///   run, `fallback_used = false`.
/// - `Allowed` + wild: one wild-enabled run, filtered, `fallback_used = false`.
/// - `BreedingOnly` + wild: an owned-only run first; if it yields any plan those
///   are returned (`fallback_used = false`). Otherwise a wild-enabled run is
///   filtered and returned with `fallback_used = true`.
///
/// `pins_satisfied` reflects the run whose plans are returned.
pub fn solve_with_catching(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
    catching: Catching,
) -> ModeResult {
    solve_with_catching_monitored(gd, spec, owned, cfg, catching, SolveMonitor::noop())
        .expect("noop monitor never cancels")
}

/// [`solve_with_catching`] threaded with a [`SolveMonitor`]. Returns
/// `Err(SolveCancelled)` when cancellation tripped mid-search.
pub fn solve_with_catching_monitored(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
    catching: Catching,
    monitor: SolveMonitor,
) -> Result<ModeResult, SolveCancelled> {
    let (refs, fallback_used, pins_satisfied, truncated) =
        solve_modes_monitored(gd, spec, owned, cfg, catching, monitor)?;
    let plans = plans_of(gd, &refs, cfg.cake, cfg.cake.effective_iv_thresholds(spec));
    Ok(ModeResult { plans, fallback_used, pins_satisfied, truncated })
}
