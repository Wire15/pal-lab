//! Serializable breeding-plan tree returned to callers (a Tauri command wraps
//! this next phase, so every node is `Serialize`/`Deserialize`).

use std::collections::HashSet;

use pal_data::types::{Gender, Guid, PassiveId};
use pal_data::GameData;
use serde::{Deserialize, Serialize};

use crate::solver::config::CakeKind;
use crate::solver::refs::{BredPalRef, EffPassive, PalRef, RefGender};

/// How a plan node is obtained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanSource {
    /// An owned pal, at a storage location. `instance_id` identifies the
    /// representative owned instance (queue synthetic seeds carry a
    /// `QUEUED`-prefixed id that won't resolve to a real save pal).
    Owned { location: String, instance_id: Guid },
    /// A wild pal to catch. `captures` = estimated catches for the needed
    /// gender; `min_wild_level` = the species' minimum wild spawn level (0 when
    /// the pack has no wild-spawn record).
    Wild { captures: u32, min_wild_level: u16 },
    /// A bred child of the two `children`.
    Bred,
}

/// Per-egg factor breakdown for a bred step: the independent probabilities whose
/// product drives the step's egg estimate. `passives` and `ivs` are always
/// present; `move_pass` is set only when a required move threads this step;
/// `gender` is set only when the child's gender is constrained by downstream use
/// (both fold into `PlanNode::expected_eggs`). Absent factors are omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepOdds {
    /// P(inherit all desired passives) for this step.
    pub passives: f64,
    /// P(inherit all required IVs) for this step.
    pub ivs: f64,
    /// Per-egg P(threaded move passes) — `None` when no move threads this step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub move_pass: Option<f64>,
    /// P(child rolls the needed gender) — `None` when gender is unconstrained.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<f64>,
}

/// One node of a breeding plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanNode {
    pub species: u16,
    pub species_name: String,
    /// `None` = unresolved/wildcard gender.
    pub gender: Option<Gender>,
    /// Human-readable passive slots (target internal ids and `"(random)"`).
    pub passives: Vec<String>,
    pub source: PlanSource,
    /// Per-node success probability (bred: passives*IVs; owned/wild: 1.0).
    pub probability: f64,
    /// Estimated seconds for THIS node's own step (self effort).
    pub est_time_secs: f64,
    pub children: Vec<PlanNode>,
    /// Bred nodes only: P(inherit all desired passives) for THIS step. Absent
    /// on owned/wild. `probability == prob_passives * prob_ivs` exactly (gender
    /// resolution is NOT folded into either factor — see `expected_eggs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prob_passives: Option<f64>,
    /// Bred nodes only: P(inherit all required IVs) for THIS step. Absent on
    /// owned/wild.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prob_ivs: Option<f64>,
    /// Bred nodes only: expected eggs for THIS node's own step
    /// (`BredPalRef::avg_required_breedings`, PER-NODE — NOT the cumulative
    /// `num_eggs`). Includes the gender-resolution penalty, so it is generally
    /// larger than `ceil(1 / (prob_passives * prob_ivs))`. Absent on owned/wild.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_eggs: Option<u32>,
    /// Bred nodes only: minimum inherited-IV floor `[hp,atk,def]` this node must
    /// carry for the chain to stay viable — the (cake-effective) spec threshold
    /// on stats still relevant at this node, `0` on unconstrained stats. Absent
    /// on owned/wild.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iv_targets: Option<[u8; 3]>,
    /// Set on a PARENT node that a gender reverser flipped to make its pairing
    /// viable (see `SolverConfig::gender_reverser`). Skipped when `false` so
    /// plans without a reverser are byte-identical to pre-reverser output.
    #[serde(default, skip_serializing_if = "is_false")]
    pub gender_reversed: bool,
    /// Set on the bred node where the THREADED active-skill move is first
    /// inherited from a carrying parent (the deepest node in the threading
    /// chain). Display name of the move. Skipped when absent so plans without a
    /// threaded move are byte-identical to pre-moves output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherited_move: Option<String>,
    /// Bred nodes only: the per-egg factor breakdown behind `expected_eggs`
    /// (passives × IVs × move × gender). Absent on owned/wild. `#[serde(default,
    /// skip_serializing_if)]` keeps pre-odds payloads byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub odds: Option<StepOdds>,
    /// Set on a bred INTERMEDIATE whose sole effect is diluting the junk-passive
    /// pool: its own passive pool is strictly smaller than the deduped union of
    /// its parents' pools, it carries no REQUIRED passive, and it threads no
    /// required move. Lets the UI flag passive-laundering steps ("CLEANS LINE").
    /// Skipped when `false` so ordinary plans stay byte-identical.
    #[serde(default, skip_serializing_if = "is_false")]
    pub washes_passives: bool,
}

