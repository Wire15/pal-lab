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
fn active_skills_resolve() {
    let gd = GameData::get();
    let skills = gd.active_skills();
    assert!(!skills.is_empty(), "active_skills should be non-empty");
    // Pairs are sorted by id (deterministic pack bytes).
    assert!(
        skills.windows(2).all(|w| w[0].0 <= w[1].0),
        "active_skills sorted by id",
    );
    // AirCanon: known damage skill with the full contract shape.
    let air = skills
        .iter()
        .find(|(id, _)| id == "AirCanon")
        .map(|(_, s)| s)
        .expect("AirCanon present in active_skills");
    assert_eq!(air.name, "Air Cannon", "AirCanon resolves to its display name");
    const ELEMENTS: [&str; 9] = [
        "Normal", "Fire", "Water", "Leaf", "Electricity", "Ice", "Earth", "Dark", "Dragon",
    ];
    assert!(
        ELEMENTS.contains(&air.element.as_str()),
        "AirCanon element {:?} in the 9-element set",
        air.element,
    );
    assert!(
        matches!(air.power, Some(p) if p > 0),
        "AirCanon power is Some(>0), got {:?}",
        air.power,
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

#[test]
fn partner_skill_per_level_template() {
    let gd = GameData::get();
    // Cattiva (PinkCat) "Cat Helper": one rank-varying slot (carry capacity),
    // five ascending values from the game's per-rank param arrays.
    let cattiva = gd.species_by_id("PinkCat").expect("Cattiva exists");
    assert_eq!(cattiva.partner_skill.as_deref(), Some("Cat Helper"), "Cattiva partner name");
    let tpl = cattiva
        .partner_skill_template
        .as_deref()
        .expect("Cattiva has a per-level template");
    assert!(tpl.contains("{0}"), "Cattiva template has a {{0}} slot: {tpl:?}");
    assert!(!tpl.contains("(100~200)"), "the varying value is a slot, not a baked range: {tpl:?}");
    assert_eq!(cattiva.partner_skill_values.len(), 1, "Cattiva has exactly one slot");
    assert_eq!(
        cattiva.partner_skill_values[0],
        vec!["100", "120", "140", "160", "200"],
        "Cattiva carry-capacity values per rank (ascending)",
    );
    // A partner skill whose description carries no rank-varying value has no
    // template (Lamball's shield text is constant across ranks).
    let lamball = gd.species_by_id("SheepBall").expect("Lamball exists");
    assert!(
        lamball.partner_skill_template.is_none() && lamball.partner_skill_values.is_empty(),
        "Lamball partner skill has no per-level template",
    );
    // Every emitted slot value list is non-empty and every template species has
    // at least one slot (no half-templated rows).
    for sp in gd.species() {
        if sp.partner_skill_template.is_some() {
            assert!(!sp.partner_skill_values.is_empty(), "{} template but no values", sp.internal_name);
            for slot in &sp.partner_skill_values {
                assert!(!slot.is_empty(), "{} has an empty value slot", sp.internal_name);
            }
        } else {
            assert!(sp.partner_skill_values.is_empty(), "{} values but no template", sp.internal_name);
        }
    }
}

#[test]
fn learnsets_are_sorted_and_join_active_skills() {
    let gd = GameData::get();
    let active_ids: std::collections::HashSet<&str> =
        gd.active_skills().iter().map(|(id, _)| id.as_str()).collect();

    // Lamball (SheepBall) learns its exclusive roll at level 1.
    let lamball_idx = gd.species_index("SheepBall").expect("Lamball index");
    let lamball_moves = gd.learnset(lamball_idx);
    assert!(!lamball_moves.is_empty(), "Lamball has a learnset");
    assert_eq!(lamball_moves[0].waza_id, "Unique_SheepBall_Roll", "Lamball first learn");
    assert_eq!(lamball_moves[0].level, 1, "Lamball learns its roll at level 1");

    // Anubis learnset starts at level 1 with StoneShotgun.
    let anubis_idx = gd.species_index("Anubis").expect("Anubis index");
    let anubis_moves = gd.learnset(anubis_idx);
    assert!(anubis_moves.len() >= 5, "Anubis has several level-up moves");
    assert_eq!(anubis_moves[0].waza_id, "StoneShotgun");
    assert_eq!(anubis_moves[0].level, 1);

    // Global invariants: sorted by level asc, and every waza id resolves to a
    // real active skill (extraction never fabricates ids).
    let mut species_with = 0usize;
    for (i, sp) in gd.species().enumerate() {
        let moves = gd.learnset(i as u16);
        if !moves.is_empty() {
            species_with += 1;
        }
        for w in moves.windows(2) {
            assert!(w[0].level <= w[1].level, "{} learnset not sorted by level", sp.internal_name);
        }
        for m in moves {
            assert!(
                active_ids.contains(m.waza_id.as_str()),
                "{} learns unknown waza {}",
                sp.internal_name,
                m.waza_id,
            );
        }
    }
    assert!(species_with >= 250, "learnset coverage unexpectedly low: {species_with}");
}

#[test]
fn wild_levels_gate_wild_seeding() {
    let gd = GameData::get();
    // Jetragon (JetDragon) is wild-catchable: a nonzero min wild level.
    let jet = gd.species_by_id("JetDragon").expect("Jetragon exists");
    assert!(jet.wild_levels.0 > 0, "Jetragon min wild level > 0, got {:?}", jet.wild_levels);
    // A raid/bred-only species is not wild-spawnable: (0, 0). KingBahamut_Dragon
    // (Bellanoir Libero) is a raid boss with no wild spawn.
    let raid = gd.species_by_id("KingBahamut_Dragon").expect("Bellanoir Libero exists");
    assert_eq!(raid.wild_levels.0, 0, "raid-only species has no wild spawn");
}

#[test]
fn breeding_boosts_extract_typed_effects() {
    use pal_data::gamedata::{BreedingBoostSource, BreedingEffect};
    let gd = GameData::get();
    let boosts = gd.breeding_boosts();

    // Helper: find a boost by source id + effect.
    let find = |source: &str, effect: BreedingEffect| {
        boosts
            .iter()
            .find(|b| b.source == source && b.effect == effect)
    };
    // Per-rank fraction tolerance (values are percent/100).
    let approx = |a: f32, b: f32| (a - b).abs() < 1e-6;

    // Plesiosaur: base-camp farm (egg production) speed, 20%..50% across ranks.
    let ple = find("Plesiosaur", BreedingEffect::FarmSpeed).expect("Plesiosaur farm_speed boost");
    assert_eq!(ple.source_kind, BreedingBoostSource::PartnerBase, "Plesiosaur is a base partner boost");
    assert_eq!(ple.values_per_rank.len(), 5, "5 condensation ranks");
    assert!(approx(ple.values_per_rank[0], 0.20), "rank1 = 0.20, got {}", ple.values_per_rank[0]);
    assert!(approx(*ple.values_per_rank.last().unwrap(), 0.50), "rank5 = 0.50");
    assert!(
        ple.values_per_rank.windows(2).all(|w| w[1] >= w[0]),
        "values ascend by rank",
    );

    // ThunderFluffyBird: incubation speed, 20%..40%.
    let tfb = find("ThunderFluffyBird", BreedingEffect::IncubationSpeed)
        .expect("ThunderFluffyBird incubation_speed boost");
    assert_eq!(tfb.source_kind, BreedingBoostSource::PartnerBase);
    assert!(approx(tfb.values_per_rank[0], 0.20) && approx(*tfb.values_per_rank.last().unwrap(), 0.40));

    // NaughtyCat: in-party extra-egg chance, 50%..75%.
    let cat = find("NaughtyCat", BreedingEffect::ExtraEggChance)
        .expect("NaughtyCat extra_egg_chance boost");
    assert_eq!(cat.source_kind, BreedingBoostSource::PartnerParty, "extra-egg is a party boost");
    assert!(approx(cat.values_per_rank[0], 0.50) && approx(*cat.values_per_rank.last().unwrap(), 0.75));

    // Babysitter passive: carries BOTH farm_speed and incubation_speed, single flat +30%.
    let baby_farm = find("MutationPal_Babysitter", BreedingEffect::FarmSpeed)
        .expect("Babysitter farm_speed boost present");
    assert_eq!(baby_farm.source_kind, BreedingBoostSource::Passive, "Babysitter is a passive source");
    assert_eq!(baby_farm.values_per_rank.len(), 1, "passive boost is a single flat value");
    assert!(approx(baby_farm.values_per_rank[0], 0.30), "Babysitter farm_speed +30%");
    let baby_inc = find("MutationPal_Babysitter", BreedingEffect::IncubationSpeed)
        .expect("Babysitter incubation_speed boost present");
    assert!(approx(baby_inc.values_per_rank[0], 0.30), "Babysitter incubation +30%");

    // Alpha-egg conversion entries exist and are flagged cosmetic-only (no effort impact).
    let alpha: Vec<_> = boosts
        .iter()
        .filter(|b| b.effect == BreedingEffect::AlphaEggChance)
        .collect();
    assert!(!alpha.is_empty(), "at least one alpha_egg_chance entry (SakuraSaurus)");
    assert!(
        alpha.iter().all(|b| b.effect.is_cosmetic()),
        "every alpha_egg_chance boost is cosmetic-only",
    );
    let sakura = find("SakuraSaurus", BreedingEffect::AlphaEggChance)
        .expect("SakuraSaurus alpha_egg_chance boost");
    assert_eq!(sakura.source_kind, BreedingBoostSource::PartnerParty);
    assert!(approx(sakura.values_per_rank[0], 0.35) && approx(*sakura.values_per_rank.last().unwrap(), 0.45));

    // No non-alpha effect is ever miscategorized as cosmetic.
    assert!(
        boosts.iter().filter(|b| b.effect != BreedingEffect::AlphaEggChance).all(|b| !b.effect.is_cosmetic()),
        "only alpha_egg_chance is cosmetic",
    );

    // Deterministic order: (source_kind, source, effect). Partner_* sort before passive.
    let kind_rank = |k: BreedingBoostSource| match k {
        BreedingBoostSource::PartnerBase => 0,
        BreedingBoostSource::PartnerParty => 1,
        BreedingBoostSource::Passive => 2,
    };
    assert!(
        boosts.windows(2).all(|w| {
            (kind_rank(w[0].source_kind), &w[0].source) <= (kind_rank(w[1].source_kind), &w[1].source)
        }),
        "breeding boosts are in deterministic (source_kind, source) order",
    );
}

#[test]
fn lab_research_incubation_lines_decode() {
    use pal_data::gamedata::BreedingEffect;
    let gd = GameData::get();
    let lines = gd.lab_research();

    // Both shipped PalEggHatchingSpeed branches decode: Cooling (`Cool`) and Kindling
    // (`EmitFlame`). They carry the identical "Incubation Acceleration" line surfaced in
    // two work-suitability research trees.
    assert!(!lines.is_empty(), "lab_research decoded no lines");
    for id in ["Cool", "EmitFlame"] {
        let line = lines
            .iter()
            .find(|l| l.id == id)
            .unwrap_or_else(|| panic!("lab research line {id} missing"));
        assert_eq!(line.effect, BreedingEffect::IncubationSpeed, "{id} is an incubation-speed line");
        assert_eq!(line.name, "Incubation Acceleration", "{id} localized name");
        // Four ranks, cumulative +5% -> +30%.
        assert_eq!(line.values_per_rank.len(), 4, "{id}: 4 research ranks");
        let approx = |a: f32, b: f32| (a - b).abs() < 1e-6;
        assert!(approx(line.values_per_rank[0], 0.05), "{id} rank1 = 0.05, got {}", line.values_per_rank[0]);
        assert!(approx(line.values_per_rank[1], 0.15), "{id} rank2 = 0.15");
        assert!(approx(line.values_per_rank[2], 0.20), "{id} rank3 = 0.20");
        assert!(approx(*line.values_per_rank.last().unwrap(), 0.30), "{id} rank4 = 0.30");
        // Cumulative curve is strictly monotonic ascending (never flat/decreasing).
        assert!(
            line.values_per_rank.windows(2).all(|w| w[1] > w[0]),
            "{id} values ascend strictly by rank: {:?}",
            line.values_per_rank,
        );
    }

    // Every lab-research line is an incubation-speed line (the only breeding-relevant
    // effect in DT_LabResearchDataTable this build), with a positive-monotonic curve.
    assert!(
        lines.iter().all(|l| l.effect == BreedingEffect::IncubationSpeed
            && !l.values_per_rank.is_empty()
            && l.values_per_rank[0] > 0.0
            && l.values_per_rank.windows(2).all(|w| w[1] >= w[0])),
        "all lab_research lines are positive-monotonic incubation lines",
    );
}

#[test]
fn reverse_breeding_forward_consistent() {
    let gd = GameData::get();
    // A common mid-rank species, a self-pair species, and the two gender-pinned
    // unique combos. For every emitted pair, breeding it forward via `child_of`
    // must resolve back to the target (rank pairs are gender-independent, so an
    // `Any` pin is exercised with `Male`; unique pairs use their stored pins).
    for target in ["Anubis", "Alpaca", "CatMage_Fire", "FoxMage_Dark"] {
        let idx = gd.species_index(target).expect("target exists");
        let pairs = gd.reverse_breeding(idx);
        assert!(!pairs.is_empty(), "expected >=1 parent pair for {target}");
        for p in &pairs {
            let ga = p.parent1_gender.unwrap_or(Gender::Male);
            let gb = p.parent2_gender.unwrap_or(Gender::Male);
            assert_eq!(
                gd.child_of(p.parent1, ga, p.parent2, gb),
                Some(idx),
                "forward({} x {}) should breed {target}",
                gd.species_at(p.parent1).unwrap().internal_name,
                gd.species_at(p.parent2).unwrap().internal_name,
            );
        }
    }
}

#[test]
fn reverse_breeding_unique_and_self_pair() {
    let gd = GameData::get();
    let cat_fire = gd.species_index("CatMage_Fire").expect("CatMage_Fire");
    // CatMage_Fire is bred BOTH by the gender-pinned CatMage x FoxMage unique
    // combo AND by a rank self-pair — pinning the unique flag, the gender
    // fields, and the self-pair/rank path in one species.
    let pairs = gd.reverse_breeding(cat_fire);
    assert_eq!(pairs.len(), 2, "CatMage_Fire has exactly two parent pairs");

    let name = |i: u16| gd.species_at(i).unwrap().internal_name.as_str();
    let unique = pairs.iter().find(|p| p.unique).expect("a unique pair");
    assert!(
        unique.parent1_gender.is_some() && unique.parent2_gender.is_some(),
        "unique combo carries both gender pins",
    );
    let un = [name(unique.parent1), name(unique.parent2)];
    assert!(
        un.contains(&"CatMage") && un.contains(&"FoxMage"),
        "unique combo is CatMage x FoxMage, got {un:?}",
    );

    let rank = pairs.iter().find(|p| !p.unique).expect("a rank pair");
    assert!(
        rank.parent1_gender.is_none() && rank.parent2_gender.is_none(),
        "rank pair has null genders",
    );
    assert_eq!(
        (name(rank.parent1), name(rank.parent2)),
        ("CatMage_Fire", "CatMage_Fire"),
        "rank pair is the self-pair",
    );
}

#[test]
fn reverse_breeding_is_deterministic_and_deduped() {
    let gd = GameData::get();
    let idx = gd.species_index("Anubis").expect("Anubis");
    let pairs = gd.reverse_breeding(idx);
    // Stable across calls.
    assert_eq!(pairs, gd.reverse_breeding(idx), "output is deterministic");
    // No duplicate canonical pairs.
    let mut seen = std::collections::HashSet::new();
    for p in &pairs {
        let key = (p.parent1.min(p.parent2), p.parent1.max(p.parent2));
        assert!(seen.insert(key), "duplicate pair {key:?}");
    }
    // Sorted by (parent1 dex, parent1 idx, parent2 dex, parent2 idx). Variants
    // share a paldex_no with their base form, so the index is the stable
    // tiebreak that makes the ordering total.
    let dex = |i: u16| gd.species_at(i).unwrap().paldex_no;
    assert!(
        pairs.windows(2).all(|w| {
            (dex(w[0].parent1), w[0].parent1, dex(w[0].parent2), w[0].parent2)
                <= (dex(w[1].parent1), w[1].parent1, dex(w[1].parent2), w[1].parent2)
        }),
        "pairs are dex-ordered with an index tiebreak",
    );
}

#[test]
fn drops_decode_with_ground_truth_and_new_stats() {
    let gd = GameData::get();

    // Lamball (SheepBall) ground truth from DT_PalDropItem: Wool 1-3 @100%,
    // Lamball Mutton (Meat_SheepBall) 1-1 @100%.
    let sheep = gd.species_by_id("SheepBall").expect("SheepBall present");
    let wool = sheep
        .drops
        .iter()
        .find(|d| d.item_id == "Wool")
        .expect("Lamball drops Wool");
    assert_eq!(wool.item_name, "Wool", "item name localized");
    assert_eq!((wool.min, wool.max), (1, 3), "Wool quantity range");
    assert_eq!(wool.rate, 100.0, "Wool rate is a percent (100)");
    assert!(
        sheep.drops.iter().any(|d| d.item_id == "Meat_SheepBall" && d.item_name == "Lamball Mutton"),
        "Lamball drops localized Lamball Mutton"
    );

    // A sub-100% drop is preserved as a real percent: Anubis -> Innovative
    // Technical Manual (TechnologyBook_G2) @5%.
    let anubis = gd.species_by_id("Anubis").expect("Anubis present");
    let manual = anubis
        .drops
        .iter()
        .find(|d| d.item_id == "TechnologyBook_G2")
        .expect("Anubis drops TechnologyBook_G2");
    assert_eq!(manual.rate, 5.0, "sub-100 rate kept as percent");

    // New extended stats decode (Support/CaptureRateCorrect/ExpRatio).
    assert_eq!(sheep.support, 100);
    assert_eq!(sheep.capture_rate_correct, 1.5);
    assert_eq!(sheep.exp_ratio, 1.0);

    // Every drop row across the pack is monotonic (min<=max) with a valid
    // percent rate in (0, 100]; coverage is broad (most species drop something).
    let mut with_drops = 0usize;
    for sp in gd.species() {
        if !sp.drops.is_empty() {
            with_drops += 1;
        }
        for d in &sp.drops {
            assert!(d.min <= d.max, "{}: {} min<=max", sp.internal_name, d.item_id);
            assert!(
                d.rate > 0.0 && d.rate <= 100.0,
                "{}: {} rate {} in (0,100]",
                sp.internal_name,
                d.item_id,
                d.rate
            );
        }
    }
    assert!(with_drops >= 250, "drops coverage {with_drops} unexpectedly low");
}
