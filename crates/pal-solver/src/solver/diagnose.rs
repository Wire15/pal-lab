//! No-path diagnostics: structured reasons a solve returned zero plans.
//!
//! Computed ONLY when [`solve`](crate::solver::solve) yields no plans, this
//! reproduces the cheap, static preconditions the search relies on — required
//! passive carriers in the scoped pool, target-species reachability in the
//! breeding graph, the step cap, and a narrow same-gender bottleneck — and
//! reports the first blocking cause in priority order. It never re-runs the
//! search.
//!
//! Wild sourcing (`include_wild`) cannot introduce an arbitrary required
//! passive: a wild reference only ever carries `EffPassive::Random` slots plus
//! any passive the SPECIES is innately guaranteed (see
//! [`WildPalRef::new`](crate::solver::refs::WildPalRef::new), refs.rs:541-543,
//! seeded from the species' `guaranteed_passives` in engine.rs:241-250). A
//! passive that is not a species-innate guaranteed passive can never appear as a
//! `Desired` slot on a wild pal, so catching cannot supply it.

use std::collections::HashSet;

use pal_data::gamedata::UNREACHABLE;
use pal_data::types::Gender;
use pal_data::{GameData, OwnedPal};
use serde::{Deserialize, Serialize};

use crate::solver::config::{SolverConfig, SurgeryConfig};
use crate::solver::refs::PalRef;
use crate::solver::spec::{TargetPal, TargetSpec};

/// A structured reason the solver found no breeding path. Serialized internally
/// tagged on `kind` (snake_case) for the frontend to discriminate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoPathReason {
    /// A required passive that no pal in the scoped pool carries.
    /// `wild_sourcing_enabled` echoes `cfg.include_wild`: even when set, wild
    /// catches cannot introduce this passive (it is not a species-innate
    /// guaranteed passive on any catchable species).
    MissingPassiveCarrier {
        passive_id: String,
        passive_name: String,
        wild_sourcing_enabled: bool,
        /// `true` when the Surgery table is OFF and enabling it could implant this
        /// passive — the UI surfaces an "enable Surgery table" remedy. Skipped
        /// when `false` (surgery already on, or already accounted for) so
        /// pre-surgery payloads stay byte-identical.
        #[serde(default, skip_serializing_if = "is_false")]
        surgery_off: bool,
    },
    /// A required active-skill move the delivered pal cannot obtain. `inheritable`
    /// echoes the move's `can_inherit` flag; `fruit_available` echoes its
    /// `has_skill_fruit` flag. `fruit_off` is `true` when a Skill Fruit exists for
    /// this move but the Skill-Fruit relaxation is OFF (enabling it is the remedy)
    /// — skipped when `false` (mirrors `MissingPassiveCarrier::surgery_off`), so a
    /// hard-unobtainable move (no fruit) never suggests a dead remedy. Emitted
    /// when: the move is neither inheritable-from-an-owned-carrier nor fruitable;
    /// a second breeding-slot move exceeds the single-thread cap
    /// (`inheritable: true, fruit_available: false`); or a fruitable move needs
    /// the Skill-Fruit relaxation that is off (`fruit_off: true`).
    MissingMoveCarrier {
        move_id: String,
        move_name: String,
        inheritable: bool,
        fruit_available: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        fruit_off: bool,
    },
    /// The target species is not producible from the scoped pool at all.
    /// `min_steps` is the minimum breeding steps to the target from ANY species
    /// in the game (context: `Some(n)` = breedable in principle from species you
    /// neither own nor can catch; `None` = not obtainable by breeding at all).
    TargetSpeciesUnreachable { min_steps: Option<u32> },
    /// The target is reachable from the pool but needs more breeding steps than
    /// the configured cap.
    StepCapTooLow { needed: u32, cap: u32 },
    /// The pool is a single species with every instance sharing one gender, so
    /// no pair can breed. Cheaply-provable gender bottleneck (see module notes).
    GenderBottleneck { species_name: String },
    /// None of the above proved: the pool + passive combination has no viable
    /// pairing under the current step cap.
    ExhaustedSearch {},
    /// The search was aborted after hitting its wall-clock budget before
    /// exploring the full space. This proves nothing about reachability: the
    /// target may still be breedable. NOT emitted by [`diagnose_no_path`]
    /// (which has no truncation knowledge) — the command layer injects it in
    /// place of the static diagnosis when a budget-killed search returns no
    /// plans.
    SearchBudgetExhausted { budget_secs: f64 },
}

