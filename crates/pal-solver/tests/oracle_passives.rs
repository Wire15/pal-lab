//! Oracle parity for the passive-inheritance probability model.
//!
//! Fixtures are the (inputs, expected) tuples ported from palcalc's generated
//! `PassivesProbabilitiesTests_Final{0..4}.cs` (MIT, tylercamp/palcalc@master).
//! palcalc's tests assert its production
//! `ProbabilityInheritedTargetPassives` equals a hand-derived, term-by-term
//! `expected` expression; we evaluate that (independent) expected side, map the
//! list-based `actual:` call to our count-based API (pool = deduped parent
//! union size, num_desired, num_final — palcalc only reads `.Count`, so counts
//! fully reproduce every fixture), and pin our Rust port to it.
//!
//! Regenerate with `/tmp/palcalc-fixtures/extract.mjs`.

use pal_data::InheritanceWeights;
use pal_solver::probabilities::{
    passive_inherit_probability, passive_random_added_probability, prob_inherited_target_passives,
};

struct PassiveCase {
    suite: &'static str,
    name: &'static str,
    pool: usize,
    desired: usize,
    num_final: usize,
    expected: f64,
}

static CASES: &[PassiveCase] = include!("fixtures/passives_cases.rs");

/// 1e-4 relative tolerance with a 1e-4 absolute floor (palcalc asserts with a
/// 1e-4 absolute delta; we compute in f64 so agreement is far tighter).
fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-4 * b.abs().max(1.0)
}

#[test]
fn oracle_passives_fixtures() {
    let w = InheritanceWeights::default();
    let mut max_dev = 0.0f64;
    for c in CASES {
        let got = prob_inherited_target_passives(c.pool, c.desired, c.num_final, &w);
        max_dev = max_dev.max((got - c.expected).abs());
        assert!(
            close(got, c.expected),
            "{}::{} pool={} desired={} final={}: expected {}, got {}",
            c.suite,
            c.name,
            c.pool,
            c.desired,
            c.num_final,
            c.expected,
            got
        );
    }
    eprintln!(
        "oracle_passives: {} fixtures verified, max deviation {:e}",
        CASES.len(),
        max_dev
    );
}

/// The normalized default weights must reproduce palcalc's `GameConstants`
/// passive tables (40/30/20/10%), proving nothing is hardcoded in the formula.
#[test]
fn normalized_passive_defaults_match_gameconstants() {
    let w = InheritanceWeights::default();
    // PassiveProbabilityDirect: n = 0 impossible; 1..4 -> 40/30/20/10%.
    for (n, exp) in [(0, 0.0), (1, 0.40), (2, 0.30), (3, 0.20), (4, 0.10)] {
        assert!(close(passive_inherit_probability(n, &w), exp), "direct[{n}]");
    }
    // PassiveRandomAddedProbability: 0..3 -> 40/30/20/10%, 4 -> 0%.
    for (n, exp) in [(0, 0.40), (1, 0.30), (2, 0.20), (3, 0.10), (4, 0.0)] {
        assert!(
            close(passive_random_added_probability(n, &w), exp),
            "random_added[{n}]"
        );
    }
}
