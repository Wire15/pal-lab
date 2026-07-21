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
//!
//! Ports (MIT, github.com/tylercamp/palcalc@master):
//! `PalCalc.Solver/Probabilities/{Passives,IVs}.cs`, constants from
//! `PalCalc.Model/GameConstants.cs`. All probability tables are normalized
//! FROM the raw `InheritanceWeights` arrays at call time, never baked in.

use pal_data::InheritanceWeights;

/// Max passive-skill slots on a pal (palcalc `GameConstants.MaxTotalPassives`).
const MAX_TOTAL_PASSIVES: usize = 4;

/// Total IV categories palcalc models: HP, Attack, Defense (`IV_Set`).
const TOTAL_IV_CATEGORIES: usize = 3;

/// Normalize a raw weight array into a probability distribution (sums to 1).
/// Returns all-zero if the weights sum to <= 0.
fn normalize(weights: &[f32]) -> Vec<f64> {
    let sum: f64 = weights.iter().map(|&w| w as f64).sum();
    if sum <= 0.0 {
        return vec![0.0; weights.len()];
    }
    weights.iter().map(|&w| w as f64 / sum).collect()
}

/// P(child inherits exactly `n` passives DIRECTLY from the parent pool), the
/// normalized `passive_inherit` distribution. `n == 0` is impossible (a child
/// always inherits at least one), matching palcalc `PassiveProbabilityDirect`
/// (defaults 40/30/20/10% for n = 1/2/3/4).
pub fn passive_inherit_probability(n: usize, weights: &InheritanceWeights) -> f64 {
    if n == 0 {
        return 0.0;
    }
    normalize(&weights.passive_inherit).get(n - 1).copied().unwrap_or(0.0)
}

/// P(child gains exactly `n` RANDOM extra passives), the normalized
/// `passive_random_add` distribution indexed from 0. The roll picks an index in
/// `[0, len-1]`, so with the shipped 4-element array 4 random extras are
/// impossible — matching palcalc `PassiveRandomAddedProbability`
/// (defaults 40/30/20/10% for n = 0/1/2/3, 0% for 4).
pub fn passive_random_added_probability(n: usize, weights: &InheritanceWeights) -> f64 {
    normalize(&weights.passive_random_add).get(n).copied().unwrap_or(0.0)
}

/// P(child inherits exactly `n` IV categories directly), the normalized
/// `talent_inherit` distribution (`n` in 1..=3). Matches palcalc
/// `GameConstants.IVProbabilityDirect` (defaults 50/25/25% for n = 1/2/3 from
/// the shipped [2,1,1] weights).
pub fn iv_inherit_probability(n: usize, weights: &InheritanceWeights) -> f64 {
    if n == 0 {
        return 0.0;
    }
    normalize(&weights.talent_inherit).get(n - 1).copied().unwrap_or(0.0)
}