/// serde `skip_serializing_if` predicate for a `false` bool.
fn is_false(b: &bool) -> bool {
    !*b
}

/// Resolved plan for a solve's required active-skill moves. Produced by
/// [`resolve_moves`] from the target learnset, per-move flags, and owned
/// carriers; consumed by the engine (threading axis + result-layer fruit
/// relaxation) and by [`diagnose_no_path`] (blocker reasons). See the crate's
/// move-inheritance contract for the threading semantics.
#[derive(Debug, Clone, Default)]
pub struct MovePlan {
    /// The single move threaded through breeding (stripped waza id), or `None`.
    pub threaded_move: Option<String>,
    /// Display name of the threaded move.
    pub threaded_move_name: Option<String>,
    /// Fruitable required moves covered by Skill-Fruit steps: (id, display name).
    /// Non-empty only when the Skill-Fruit relaxation is ON.
    pub fruit_moves: Vec<(String, String)>,
    /// Required moves in the target species' own learnset (display names) —
    /// auto-satisfied by leveling.
    pub levelup_moves: Vec<String>,
    /// Blocking reasons; non-empty <=> the move requirements are unsatisfiable.
    pub blockers: Vec<NoPathReason>,
    /// Whether the target is [`TargetPal::Any`] (enables the per-ref learnset
    /// auto-satisfy check in [`Self::satisfied_fruits`]).
    pub target_any: bool,
}

impl MovePlan {
    /// True when the move requirements cannot be satisfied by any reference.
    #[inline]
    pub fn blocked(&self) -> bool {
        !self.blockers.is_empty()
    }

    /// The fruit steps `r` needs to satisfy the move requirements, or `None`
    /// when it cannot: the threaded move must be delivered by breeding
    /// (`carries_move`), or — for an `Any` target — appear in `r`'s own species
    /// learnset. The returned list is the constant fruit set (identical for every
    /// satisfying ref). No threaded move => every base-satisfying ref qualifies.
    pub fn satisfied_fruits(&self, gd: &GameData, r: &PalRef) -> Option<Vec<(String, String)>> {
        if let Some(m) = &self.threaded_move {
            let delivered = r.carries_move()
                || (self.target_any
                    && gd.learnset(r.species()).iter().any(|lm| &lm.waza_id == m));
            if !delivered {
                return None;
            }
        }
        Some(self.fruit_moves.clone())
    }
}

/// One classified required move during [`resolve_moves`].
struct ReqMove {
    id: String,
    name: String,
    inheritable: bool,
    fruitable: bool,
    has_carrier: bool,
}