/// A full plan, best-first orderable by `total_time_secs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreedingPlan {
    pub root: PlanNode,
    pub total_time_secs: f64,
    pub total_steps: u32,
    pub total_wild_pals: u32,
    /// The cake used for this plan (default [`CakeKind::Normal`] — no cake).
    pub cake: CakeKind,
    /// Estimated total cakes consumed across every breeding step (one cake per
    /// breeding attempt). `0` for [`CakeKind::Normal`]. Lets the UI show
    /// "needs ~N cakes".
    pub cake_count: u32,
    /// Surgery-table implants applied to the FINAL pal (empty = no surgery). Each
    /// step is one required passive covered from the surgery table, with its
    /// time-cost estimate. The implanted passives also appear in `root.passives`
    /// (they are on the delivered pal); this list marks their provenance.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surgery: Vec<SurgeryStep>,
    /// Skill-Fruit steps applied to the FINAL pal (empty = none). Each teaches
    /// one REQUIRED active-skill move that breeding did not thread, with its
    /// time-cost estimate. Mirrors `surgery` for moves. `#[serde(default,
    /// skip_serializing_if)]` keeps move-free plans byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fruits: Vec<FruitStep>,
    /// REQUIRED moves satisfied by the TARGET species' own learnset — obtained
    /// by leveling, no breeding or fruit needed. Display names. Empty when no
    /// such move was requested. `#[serde(default, skip_serializing_if)]` keeps
    /// move-free plans byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub levelup_moves: Vec<String>,
}

/// One surgery-table implant on a plan's final pal: a required passive the bred
/// (or owned) pal lacked, covered from the surgery table for `cost_secs` (the
/// caller's time-cost estimate).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SurgeryStep {
    pub passive_id: String,
    pub passive_name: String,
    pub cost_secs: f64,
}

/// One Skill-Fruit step on a plan's final pal: a required active-skill move the
/// bred (or owned) pal did not carry from breeding, taught via a Skill Fruit for
/// `cost_secs` (the caller's time-cost estimate). Mirrors [`SurgeryStep`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FruitStep {
    pub move_id: String,
    pub move_name: String,
    pub cost_secs: f64,
}

/// serde `skip_serializing_if` predicate for a `false` bool.
fn is_false(b: &bool) -> bool {
    !*b
}

/// A target-satisfying reference plus its terminal relaxations. `implants` lists
/// the REQUIRED passives covered by surgery-table implants (each costing
/// `surgery_cost_each`); `fruits` lists the REQUIRED active-skill moves covered
/// by Skill Fruit (each costing `fruit_cost_each`) — both empty = exact
/// satisfaction. Ranking uses [`Self::effort`] (reference effort plus implant and
/// fruit costs), so a cheaper exact/threaded plan keeps priority. `levelup_moves`
/// and `threaded_move_name` are solve-level move context carried through so
/// [`BreedingPlan::from_solved`] can populate the plan (not serialized here).
#[derive(Debug, Clone)]
pub struct SolvedRef {
    pub reference: PalRef,
    pub implants: Vec<PassiveId>,
    pub surgery_cost_each: f64,
    /// Required moves covered by Skill Fruit on the final pal: (move_id, move_name).
    pub fruits: Vec<(String, String)>,
    pub fruit_cost_each: f64,
    /// Display name of the move threaded through breeding (for `inherited_move`).
    pub threaded_move_name: Option<String>,
    /// Required moves satisfied by the target's own learnset (display names).
    pub levelup_moves: Vec<String>,
}

impl SolvedRef {
    /// An exactly-satisfying reference (no surgery, no fruit, no threaded move).
    #[inline]
    pub fn exact(reference: PalRef) -> SolvedRef {
        SolvedRef {
            reference,
            implants: Vec::new(),
            surgery_cost_each: 0.0,
            fruits: Vec::new(),
            fruit_cost_each: 0.0,
            threaded_move_name: None,
            levelup_moves: Vec::new(),
        }
    }

    /// Ranking effort: the reference's own effort plus every implant and fruit cost.
    #[inline]
    pub fn effort(&self) -> f64 {
        self.reference.total_effort()
            + self.implants.len() as f64 * self.surgery_cost_each
            + self.fruits.len() as f64 * self.fruit_cost_each
    }
}

fn gender_opt(g: RefGender) -> Option<Gender> {
    g.concrete()
}

fn passive_labels(passives: &[EffPassive]) -> Vec<String> {
    passives
        .iter()
        .map(|p| match p {
            EffPassive::Desired(id) => id.clone(),
            EffPassive::Random => "(random)".to_string(),
        })
        .collect()
}

