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
    // Partner-skill spot check: BadCatgirl (Nyafia) carries both a NAME and a
    // DESCRIPTION from the own-install extraction.
    assert_eq!(
        cat.partner_skill.as_deref(),
        Some("Shot-Nyan Mode"),
        "BadCatgirl partner skill name (from extraction)",
    );
    assert!(
        cat.partner_skill_desc.as_deref().is_some_and(|d| !d.is_empty()),
        "BadCatgirl partner desc now populated from extraction",
    );
    assert!(
        gd.species().all(|s| s.partner_skill.as_deref() != Some("")),
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
    // Jormuntide (Umihebi) = Dragon + Water (dual; extraction's primary-then-
    // secondary ElementType order).
    assert_eq!(els("Umihebi"), ["Dragon", "Water"], "Jormuntide is Dragon+Water");
    // Fuack (BluePlatypus) = Water, single-element.
    assert_eq!(els("BluePlatypus"), ["Water"], "Fuack is Water");
}

#[test]
fn partner_skill_spot_checks() {
    let gd = GameData::get();
    let ps = |id: &str| -> (String, String) {
        let s = gd.species_by_id(id).unwrap_or_else(|| panic!("{id} exists"));
        (
            s.partner_skill.clone().unwrap_or_else(|| panic!("{id} has partner skill")),
            s.partner_skill_desc.clone().unwrap_or_else(|| panic!("{id} has partner desc")),
        )
    };
    // Lamball (SheepBall) = Fluffy Shield.
    assert_eq!(ps("SheepBall").0, "Fluffy Shield", "Lamball partner skill");
    // Foxparks (Kitsunebi) = Huggy Fire.
    assert_eq!(ps("Kitsunebi").0, "Huggy Fire", "Foxparks partner skill");
    // Anubis = Guardian of the Desert (note lowercase "of the").
    assert_eq!(ps("Anubis").0, "Guardian of the Desert", "Anubis partner skill");
    // Descriptions are non-empty for covered species.
    assert!(!ps("SheepBall").1.is_empty(), "Lamball partner desc non-empty");
}

#[test]
fn partner_skill_name_and_desc_full_coverage() {
    let gd = GameData::get();
    // Own-install extraction populates a NAME for every species.
    let with_name = gd.species().filter(|s| s.partner_skill.is_some()).count();
    assert_eq!(with_name, 299, "partner-skill name coverage (all species)");
    // DESCRIPTIONS now come from the extraction (DT_PalFirstActivatedInfoText —
    // real in-game text): every species covered.
    let with_desc = gd.species().filter(|s| s.partner_skill_desc.is_some()).count();
    assert_eq!(with_desc, 299, "partner-skill description coverage (all species)");
    // A description present implies a name present (never a desc without a name).
    for sp in gd.species() {
        if sp.partner_skill_desc.is_some() {
            assert!(
                sp.partner_skill.is_some(),
                "{} has a partner-skill description but no name",
                sp.internal_name,
            );
        }
    }
    // Lamball (SheepBall)'s authored text is the real in-game description.
    let lamball = gd.species_by_id("SheepBall").expect("Lamball exists");
    let desc = lamball.partner_skill_desc.as_deref().unwrap_or("");
    assert!(
        desc.to_ascii_lowercase().contains("becomes a shield"),
        "Lamball partner desc should contain 'becomes a shield', got: {desc:?}",
    );
}

/// Assertion-free: report partner-icon resolution coverage for the record.
#[test]
fn partner_skill_icon_coverage_report() {
    let gd = GameData::get();
    let total = gd.species().count();
    let with_icon = gd.species().filter(|s| s.partner_skill_icon.is_some()).count();
    eprintln!("partner-skill icon coverage: {with_icon}/{total} species resolve to a shipped PNG");
}

#[test]
fn passive_extraction_metadata_joins() {
    let gd = GameData::get();
    // Lucky (internal id `Rare`): rank 4, three effects, pal-facing (lottery).
    let lucky = gd.passive_by_id("Rare").expect("Lucky/Rare passive exists");
    assert_eq!(lucky.name, "Lucky", "Rare -> display name Lucky");
    assert_eq!(lucky.rank, 4, "Lucky rank");
    assert_eq!(lucky.effects.len(), 3, "Lucky has 3 effects");
    assert!(lucky.pal_facing, "Lucky is pal-facing (lottery pool)");

    // Legend: not in a lottery pool but guaranteed on some species -> pal-facing;
    // effects present.
    let legend = gd.passive_by_id("Legend").expect("Legend passive exists");
    assert!(legend.pal_facing, "Legend is pal-facing via guaranteed_passives");
    assert!(!legend.effects.is_empty(), "Legend has effects");
    assert_eq!(legend.rank, 4, "Legend rank");

    // Brittle (internal id `Deffence_down2`): negative rank, a negative-value effect.
    let brittle = gd.passive_by_id("Deffence_down2").expect("Brittle passive exists");
    assert_eq!(brittle.name, "Brittle", "Deffence_down2 -> display name Brittle");
    assert_eq!(brittle.rank, -3, "Brittle rank is -3");
    assert!(
        brittle.effects.iter().any(|e| e.value < 0.0),
        "Brittle has a negative-value effect",
    );

    // pal_facing count matches paldb's Pal passive count of 114.
    let pal_facing = gd.passives().iter().filter(|p| p.pal_facing).count();
    assert_eq!(pal_facing, 114, "pal_facing passive count matches paldb (114)");
}