/// Resolve a spec's `required_moves` into a [`MovePlan`]: learnset moves become
/// `levelup_moves`; AT MOST ONE remaining move threads through breeding; the rest
/// need Skill Fruit; anything uncoverable becomes a [`NoPathReason::
/// MissingMoveCarrier`] blocker. Carrier-aware: a move is "threadable" only when
/// it is inheritable AND some owned pal carries it (wild catches never carry a
/// move). Deterministic: a lone non-fruitable move takes the breeding slot, else
/// the first threadable move does; the rest are fruited.
pub fn resolve_moves(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
) -> MovePlan {
    let mut plan = MovePlan { target_any: matches!(spec.pal, TargetPal::Any), ..MovePlan::default() };
    if spec.required_moves.is_empty() {
        return plan;
    }
    let fruit_on = cfg.skill_fruit.is_some();
    let learnset: HashSet<&str> = match spec.pal {
        TargetPal::Species(idx) => gd.learnset(idx).iter().map(|lm| lm.waza_id.as_str()).collect(),
        TargetPal::Any => HashSet::new(),
    };

    // Classify each required move (deduped, order-preserving). Learnset moves are
    // auto-satisfied; the rest are breeding-required.
    let mut seen = HashSet::new();
    let mut breeding: Vec<ReqMove> = Vec::new();
    for id in &spec.required_moves {
        if !seen.insert(id.as_str()) {
            continue;
        }
        let (name, inheritable, fruitable) = match gd.active_skill(id) {
            Some(a) => (a.name.clone(), a.can_inherit, a.has_skill_fruit),
            None => {
                // Unknown move id (the request layer rejects these first);
                // defensively hard-block so no plan is fabricated.
                plan.blockers.push(NoPathReason::MissingMoveCarrier {
                    move_id: id.clone(),
                    move_name: id.clone(),
                    inheritable: false,
                    fruit_available: false,
                    fruit_off: false,
                });
                continue;
            }
        };
        if learnset.contains(id.as_str()) {
            plan.levelup_moves.push(name);
            continue;
        }
        let has_carrier = owned.iter().any(|p| p.active_skills.contains(id));
        breeding.push(ReqMove { id: id.clone(), name, inheritable, fruitable, has_carrier });
    }

    // (1) Moves obtainable by neither threading (inheritable AND owned-carrier)
    // nor fruit: hard blockers. `inheritable` echoes the intrinsic move flag.
    for m in &breeding {
        let threadable = m.inheritable && m.has_carrier;
        if !threadable && !m.fruitable {
            plan.blockers.push(NoPathReason::MissingMoveCarrier {
                move_id: m.id.clone(),
                move_name: m.name.clone(),
                inheritable: m.inheritable,
                fruit_available: false,
                fruit_off: false,
            });
        }
    }

    // Non-fruitable, threadable moves MUST use the single breeding slot.
    let must_breed: Vec<&ReqMove> =
        breeding.iter().filter(|m| !m.fruitable && m.inheritable && m.has_carrier).collect();

    // (2) Cap: only one move threads. A second must-breed move is a blocker
    // (inheritable, but no fruit and no free slot).
    if must_breed.len() >= 2 {
        for m in &must_breed[1..] {
            plan.blockers.push(NoPathReason::MissingMoveCarrier {
                move_id: m.id.clone(),
                move_name: m.name.clone(),
                inheritable: true,
                fruit_available: false,
                fruit_off: false,
            });
        }
    }

    if !plan.blockers.is_empty() {
        return plan; // unsatisfiable — skip threaded/fruit assignment
    }

    // (3) Choose the threaded move: the sole must-breed move, else the first
    // threadable move (saves a fruit cost), else none.
    let threaded_id: Option<String> = if must_breed.len() == 1 {
        Some(must_breed[0].id.clone())
    } else {
        breeding.iter().find(|m| m.inheritable && m.has_carrier).map(|m| m.id.clone())
    };

    // Remaining breeding-required moves become fruit steps (they are all fruitable
    // here — non-fruitable non-threaded moves were blocked in (1)/(2)).
    for m in &breeding {
        if Some(&m.id) == threaded_id.as_ref() {
            plan.threaded_move = Some(m.id.clone());
            plan.threaded_move_name = Some(m.name.clone());
            continue;
        }
        if fruit_on {
            plan.fruit_moves.push((m.id.clone(), m.name.clone()));
        } else {
            plan.blockers.push(NoPathReason::MissingMoveCarrier {
                move_id: m.id.clone(),
                move_name: m.name.clone(),
                inheritable: m.inheritable,
                fruit_available: true,
                fruit_off: true,
            });
        }
    }

    if !plan.blockers.is_empty() {
        // Fruit needed but off: unsatisfiable. Clear partial threaded/fruit state.
        plan.threaded_move = None;
        plan.threaded_move_name = None;
        plan.fruit_moves.clear();
    }
    plan
}

