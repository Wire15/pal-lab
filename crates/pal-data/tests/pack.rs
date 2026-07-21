//! Integration tests for the embedded game-data pack.
//!
//! Run with `cargo test -p pal-data` (add `-- --nocapture` to see the printed
//! pack size and load time).

use std::time::Instant;

use pal_data::gamedata::UNREACHABLE;
use pal_data::{GameData, Gender};

/// Species count declared in the vendored `db.json`, without a full typed parse.
fn vendor_species_count() -> usize {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vendor/db.json");
    let bytes = std::fs::read(path).expect("read vendor/db.json");
    let v: serde_json::Value = serde_json::from_slice(&bytes).expect("parse db.json");
    v["Pals"].as_array().expect("Pals array").len()
}

#[test]
fn pack_decodes_and_reports_size_and_load_time() {
    let bytes = GameData::embedded_bytes();
    assert!(!bytes.is_empty(), "embedded pack must not be empty");

    let start = Instant::now();
    let gd = GameData::decode(bytes).expect("embedded pack decodes");
    let elapsed = start.elapsed();

    // Warm accessor path (LazyLock) also works.
    assert_eq!(GameData::get().species_count(), gd.species_count());

    println!(
        "pack: {} bytes | {} species | decode+index in {:.3} ms",
        bytes.len(),
        gd.species_count(),
        elapsed.as_secs_f64() * 1000.0,
    );
    // Sanity: the binary pack must be far smaller than the ~10.5 MB vendor JSON.
    assert!(bytes.len() < 3_000_000, "pack unexpectedly large");
}

#[test]
fn species_count_matches_vendor_json() {
    let gd = GameData::get();
    assert_eq!(gd.species_count(), vendor_species_count());
    assert_eq!(gd.species_count(), 299);
}

#[test]
fn anubis_exists_with_expected_combi_rank() {
    let gd = GameData::get();
    let anubis = gd.species_by_id("Anubis").expect("Anubis present");
    assert_eq!(anubis.name, "Anubis");
    // CombiRank / BreedingPower from the vendored data.
    assert_eq!(anubis.breeding_power, 480);
    // Anubis ships a guaranteed passive.
    assert_eq!(anubis.guaranteed_passives, vec!["ElementBoost_Earth_2_PAL"]);
}

#[test]
fn unique_gender_combos_resolve() {
    let gd = GameData::get();
    let catmage = gd.species_index("CatMage").expect("CatMage");
    let foxmage = gd.species_index("FoxMage").expect("FoxMage");
    let cat_fire = gd.species_index("CatMage_Fire").expect("CatMage_Fire");
    let fox_dark = gd.species_index("FoxMage_Dark").expect("FoxMage_Dark");

    // Female CatMage x Male FoxMage -> CatMage_Fire (order-independent).
    assert_eq!(
        gd.child_of(catmage, Gender::Female, foxmage, Gender::Male),
        Some(cat_fire)
    );
    assert_eq!(
        gd.child_of(foxmage, Gender::Male, catmage, Gender::Female),
        Some(cat_fire)
    );
    // Male CatMage x Female FoxMage -> FoxMage_Dark.
    assert_eq!(
        gd.child_of(catmage, Gender::Male, foxmage, Gender::Female),
        Some(fox_dark)
    );
}

#[test]
fn wildcard_combo_is_gender_independent() {
    let gd = GameData::get();
    // AmaterasuWolf_Dark x GhostDragon_Fire -> Anubis (a WILDCARD pairing).
    let a = gd.species_index("AmaterasuWolf_Dark").expect("parent a");
    let b = gd.species_index("GhostDragon_Fire").expect("parent b");
    let anubis = gd.species_index("Anubis").expect("Anubis");
    for (ga, gb) in [
        (Gender::Male, Gender::Female),
        (Gender::Female, Gender::Male),
        (Gender::Male, Gender::Male),
        (Gender::Female, Gender::Female),
    ] {
        assert_eq!(gd.child_of(a, ga, b, gb), Some(anubis));
    }
}

#[test]
fn min_steps_self_is_zero_and_bounded() {
    let gd = GameData::get();
    let n = gd.species_count() as u16;
    for idx in 0..n {
        // Self distance is always zero.
        assert_eq!(gd.min_steps(idx, idx), 0, "self-step must be 0 for {idx}");
    }
    // A reachable directed pair has a small positive distance.
    let anubis = gd.species_index("Anubis").unwrap();
    let a = gd.species_index("AmaterasuWolf_Dark").unwrap();
    let d = gd.min_steps(a, anubis);
    assert!(d >= 1 && d < UNREACHABLE, "expected finite path, got {d}");
    // Out-of-range indices are UNREACHABLE, never a panic.
    assert_eq!(gd.min_steps(n, 0), UNREACHABLE);
}

