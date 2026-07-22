//! Serializable breeding-plan tree returned to callers (a Tauri command wraps
//! this next phase, so every node is `Serialize`/`Deserialize`).

use pal_data::types::Gender;
use pal_data::GameData;
use serde::{Deserialize, Serialize};

use crate::solver::config::CakeKind;
use crate::solver::refs::{EffPassive, PalRef, RefGender};

/// How a plan node is obtained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanSource {
    /// An owned pal, at a storage location.
    Owned { location: String },
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

fn node_of(gd: &GameData, r: &PalRef) -> PlanNode {
    let species = r.species();
    let species_name = gd
        .species_at(species)
        .map(|s| s.name.clone())
        .unwrap_or_else(|| format!("#{species}"));
    let passives = passive_labels(r.effective_passives());
    let (source, probability, children) = match r {
        PalRef::Owned(o) => (
            PlanSource::Owned { location: format!("{:?}", o.primary.container) },
            1.0,
            Vec::new(),
        ),
        PalRef::Wild(w) => (
            PlanSource::Wild { captures: w.captures_required, min_wild_level: w.min_wild_level },
            1.0,
            Vec::new(),
        ),
        PalRef::Bred(b) => (
            PlanSource::Bred,
            b.passives_prob * b.ivs_prob,
            vec![node_of(gd, &b.parent1), node_of(gd, &b.parent2)],
        ),
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
    }
}

impl BreedingPlan {
    /// Build a plan from a solved reference, tagged with the `cake` it was
    /// solved for. `cake_count` sums the estimated breeding attempts over every
    /// bred node (one cake per attempt); zero for [`CakeKind::Normal`].
    pub fn from_ref(gd: &GameData, r: &PalRef, cake: CakeKind) -> BreedingPlan {
        let cake_count = if cake.consumes_cakes() { cake_attempts(r) } else { 0 };
        BreedingPlan {
            root: node_of(gd, r),
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