/// Species indices present in the owned pool.
fn owned_species(gd: &GameData, owned: &[OwnedPal]) -> HashSet<u16> {
    owned.iter().filter_map(|p| gd.species_index(&p.character_id)).collect()
}

/// Reachability source set: owned species, plus every wild-catchable species
/// when unowned sourcing is enabled (mirrors the wild seeding in
/// `engine::build_initial_content`).
fn source_species(gd: &GameData, owned: &[OwnedPal], cfg: &SolverConfig) -> HashSet<u16> {
    let mut set = owned_species(gd, owned);
    if cfg.include_wild {
        for (idx, sp) in gd.species().enumerate() {
            if sp.wild_levels.0 > 0 {
                set.insert(idx as u16);
            }
        }
    }
    set
}

/// Diagnose why a solve toward `spec` over the scoped `owned` pool with `cfg`
/// produced no plans. Call ONLY when the solve returned zero plans. Returns the
/// blocking reasons in priority order (a→e); an empty pool or fully-blocked
/// combination always yields at least one reason.
pub fn diagnose_no_path(
    gd: &GameData,
    spec: &TargetSpec,
    owned: &[OwnedPal],
    cfg: &SolverConfig,
) -> Vec<NoPathReason> {
    let mut spec = spec.clone();
    spec.normalize();

    // (a) Required passives with no carrier in the pool. Wild catches cannot
    // supply a passive that is not a species-innate guaranteed passive on some
    // catchable species, so those are still reported when unowned sourcing is
    // on. All missing-carrier reasons are returned together — each is an
    // independent, concrete blocker.
    // Surgery implants can cover up to `max_implants` missing REQUIRED passives.
    // When surgery covers every missing carrier, this is not a blocker — fall
    // through to the reachability/gender checks so diagnosis matches the engine's
    // surgery-aware satisfaction. Special lottery-tier passives (Rainbow/
    // WorldTree) are refused by the in-game table: they are never coverable, and
    // `surgery_off` stays false for them so the UI never suggests a dead remedy.
    let max_implants = cfg.surgery.as_ref().map(SurgeryConfig::implants).unwrap_or(0);
    let surgery_is_off = cfg.surgery.is_none();
    let implantable =
        |pid: &String| gd.passive_by_id(pid).is_none_or(|ps| ps.tier.is_none());
    let mut missing_pids: Vec<&String> = Vec::new();
    for pid in &spec.required_passives {
        if owned.iter().any(|p| p.passives.contains(pid)) {
            continue;
        }
        let wild_can_supply = cfg.include_wild
            && gd
                .species()
                .any(|sp| sp.wild_levels.0 > 0 && sp.guaranteed_passives.contains(pid));
        if wild_can_supply {
            continue;
        }
        missing_pids.push(pid);
    }
    // Surgery (when on) covers the gap entirely: not a carrier blocker. Any
    // unimplantable missing passive keeps the blocker regardless of implants.
    let all_coverable = missing_pids.iter().all(|pid| implantable(pid));
    if !(all_coverable && max_implants as usize >= missing_pids.len() && max_implants > 0)
        && !missing_pids.is_empty()
    {
        let missing: Vec<NoPathReason> = missing_pids
            .iter()
            .map(|pid| {
                let passive_name =
                    gd.passive_by_id(pid).map(|p| p.name.clone()).unwrap_or_else(|| (*pid).clone());
                NoPathReason::MissingPassiveCarrier {
                    passive_id: (*pid).clone(),
                    passive_name,
                    wild_sourcing_enabled: cfg.include_wild,
                    surgery_off: surgery_is_off && implantable(pid),
                }
            })
            .collect();
        return missing;
    }

    // (a2) Required active-skill moves the pool cannot deliver. Resolves the same
    // way the engine does (learnset auto-satisfy, single-thread breeding slot,
    // Skill-Fruit relaxation) and reports each uncoverable move. When the
    // Skill-Fruit relaxation is ON and every non-threaded required move is
    // fruitable, this is NOT a blocker (mirrors the surgery coverage logic).
    let move_plan = resolve_moves(gd, &spec, owned, cfg);
    if !move_plan.blockers.is_empty() {
        return move_plan.blockers;
    }

    // (b)/(c) Species reachability in the breeding graph.
    if let TargetPal::Species(target) = spec.pal {
        let cap = cfg.max_breeding_steps;
        let sources = source_species(gd, owned, cfg);
        let pool_min = sources
            .iter()
            .map(|&s| gd.min_steps(s, target))
            .filter(|&d| d != UNREACHABLE)
            .min();
        match pool_min {
            None => {
                // Unreachable from the pool. Report the global minimum for
                // context (breedable from other roots vs. only catchable).
                let global_min = gd
                    .species()
                    .enumerate()
                    .map(|(s, _)| gd.min_steps(s as u16, target))
                    .filter(|&d| d != UNREACHABLE)
                    .min()
                    .map(|d| d as u32);
                return vec![NoPathReason::TargetSpeciesUnreachable { min_steps: global_min }];
            }
            Some(d) if d as u32 > cap => {
                return vec![NoPathReason::StepCapTooLow { needed: d as u32, cap }];
            }
            Some(_) => {}
        }
    }

    // (d) Cheaply-provable gender bottleneck: the owned pool is a single species
    // with every instance sharing one gender, and unowned sourcing is off — so
    // no pair can be formed (breeding requires opposite genders). Robust
    // cross-species gender-flip detection is intractable here and is left to the
    // fallback below (see the slice report).
    if !cfg.include_wild {
        let species_set = owned_species(gd, owned);
        if species_set.len() == 1 {
            let genders: HashSet<Gender> = owned.iter().filter_map(|p| p.gender).collect();
            if genders.len() == 1 {
                let s = *species_set.iter().next().unwrap();
                if let Some(sp) = gd.species_at(s) {
                    return vec![NoPathReason::GenderBottleneck { species_name: sp.name.clone() }];
                }
            }
        }
    }

    // (e) Fallback: nothing above proved.
    vec![NoPathReason::ExhaustedSearch {}]
}