/// Whether a bred node is a passive-laundering intermediate: a step whose sole
/// effect is diluting the junk-passive pool. True iff it threads no required
/// move, carries no REQUIRED (desired) passive of its own, and its passive pool
/// is strictly smaller than the deduped union of its parents' pools. A node that
/// carries a required passive is a productive consolidation (the final target
/// carries its required passives), so it never counts as washing.
fn washes_passives(b: &BredPalRef) -> bool {
    if b.carries_move {
        return false;
    }
    if b.effective_passives.iter().any(|p| matches!(p, EffPassive::Desired(_))) {
        return false;
    }
    let own = b.effective_passives.len();
    let (n1, r1) = b.parent1.pool_contribution();
    let (n2, r2) = b.parent2.pool_contribution();
    let mut union: HashSet<PassiveId> = n1.into_iter().collect();
    union.extend(n2);
    own < union.len() + (r1 + r2) as usize
}

fn node_of(gd: &GameData, r: &PalRef, iv_thresholds: [u8; 3], threaded_name: Option<&str>) -> PlanNode {
    let species = r.species();
    let species_name = gd
        .species_at(species)
        .map(|s| s.name.clone())
        .unwrap_or_else(|| format!("#{species}"));
    let passives = passive_labels(r.effective_passives());
    let (source, probability, children, prob_passives, prob_ivs, expected_eggs, iv_targets) =
        match r {
            PalRef::Owned(o) => (
                PlanSource::Owned {
                    location: format!("{:?}", o.primary.container),
                    instance_id: o.primary.instance_id,
                },
                1.0,
                Vec::new(),
                None,
                None,
                None,
                None,
            ),
            PalRef::Wild(w) => (
                PlanSource::Wild { captures: w.captures_required, min_wild_level: w.min_wild_level },
                1.0,
                Vec::new(),
                None,
                None,
                None,
                None,
            ),
            PalRef::Bred(b) => {
                // A stat's floor is carried through this node iff its IV is still
                // relevant here; the threshold is the (cake-effective) spec value.
                let iv_targets = [
                    if b.ivs.hp.relevant { iv_thresholds[0] } else { 0 },
                    if b.ivs.attack.relevant { iv_thresholds[1] } else { 0 },
                    if b.ivs.defense.relevant { iv_thresholds[2] } else { 0 },
                ];
                (
                    PlanSource::Bred,
                    b.passives_prob * b.ivs_prob,
                    {
                        let mut c1 = node_of(gd, &b.parent1, iv_thresholds, threaded_name);
                        let mut c2 = node_of(gd, &b.parent2, iv_thresholds, threaded_name);
                        match b.reversed_parent {
                            1 => c1.gender_reversed = true,
                            2 => c2.gender_reversed = true,
                            _ => {}
                        }
                        vec![c1, c2]
                    },
                    Some(b.passives_prob),
                    Some(b.ivs_prob),
                    Some(b.avg_required_breedings),
                    Some(iv_targets),
                )
            }
        };
    // The threaded move is first inherited at the DEEPEST bred node carrying it
    // (no bred child carries it — its carrying parent is the owned source).
    let inherited_move = match r {
        PalRef::Bred(b) => threaded_name.and_then(|name| {
            let child_bred_carries = (b.parent1.is_bred() && b.parent1.carries_move())
                || (b.parent2.is_bred() && b.parent2.carries_move());
            (b.carries_move && !child_bred_carries).then(|| name.to_string())
        }),
        _ => None,
    };
    // Per-egg factor breakdown + laundering flag (bred nodes only). The gender
    // factor is present exactly when this node's gender was resolved downstream
    // (folded into `expected_eggs`); `move_pass` exactly when the move threads
    // this step (each threading node re-rolls, so it appears on the whole chain).
    let (odds, washes_passives) = match r {
        PalRef::Bred(b) => {
            let gender = match b.gender {
                RefGender::Wildcard => None,
                g => {
                    let (male, female) = gd.gender_probability(b.species).unwrap_or((0.5, 0.5));
                    Some(match g {
                        RefGender::Male => male as f64,
                        RefGender::Female => female as f64,
                        RefGender::Wildcard => 1.0,
                    })
                }
            };
            let move_pass = (b.carries_move && b.move_prob > 0.0).then_some(b.move_prob);
            let odds = StepOdds { passives: b.passives_prob, ivs: b.ivs_prob, move_pass, gender };
            (Some(odds), washes_passives(b))
        }
        _ => (None, false),
    };
    PlanNode {
        species,
        species_name,
        gender: gender_opt(r.gender()),
        passives,
        source,
        probability,
        est_time_secs: r.self_effort(),
        children,
        prob_passives,
        prob_ivs,
        expected_eggs,
        iv_targets,
        gender_reversed: false,
        inherited_move,
        odds,
        washes_passives,
    }
}