/// P(child ends up with ALL `num_desired` target passives out of a
/// deduplicated parent pool of `pool_size` (which contains the desired ones),
/// with exactly `num_final` total passives on the child).
///
/// # Formula
/// Sums, over each possible direct-inherit roll `x` in
/// `num_desired..=MAX_TOTAL_PASSIVES`, the joint probability of that roll
/// yielding all desired passives AND the complementary random-add roll filling
/// the child to exactly `num_final` slots:
///
/// - **P(direct)** = P(inherit exactly `x`) scaled by the fraction of size-`x`
///   subsets of the pool that contain the whole desired set. When the pool is
///   smaller than the roll, only `min(x, pool_size)` are actually inherited
///   (palcalc `actualNumInheritedFromParent`); the direct roll probability
///   still uses the un-clamped `x`. The subset fraction is
///   `C(pool-desired, irrelevant) / C(pool, actual)`, or `1/C(pool, desired)`
///   when no irrelevant passive is inherited, or just P(inherit `x`) when
///   nothing is desired.
/// - **P(random)** = P(exactly `num_final - actual` random extras), except when
///   `num_final == MAX_TOTAL_PASSIVES` (all 4 slots), where any surplus roll
///   still lands at the cap, so the *cumulative* "at least N random" variant is
///   used instead.
///
/// Mirrors palcalc `Probabilities.Passives.ProbabilityInheritedTargetPassives`.
/// Pinned by `tests/oracle_passives.rs` against palcalc's
/// `PassivesProbabilitiesTests_Final{0..4}` fixtures (70 cases).
pub fn prob_inherited_target_passives(
    pool_size: usize,
    num_desired: usize,
    num_final: usize,
    weights: &InheritanceWeights,
) -> f64 {
    let direct = normalize(&weights.passive_inherit);
    let random = normalize(&weights.passive_random_add);

    // P(inherit exactly n directly); n == 0 impossible.
    let direct_prob = |n: usize| -> f64 {
        if n == 0 {
            0.0
        } else {
            direct.get(n - 1).copied().unwrap_or(0.0)
        }
    };
    // P(exactly n random extras).
    let random_prob = |n: usize| -> f64 { random.get(n).copied().unwrap_or(0.0) };
    // P(at least n random extras).
    let random_at_least =
        |n: usize| -> f64 { (n..=MAX_TOTAL_PASSIVES).map(random_prob).sum() };

    let mut total = 0.0;
    for num_inherited in num_desired..=MAX_TOTAL_PASSIVES {
        // We may roll to inherit more passives than the pool actually has; the
        // extra rolls change nothing (still bounded by the pool size).
        let actual = num_inherited.min(pool_size);
        // Invariant on valid inputs (pool always contains the desired set):
        // actual >= num_desired. Guard defensively against underflow.
        if actual < num_desired {
            continue;
        }
        let num_irrelevant_parent = actual - num_desired;
        let num_irrelevant_random = num_final.saturating_sub(actual);
        if actual + num_irrelevant_random > num_final {
            continue;
        }

        let got_required_from_parent = if num_desired == 0 {
            direct_prob(num_inherited)
        } else if num_irrelevant_parent == 0 {
            direct_prob(num_inherited) / choose(pool_size, num_desired)
        } else {
            let combos_with_irrelevant = choose(pool_size - num_desired, num_irrelevant_parent);
            let combos_any = choose(pool_size, actual);
            (combos_with_irrelevant / combos_any) * direct_prob(num_inherited)
        };

        let got_exact_required_random = if num_final == MAX_TOTAL_PASSIVES {
            random_at_least(num_irrelevant_random)
        } else {
            random_prob(num_irrelevant_random)
        };

        total += got_required_from_parent * got_exact_required_random;
    }

    total
}

/// P(child inherits all `num_required` relevant IV categories from its
/// parents), where `num_single_relevant_parent` of those categories are
/// carried by only ONE parent (each such category halves the odds).
///
/// # Formula
/// The base chance of landing exactly the `num_required` desired IV categories
/// is `sum over x in 1..=3 of P(inherit x IVs) * C(3-num_required, x-num_required)/C(3, x)`
/// (probability the size-`x` inherited set covers the desired categories, over
/// palcalc's 3 IV categories). That base is then multiplied by `0.5` once per
/// category present in only one relevant parent (the extra "right parent" coin
/// flip). Returns `1.0` when nothing is required.
///
/// Mirrors palcalc `Probabilities.IVs.ProbabilityInheritedTargetIVs`.
/// Pinned by `tests/oracle_ivs.rs` against palcalc's `IVProbabilitiesTests`
/// fixtures (65 assertions).
pub fn prob_inherited_target_ivs(
    num_required: usize,
    num_single_relevant_parent: usize,
    weights: &InheritanceWeights,
) -> f64 {
    if num_required == 0 {
        return 1.0;
    }
    let base = iv_desired_probabilities(weights)[num_required - 1];
    base * 0.5f64.powi(num_single_relevant_parent as i32)
}

/// P(the inherited IV set covers all `d` desired categories) accumulated over
/// the direct-inherit roll, for `d` in 1..=3. Index `d - 1`.
fn iv_desired_probabilities(weights: &InheritanceWeights) -> [f64; 3] {
    let mut out = [0.0f64; 3];
    for num_desired in 1..=TOTAL_IV_CATEGORIES {
        let mut acc = 0.0;
        for num_inherited in 1..=TOTAL_IV_CATEGORIES {
            if num_inherited < num_desired {
                continue;
            }
            let match_prob = choose(TOTAL_IV_CATEGORIES - num_desired, num_inherited - num_desired)
                / choose(TOTAL_IV_CATEGORIES, num_inherited);
            acc += iv_inherit_probability(num_inherited, weights) * match_prob;
        }
        out[num_desired - 1] = acc;
    }
    out
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