#[cfg(test)]
mod tests {
    use super::*;
    use pal_data::types::{ContainerKind, IvSet};
    use pal_data::GameData;

    use crate::solver::resolve::{resolve_passive, resolve_species};

    /// A synthetic owned pal: `species`/`gender` with the given real passives.
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

    fn spec_for(gd: &GameData, species: &str, passives: &[&str]) -> TargetSpec {
        let target = resolve_species(gd, species).expect("target species");
        let mut spec = TargetSpec::new(TargetPal::Species(target));
        spec.required_passives = passives
            .iter()
            .map(|p| resolve_passive(gd, p).expect("passive resolves"))
            .collect();
        spec
    }

    /// The first breeding recipe `(a, b) -> t` with three distinct species,
    /// resolved through `child_of` (gender-aware, orientation-safe). Used to
    /// seed a pool that reaches the target species-wise in one step.
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

    /// (a) A required passive no owned pal carries -> MissingPassiveCarrier,
    /// with the reachable-species pool present so reachability is NOT the cause.
    #[test]
    fn missing_passive_carrier_reported() {
        let gd = GameData::get();
        let (a, b, target) = find_recipe(gd);
        // Own both parents (opposite genders), neither carrying "Swift".
        let pool = vec![owned(gd, a, Gender::Male, &[]), owned(gd, b, Gender::Female, &[])];
        let mut spec = TargetSpec::new(TargetPal::Species(target));
        spec.required_passives = vec![resolve_passive(gd, "Swift").unwrap()];
        let cfg = SolverConfig { include_wild: false, ..SolverConfig::default() };
        let reasons = diagnose_no_path(gd, &spec, &pool, &cfg);
        let swift = resolve_passive(gd, "Swift").unwrap();
        let name =
            gd.passive_by_id(&swift).map(|p| p.name.clone()).unwrap_or_else(|| swift.clone());
        assert_eq!(
            reasons,
            vec![NoPathReason::MissingPassiveCarrier {
                passive_id: swift,
                passive_name: name,
                wild_sourcing_enabled: false,
                surgery_off: true,
            }]
        );
    }