impl BreedingPlan {
    /// Build a plan from a solved reference, tagged with the `cake` it was
    /// solved for. `cake_count` sums the estimated breeding attempts over every
    /// bred node (one cake per attempt); zero for [`CakeKind::Normal`].
    /// `iv_thresholds` are the cake-effective spec IV floors `[hp,atk,def]`
    /// used to populate each bred node's `iv_targets`.
    pub fn from_ref(
        gd: &GameData,
        r: &PalRef,
        cake: CakeKind,
        iv_thresholds: [u8; 3],
    ) -> BreedingPlan {
        BreedingPlan::skeleton(gd, r, cake, iv_thresholds, None)
    }

    /// Shared plan skeleton: node tree (tagging `inherited_move` for
    /// `threaded_name`) plus the base totals. No relaxations folded in.
    fn skeleton(
        gd: &GameData,
        r: &PalRef,
        cake: CakeKind,
        iv_thresholds: [u8; 3],
        threaded_name: Option<&str>,
    ) -> BreedingPlan {
        let cake_count = if cake.consumes_cakes() { cake_attempts(r) } else { 0 };
        BreedingPlan {
            root: node_of(gd, r, iv_thresholds, threaded_name),
            total_time_secs: r.total_effort(),
            total_steps: r.num_breeding_steps(),
            total_wild_pals: r.num_wild_pals(),
            cake,
            cake_count,
            surgery: Vec::new(),
            fruits: Vec::new(),
            levelup_moves: Vec::new(),
        }
    }

    /// Build a plan from a [`SolvedRef`]: the exact-satisfaction plan for its
    /// reference, plus surgery-table implants AND Skill-Fruit moves folded in.
    /// Implanted passives are appended to the root's passive slots; each
    /// relaxation's summed cost is added to `total_time_secs`; `surgery` /
    /// `fruits` record provenance; `levelup_moves` lists learnset-satisfied
    /// moves. Probability math is untouched — both are terminal steps, not
    /// inheritance events. The threaded move (if any) is already reflected on the
    /// bred nodes (`inherited_move`) and in the reference effort.
    pub fn from_solved(
        gd: &GameData,
        sr: &SolvedRef,
        cake: CakeKind,
        iv_thresholds: [u8; 3],
    ) -> BreedingPlan {
        let mut plan =
            BreedingPlan::skeleton(gd, &sr.reference, cake, iv_thresholds, sr.threaded_move_name.as_deref());
        if !sr.implants.is_empty() {
            let steps: Vec<SurgeryStep> = sr
                .implants
                .iter()
                .map(|pid| SurgeryStep {
                    passive_id: pid.clone(),
                    passive_name: gd
                        .passive_by_id(pid)
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| pid.clone()),
                    cost_secs: sr.surgery_cost_each,
                })
                .collect();
            for pid in &sr.implants {
                plan.root.passives.push(pid.clone());
            }
            plan.total_time_secs += sr.implants.len() as f64 * sr.surgery_cost_each;
            plan.surgery = steps;
        }
        if !sr.fruits.is_empty() {
            plan.fruits = sr
                .fruits
                .iter()
                .map(|(id, name)| FruitStep {
                    move_id: id.clone(),
                    move_name: name.clone(),
                    cost_secs: sr.fruit_cost_each,
                })
                .collect();
            plan.total_time_secs += sr.fruits.len() as f64 * sr.fruit_cost_each;
        }
        plan.levelup_moves = sr.levelup_moves.clone();
        plan
    }
}

/// True when a plan's root is a direct wild catch with no breeding — a trivial
/// "just catch the target" plan (contract: catch-the-target should never crowd
/// out real breeding chains).
pub fn is_trivial_wild_plan(p: &BreedingPlan) -> bool {
    matches!(p.root.source, PlanSource::Wild { .. }) && p.total_steps == 0
}

/// Drop trivial catch-the-target plans ([`is_trivial_wild_plan`]) whenever any
/// non-trivial plan survives. When *every* plan is a trivial wild catch (the
/// target is only obtainable by catching it — no owned pair, self-pair-only
/// legendary, etc.), the plans are returned unchanged so the UI can render the
/// catch-only callout from the sole plan.
pub fn filter_trivial_wild(plans: Vec<BreedingPlan>) -> Vec<BreedingPlan> {
    if plans.iter().any(|p| !is_trivial_wild_plan(p)) {
        plans.into_iter().filter(|p| !is_trivial_wild_plan(p)).collect()
    } else {
        plans
    }
}

/// Sum estimated breeding attempts over every bred node in the plan tree.
fn cake_attempts(r: &PalRef) -> u32 {
    match r {
        PalRef::Bred(b) => {
            b.attempts_estimate()
                .saturating_add(cake_attempts(&b.parent1))
                .saturating_add(cake_attempts(&b.parent2))
        }
        _ => 0,
    }
}
