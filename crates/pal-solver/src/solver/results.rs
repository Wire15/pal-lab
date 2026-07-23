//! Serializable breeding-plan tree returned to callers (a Tauri command wraps
//! this next phase, so every node is `Serialize`/`Deserialize`).

use pal_data::types::{Gender, Guid};
use pal_data::GameData;
use serde::{Deserialize, Serialize};

use crate::solver::config::CakeKind;
use crate::solver::refs::{EffPassive, PalRef, RefGender};

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

fn node_of(gd: &GameData, r: &PalRef, iv_thresholds: [u8; 3]) -> PlanNode {
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
                    vec![
                        node_of(gd, &b.parent1, iv_thresholds),
                        node_of(gd, &b.parent2, iv_thresholds),
                    ],
                    Some(b.passives_prob),
                    Some(b.ivs_prob),
                    Some(b.avg_required_breedings),
                    Some(iv_targets),
                )
            }
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
        let cake_count = if cake.consumes_cakes() { cake_attempts(r) } else { 0 };
        BreedingPlan {
            root: node_of(gd, r, iv_thresholds),
            total_time_secs: r.total_effort(),
            total_steps: r.num_breeding_steps(),
            total_wild_pals: r.num_wild_pals(),
            cake,
            cake_count,
        }
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