    /// (a2) With unowned sourcing on, a non-innate passive is STILL missing:
    /// wild pals only carry random passives, so the flag is set but the reason
    /// still fires.
    #[test]
    fn missing_passive_carrier_wild_cannot_help() {
        let gd = GameData::get();
        let pool: Vec<OwnedPal> = vec![];
        let spec = spec_for(gd, "Anubis", &["Swift"]);
        let cfg = SolverConfig { include_wild: true, ..SolverConfig::default() };
        let reasons = diagnose_no_path(gd, &spec, &pool, &cfg);
        assert!(reasons.iter().any(|r| matches!(
            r,
            NoPathReason::MissingPassiveCarrier { wild_sourcing_enabled: true, .. }
        )));
    }

    /// (b) A pool that cannot reach the target species (no carriers issue) ->
    /// TargetSpeciesUnreachable. Uses an empty passive requirement and a pool of
    /// one unrelated species with both genders so gender/carrier are not the
    /// cause.
    #[test]
    fn target_species_unreachable_reported() {
        let gd = GameData::get();
        // Pick a target and a source species that cannot reach it.
        let target = resolve_species(gd, "Jetragon").expect("Jetragon");
        // Find a species with no path to the target.
        let src = (0..gd.species().count() as u16)
            .find(|&s| s != target && gd.min_steps(s, target) == UNREACHABLE)
            .expect("some unreachable source exists");
        let pool = vec![
            owned(gd, src, Gender::Male, &[]),
            owned(gd, src, Gender::Female, &[]),
        ];
        let mut spec = TargetSpec::new(TargetPal::Species(target));
        spec.required_passives = vec![];
        let cfg = SolverConfig { include_wild: false, ..SolverConfig::default() };
        let reasons = diagnose_no_path(gd, &spec, &pool, &cfg);
        assert!(
            matches!(reasons.as_slice(), [NoPathReason::TargetSpeciesUnreachable { .. }]),
            "got {reasons:?}"
        );
    }