#[test]
fn gender_probabilities_sum_to_one() {
    let gd = GameData::get();
    for name in ["Anubis", "BadCatgirl", "BrownRabbit", "CatMage", "FoxMage"] {
        let idx = gd.species_index(name).expect(name);
        let (m, f) = gd.gender_probability(idx).expect("prob");
        assert!(m >= 0.0 && f >= 0.0, "{name}: non-negative probs");
        assert!((m + f - 1.0).abs() < 1e-5, "{name}: probs sum to 1");
    }
    // Every species' gender split is well-formed.
    for i in 0..gd.species_count() as u16 {
        let (m, f) = gd.gender_probability(i).unwrap();
        assert!((m + f - 1.0).abs() < 1e-5);
    }
}

#[test]
fn inheritance_weights_default_to_shipped_arrays() {
    let gd = GameData::get();
    let w = gd.inheritance();
    assert_eq!(w.passive_inherit, vec![4.0, 3.0, 2.0, 1.0]);
    assert_eq!(w.passive_random_add, vec![4.0, 3.0, 2.0, 1.0]);
    // IV inheritance 50/25/25 (palcalc IVProbabilityDirect); owned by Slice A.
    assert_eq!(w.talent_inherit, vec![2.0, 1.0, 1.0]);
}

#[test]
fn work_suitability_decodes_by_kind() {
    let gd = GameData::get();
    let cat = gd.species_by_id("BadCatgirl").expect("BadCatgirl exists");
    // Nyafia's known work profile (palcalc db.json).
    assert_eq!(cat.work_level("Handiwork"), Some(4), "Handiwork");
    assert_eq!(cat.work_level("Gathering"), Some(4), "Gathering");
    assert_eq!(cat.work_level("Transporting"), Some(3), "Transporting");
    assert_eq!(cat.work_level("Lumbering"), Some(2), "Lumbering");
    assert_eq!(cat.work_level("Kindling"), Some(0), "Kindling (unset)");
    // Accessor rejects unknown kinds.
    assert_eq!(cat.work_level("Fishing"), None, "unknown kind");
    // The compact array and canonical order agree.
    assert_eq!(cat.work_suitability.len(), pal_data::gamedata::WORK_KINDS.len());
    let handi = cat
        .work_suitabilities()
        .find(|(k, _)| *k == "Handiwork")
        .map(|(_, v)| v);
    assert_eq!(handi, Some(4), "iterator agrees with work_level");
}

#[test]
fn species_metadata_round_trips() {
    let gd = GameData::get();
    let cat = gd.species_by_id("BadCatgirl").expect("BadCatgirl exists");
    assert_eq!(cat.food_amount, 6, "Nyafia food amount");
    assert!(cat.nocturnal, "Nyafia is nocturnal");
    assert_eq!(cat.wild_levels, (30, 60), "Nyafia wild level range");
    // Partner-skill spot check: the shipped db.json has PartnerSkill=null for
    // every species, so it decodes to None (never an empty string) — but the
    // Option round-trips so it lights up when data lands.
    assert_eq!(cat.partner_skill, None, "BadCatgirl partner skill");
    assert!(
        gd.species().all(|s| s.partner_skill != Some(String::new())),
        "partner_skill is never an empty string",
    );
}

#[test]
fn every_species_has_one_or_two_elements() {
    let gd = GameData::get();
    for sp in gd.species() {
        let n = sp.elements.len();
        assert!(
            (1..=2).contains(&n),
            "{} has {} elements (expected 1-2)",
            sp.internal_name,
            n,
        );
    }
}

#[test]
fn element_spot_checks() {
    let gd = GameData::get();
    let els = |id: &str| -> Vec<&'static str> {
        gd.species_by_id(id)
            .unwrap_or_else(|| panic!("{id} exists"))
            .elements
            .iter()
            .map(|e| e.as_str())
            .collect()
    };
    // Anubis = Earth (in-game "Ground"), single-element.
    assert_eq!(els("Anubis"), ["Earth"], "Anubis is Earth");
    // Foxparks (Kitsunebi) = Fire, single-element.
    assert_eq!(els("Kitsunebi"), ["Fire"], "Foxparks is Fire");
    // Lamball (SheepBall) = Normal (in-game "Neutral"), single-element.
    assert_eq!(els("SheepBall"), ["Normal"], "Lamball is Normal");
    // Jormuntide (Umihebi) = Water + Dragon (dual; game's ElementType order).
    let jorm = els("Umihebi");
    assert_eq!(jorm.len(), 2, "Jormuntide is dual-element, got {jorm:?}");
    assert!(
        jorm.contains(&"Water") && jorm.contains(&"Dragon"),
        "Jormuntide is Water+Dragon, got {jorm:?}",
    );
}
