//! Inheritance probability model. Weight distributions come from
//! `pal_data::InheritanceWeights` (extracted game data) — NEVER hardcoded here.
//!
//! Model (code-verified, see DESIGN.md "Mechanics ground truth"):
//! - Passives: two independent rolls over the deduplicated union of both
//!   parents' passives. Roll X = #inherited directly, weights
//!   `passive_inherit` (shipped [4,3,2,1] -> 40/30/20/10% for 1..=4).
//!   Roll Y = #random extras, weights `passive_random_add`; extras only fill
//!   remaining slots (cap 4 total). Parent identity/gender irrelevant.
//! - IVs ("talents"): weights `talent_inherit`; each IV present in only one
//!   relevant parent halves the chance of inheriting it from the right side.
//!
//! The frozen count-based API below is what the solver core consumes; the
//! oracle test-suite (ported from palcalc's numeric fixtures) pins exact
//! expected values.

use pal_data::InheritanceWeights;

/// P(child ends up with ALL `num_desired` target passives out of a
/// deduplicated parent pool of `pool_size` (which contains the desired ones),
/// with exactly `num_final` total passives on the child).
///
/// Mirrors palcalc `Probabilities.Passives.ProbabilityInheritedTargetPassives`.
pub fn prob_inherited_target_passives(
    pool_size: usize,
    num_desired: usize,
    num_final: usize,
    weights: &InheritanceWeights,
) -> f64 {
    let _ = (pool_size, num_desired, num_final, weights);
    todo!("implemented by oracle-parity slice")
}

/// P(child inherits all `num_required` relevant IV categories from its
/// parents), where `num_single_relevant_parent` of those categories are
/// carried by only ONE parent (each such category halves the odds).
///
/// Mirrors palcalc `Probabilities.IVs.ProbabilityInheritedTargetIVs`.
pub fn prob_inherited_target_ivs(
    num_required: usize,
    num_single_relevant_parent: usize,
    weights: &InheritanceWeights,
) -> f64 {
    let _ = (num_required, num_single_relevant_parent, weights);
    todo!("implemented by oracle-parity slice")
}

/// n choose k as f64, valid for the small n used in breeding math.
pub fn choose(n: usize, k: usize) -> f64 {
    if k > n {
        return 0.0;
    }
    let k = k.min(n - k);
    let mut result = 1.0f64;
    for i in 0..k {
        result = result * (n - i) as f64 / (i + 1) as f64;
    }
    result
}