    /// (c) Target reachable from the pool but only beyond the step cap ->
    /// StepCapTooLow with the real needed count.
    #[test]
    fn step_cap_too_low_reported() {
        let gd = GameData::get();
        // Find a (source, target) pair reachable in >1 step, then set cap below.
        let n = gd.species().count() as u16;
        let mut found = None;
        'outer: for t in 0..n {
            for s in 0..n {
                let d = gd.min_steps(s, t);
                if d != UNREACHABLE && d >= 2 {
                    found = Some((s, t, d));
                    break 'outer;
                }
            }
        }
        let (src, target, dist) = found.expect("a >=2-step reachable pair exists");
        let pool = vec![
            owned(gd, src, Gender::Male, &[]),
            owned(gd, src, Gender::Female, &[]),
        ];
        let mut spec = TargetSpec::new(TargetPal::Species(target));
        spec.required_passives = vec![];
        let cap = (dist as u32) - 1;
        let cfg = SolverConfig {
            include_wild: false,
            max_breeding_steps: cap,
            max_solver_iterations: cap,
            ..SolverConfig::default()
        };
        let reasons = diagnose_no_path(gd, &spec, &pool, &cfg);
        assert_eq!(reasons, vec![NoPathReason::StepCapTooLow { needed: dist as u32, cap }]);
    }

    /// (d) Single-species, single-gender pool with the target reachable within
    /// cap and no missing passive -> GenderBottleneck.
    #[test]
    fn gender_bottleneck_reported() {
        let gd = GameData::get();
        // A self-pair-only species reachable in 0 steps from itself.
        let target = resolve_species(gd, "Jetragon").expect("Jetragon");
        let pool = vec![owned(gd, target, Gender::Male, &[])];
        let mut spec = TargetSpec::new(TargetPal::Species(target));
        spec.required_passives = vec![];
        let cfg = SolverConfig { include_wild: false, ..SolverConfig::default() };
        let reasons = diagnose_no_path(gd, &spec, &pool, &cfg);
        assert!(
            matches!(reasons.as_slice(), [NoPathReason::GenderBottleneck { .. }]),
            "got {reasons:?}"
        );
    }

    /// (e) Fallback: a mixed-gender, multi-species pool that reaches the target
    /// species-wise within cap but still finds no plan falls through to
    /// ExhaustedSearch (no carrier/reachability/gender proof).
    #[test]
    fn exhausted_search_fallback() {
        let gd = GameData::get();
        let (a, b, target) = find_recipe(gd);
        // Two distinct species, both genders present -> not single-species; no
        // required passives -> no missing carrier; reachable within default cap.
        let pool = vec![
            owned(gd, a, Gender::Male, &[]),
            owned(gd, a, Gender::Female, &[]),
            owned(gd, b, Gender::Male, &[]),
            owned(gd, b, Gender::Female, &[]),
        ];
        let mut spec = TargetSpec::new(TargetPal::Species(target));
        spec.required_passives = vec![];
        let cfg = SolverConfig { include_wild: false, ..SolverConfig::default() };
        let reasons = diagnose_no_path(gd, &spec, &pool, &cfg);
        assert_eq!(reasons, vec![NoPathReason::ExhaustedSearch {}]);
    }

    /// Payload contract: each variant serializes internally-tagged on `kind`
    /// (snake_case) so the frontend can discriminate. Guards Main's smoke shape.
    #[test]
    fn serde_tag_shape() {
        let cases = [
            (
                NoPathReason::MissingPassiveCarrier {
                    passive_id: "Swift".into(),
                    passive_name: "Swift".into(),
                    wild_sourcing_enabled: true,
                    surgery_off: false,
                },
                r#"{"kind":"missing_passive_carrier","passive_id":"Swift","passive_name":"Swift","wild_sourcing_enabled":true}"#,
            ),
            (
                NoPathReason::TargetSpeciesUnreachable { min_steps: Some(6) },
                r#"{"kind":"target_species_unreachable","min_steps":6}"#,
            ),
            (
                NoPathReason::TargetSpeciesUnreachable { min_steps: None },
                r#"{"kind":"target_species_unreachable","min_steps":null}"#,
            ),
            (
                NoPathReason::StepCapTooLow { needed: 6, cap: 5 },
                r#"{"kind":"step_cap_too_low","needed":6,"cap":5}"#,
            ),
            (
                NoPathReason::GenderBottleneck { species_name: "Wumpo".into() },
                r#"{"kind":"gender_bottleneck","species_name":"Wumpo"}"#,
            ),
            (NoPathReason::ExhaustedSearch {}, r#"{"kind":"exhausted_search"}"#),
            (
                NoPathReason::SearchBudgetExhausted { budget_secs: 120.0 },
                r#"{"kind":"search_budget_exhausted","budget_secs":120.0}"#,
            ),
        ];
        for (reason, want) in cases {
            assert_eq!(serde_json::to_string(&reason).unwrap(), want);
        }
    }
}
