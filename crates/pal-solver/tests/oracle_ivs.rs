//! Oracle parity for the IV (talent) inheritance probability model.
//!
//! Fixtures are the (inputs, expected) tuples ported from palcalc's generated
//! `IVProbabilitiesTests.cs` (MIT, tylercamp/palcalc@master). palcalc asserts
//! its production `ProbabilityInheritedTargetIVs` equals a hand-derived
//! `expected` expression; we evaluate that expected side, map the two-`IV_Set`
//! `actual:` call to our count-based API by counting, per category
//! (HP/Attack/Defense), how many parents carry a *relevant* IV:
//!   - num_required = categories relevant in >= 1 parent
//!   - num_single_relevant_parent = categories relevant in exactly 1 parent
//! palcalc's fn only inspects these counts, so the mapping is lossless.
//!
//! Regenerate with `/tmp/palcalc-fixtures/extract.mjs`.

use pal_data::InheritanceWeights;
use pal_solver::probabilities::{iv_inherit_probability, prob_inherited_target_ivs};

struct IvCase {
    name: &'static str,
    idx: usize,
    num_required: usize,
    num_single: usize,
    expected: f64,
}

static CASES: &[IvCase] = include!("fixtures/ivs_cases.rs");

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-4 * b.abs().max(1.0)
}

#[test]
fn oracle_ivs_fixtures() {
    let w = InheritanceWeights::default();
    let mut max_dev = 0.0f64;
    for c in CASES {
        let got = prob_inherited_target_ivs(c.num_required, c.num_single, &w);
        max_dev = max_dev.max((got - c.expected).abs());
        assert!(
            close(got, c.expected),
            "{}#{} required={} single={}: expected {}, got {}",
            c.name,
            c.idx,
            c.num_required,
            c.num_single,
            c.expected,
            got
        );
    }
    eprintln!(
        "oracle_ivs: {} fixtures verified, max deviation {:e}",
        CASES.len(),
        max_dev
    );
}

/// The normalized default `talent_inherit` weights ([2,1,1]) must reproduce
/// palcalc's `GameConstants.IVProbabilityDirect` table (50/25/25%).
#[test]
fn normalized_iv_defaults_match_gameconstants() {
    let w = InheritanceWeights::default();
    for (n, exp) in [(1, 0.50), (2, 0.25), (3, 0.25)] {
        assert!(close(iv_inherit_probability(n, &w), exp), "iv_direct[{n}]");
    }
}

/// The `IvModel::Cdo` model swaps `talent_inherit` for the game-file
/// `combi_talent_inherit_num` weights. The shipped `[3,2,1]` array normalizes to
/// 50/33.3/16.7% (vs the empirical 50/25/25%), and the pack must carry `[3,2,1]`.
#[test]
fn cdo_iv_model_derives_from_game_settings() {
    use pal_data::GameData;
    let gd = GameData::get();
    let cdo_raw = &gd.game_settings().combi_talent_inherit_num;
    assert_eq!(cdo_raw, &vec![3u32, 2, 1], "pack CDO talent weights");

    let cdo = InheritanceWeights {
        talent_inherit: cdo_raw.iter().map(|&w| w as f32).collect(),
        ..gd.inheritance().clone()
    };
    // 3/6, 2/6, 1/6.
    for (n, exp) in [(1, 0.5), (2, 1.0 / 3.0), (3, 1.0 / 6.0)] {
        assert!(close(iv_inherit_probability(n, &cdo), exp), "cdo iv_direct[{n}]");
    }
    // Empirical and Cdo must genuinely differ at n=2/n=3.
    let emp = InheritanceWeights::default();
    assert!((iv_inherit_probability(2, &cdo) - iv_inherit_probability(2, &emp)).abs() > 1e-3);
}