#[test]
fn species_id_resolves_case_insensitively() {
    let gd = GameData::get();
    // The pack keys palcalc's "GhostAnglerfish"; the real save's CharacterID is
    // "GhostAnglerFish" (capital F). Both must resolve to the same species.
    let exact = gd.species_by_id("GhostAnglerfish").expect("exact key exists");
    let from_save = gd
        .species_by_id("GhostAnglerFish")
        .expect("save-cased key resolves via ci fallback");
    assert_eq!(exact.internal_name, from_save.internal_name);
    // Exact casing still wins for a normal id.
    assert_eq!(gd.species_by_id("Anubis").unwrap().name, "Anubis");
    // Unknown id is still None.
    assert!(gd.species_by_id("NotARealPalXYZ").is_none());
}

#[test]
fn extended_stats_spot_checks() {
    let gd = GameData::get();
    // Lamball (SheepBall) extended stats — own-install extraction ground truth.
    let lam = gd.species_by_id("SheepBall").expect("Lamball exists");
    assert_eq!(lam.craft_speed, 100, "Lamball craft_speed");
    assert_eq!(lam.run_speed, 400, "Lamball run_speed");
    assert_eq!(lam.size, "XS", "Lamball size");
    assert_eq!(lam.price, 421, "Lamball price");
    assert_eq!(lam.stamina, 100, "Lamball stamina");
    // The `-1` sentinel is preserved for non-rideable / non-transport species.
    let scorp = gd.species_by_id("ScorpionMan").expect("ScorpionMan exists");
    assert_eq!(scorp.ride_sprint_speed, -1, "ScorpionMan is not rideable");
    // Every species carries a valid size class.
    for sp in gd.species() {
        assert!(
            matches!(sp.size.as_str(), "XS" | "S" | "M" | "L" | "XL"),
            "{} has unexpected size {:?}",
            sp.internal_name,
            sp.size,
        );
    }
}

#[test]
fn game_settings_are_extraction_ground_truth() {
    let gd = GameData::get();
    let gs = gd.game_settings();
    // Combi_* inheritance arrays straight from the game-file GameSetting CDO.
    assert_eq!(gs.combi_talent_inherit_num, vec![3, 2, 1], "CDO talent-inherit");
    assert_eq!(gs.combi_passive_inherit_num, vec![4, 3, 2, 1], "CDO passive-inherit");
    assert_eq!(gs.combi_passive_random_add_num, vec![4, 3, 2, 1], "CDO passive-random-add");
    assert!((gs.combi_boss_pal_rate - 0.05).abs() < 1e-6, "CDO boss-pal-rate");
    assert_eq!(gd.game_build(), "24181527", "pack game build");
    // DATA ONLY: the CDO talent weights ([3,2,1]) deliberately differ from the
    // solver's empirically-validated [2,1,1] (50/25/25) model — the CDO array is
    // stored for reference but NOT wired into breeding this round.
    let solver_talent: Vec<u32> =
        gd.inheritance().talent_inherit.iter().map(|&w| w as u32).collect();
    assert_ne!(
        gs.combi_talent_inherit_num, solver_talent,
        "CDO talent weights must stay decoupled from the solver's empirical model",
    );
}

#[test]
fn active_names_resolve() {
    let gd = GameData::get();
    let names = gd.active_names();
    assert!(!names.is_empty(), "active_names should be non-empty");
    // Lookup a known waza id: must resolve to a non-empty display name != id.
    let air = names
        .iter()
        .find(|(id, _)| id == "AirCanon")
        .map(|(_, n)| n.as_str());
    let air = air.expect("AirCanon present in active_names");
    assert!(!air.is_empty(), "AirCanon name non-empty");
    assert_ne!(air, "AirCanon", "AirCanon resolves to a display name, not the raw id");
    // Pairs are sorted by id (deterministic pack bytes).
    assert!(
        names.windows(2).all(|w| w[0].0 <= w[1].0),
        "active_names sorted by id",
    );
}

#[test]
fn passive_tiers_classify_special_pools() {
    use pal_data::gamedata::PassiveTier;
    let gd = GameData::get();
    // The extraction found members (7 world-tree, 5 mutation), so at least one
    // passive must carry a tier.
    assert!(
        gd.passives().iter().any(|p| p.tier.is_some()),
        "at least one passive carries a tier",
    );
    // World-tree pool ⇒ worldtree tier.
    let wt = gd.passive_by_id("WorldTree_ATK").expect("WorldTree_ATK exists");
    assert_eq!(wt.tier, Some(PassiveTier::WorldTree), "WorldTree_ATK is worldtree tier");
    // Mutation pool ⇒ rainbow tier.
    let mut_pal = gd.passive_by_id("MutationPal_Mutant").expect("MutationPal_Mutant exists");
    assert_eq!(mut_pal.tier, Some(PassiveTier::Rainbow), "MutationPal_Mutant is rainbow tier");
    // Ordinary passive has no tier.
    let lucky = gd.passive_by_id("Rare").expect("Lucky/Rare exists");
    assert_eq!(lucky.tier, None, "ordinary passive has no tier");
}
