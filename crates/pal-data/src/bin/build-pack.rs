//! Converts palcalc's vendored JSON (`vendor/db.json`, `vendor/breeding.json`)
//! into the compact bincode pack embedded by the library (`pack/paldata.pack`).
//!
//! Run with: `cargo run -p pal-data --bin build-pack`
//!
//! Deterministic: species keep their `db.json` order, and every serialized
//! structure is a `Vec` in a fixed order, so identical inputs yield identical
//! pack bytes.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;

use pal_data::gamedata::{
    BreedingEntry, ElementKind, InheritanceWeights, Pack, PalSpecies, ParentGender, PassiveSkill,
    UNREACHABLE,
};

// ---- raw JSON shapes (only the fields we consume) ----

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawDb {
    version: String,
    pals: Vec<RawPal>,
    passive_skills: Vec<RawPassive>,
    breeding_gender_probability: HashMap<String, HashMap<String, f32>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPalId {
    pal_dex_no: u32,
    is_variant: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPal {
    id: RawPalId,
    name: String,
    internal_name: String,
    breeding_power: u32,
    breeding_power_priority: u32,
    rarity: u32,
    hp: u32,
    attack: u32,
    defense: u32,
    guaranteed_passives_internal_ids: Vec<String>,
    nocturnal: bool,
    food_amount: u32,
    min_wild_level: Option<u32>,
    max_wild_level: Option<u32>,
    work_suitability: RawWork,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawWork {
    kindling: u8,
    watering: u8,
    planting: u8,
    generate_electricity: u8,
    handiwork: u8,
    gathering: u8,
    lumbering: u8,
    mining: u8,
    medicine_production: u8,
    cooling: u8,
    transporting: u8,
    farming: u8,
}

/// One entry of `vendor/partner-skills.json` (lowercase keys, no PascalCase).
#[derive(Deserialize)]
struct RawPartnerSkill {
    name: String,
    description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPassive {
    name: String,
    internal_name: String,
    rank: i32,
    is_standard_passive_skill: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawBreeding {
    breeding: Vec<RawBreedRow>,
    min_breeding_steps: HashMap<String, HashMap<String, u32>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawBreedRow {
    parent1_internal_name: String,
    parent1_gender: String,
    parent2_internal_name: String,
    parent2_gender: String,
    child_internal_name: String,
}

fn parse_gender(s: &str) -> ParentGender {
    match s {
        "MALE" => ParentGender::Male,
        "FEMALE" => ParentGender::Female,
        _ => ParentGender::Any,
    }
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = crate_dir();
    let vendor = dir.join("vendor");
    let db_bytes = std::fs::read(vendor.join("db.json"))?;
    let breeding_bytes = std::fs::read(vendor.join("breeding.json"))?;

    let db: RawDb = serde_json::from_slice(&db_bytes)?;
    let br: RawBreeding = serde_json::from_slice(&breeding_bytes)?;

    // Per-species element types (internal_name -> canonical kind names), derived
    // from oMaN-Rod/palworld-save-pal's data/json/pals.json (see vendor/NOTICE).
    let elements_bytes = std::fs::read(vendor.join("elements.json"))?;
    let raw_elements: HashMap<String, Vec<String>> = serde_json::from_slice(&elements_bytes)?;
    let elements: HashMap<String, Vec<ElementKind>> = raw_elements
        .iter()
        .map(|(name, kinds)| {
            let parsed = kinds
                .iter()
                .map(|k| {
                    ElementKind::parse(k)
                        .unwrap_or_else(|| panic!("elements.json: unknown kind {k:?} for {name}"))
                })
                .collect();
            (name.clone(), parsed)
        })
        .collect();

    // Per-species partner skill (internal_name -> {name, description}), sourced
    // from mlg404/palworld-paldex-api's `aura` field with game-accurate
    // variant->base inheritance (see vendor/NOTICE). Coverage is partial (base
    // game only); the ~130 species without a permissive source carry None.
    let partner_bytes = std::fs::read(vendor.join("partner-skills.json"))?;
    let partner_skills: HashMap<String, RawPartnerSkill> =
        serde_json::from_slice(&partner_bytes)?;

    // Intern species by db.json order.
    let mut index: HashMap<String, u16> = HashMap::with_capacity(db.pals.len());
    for (i, p) in db.pals.iter().enumerate() {
        index.insert(p.internal_name.clone(), i as u16);
    }
    let n = db.pals.len();

    let species: Vec<PalSpecies> = db
        .pals
        .iter()
        .map(|p| {
            let male = db
                .breeding_gender_probability
                .get(&p.internal_name)
                .and_then(|m| m.get("MALE").copied())
                .unwrap_or_else(|| {
                    eprintln!(
                        "warning: no gender probability for {}, defaulting to 0.5",
                        p.internal_name
                    );
                    0.5
                });
            PalSpecies {
                internal_name: p.internal_name.clone(),
                name: p.name.clone(),
                paldex_no: p.id.pal_dex_no.min(u16::MAX as u32) as u16,
                is_variant: p.id.is_variant,
                breeding_power: p.breeding_power.min(u16::MAX as u32) as u16,
                breeding_power_priority: p.breeding_power_priority,
                male_probability: male,
                rarity: p.rarity.min(u8::MAX as u32) as u8,
                hp: p.hp.min(u16::MAX as u32) as u16,
                attack: p.attack.min(u16::MAX as u32) as u16,
                defense: p.defense.min(u16::MAX as u32) as u16,
                guaranteed_passives: p.guaranteed_passives_internal_ids.clone(),
                work_suitability: {
                    let w = &p.work_suitability;
                    // Must match gamedata::WORK_KINDS order.
                    [
                        w.kindling,
                        w.watering,
                        w.planting,
                        w.generate_electricity,
                        w.handiwork,
                        w.gathering,
                        w.lumbering,
                        w.mining,
                        w.medicine_production,
                        w.cooling,
                        w.transporting,
                        w.farming,
                    ]
                },
                partner_skill: partner_skills
                    .get(&p.internal_name)
                    .map(|ps| ps.name.clone()),
                partner_skill_desc: partner_skills
                    .get(&p.internal_name)
                    .and_then(|ps| ps.description.clone()),
                nocturnal: p.nocturnal,
                food_amount: p.food_amount.min(u8::MAX as u32) as u8,
                // 13 uncatchable pals (bosses/quest) have null wild levels ->
                // (0, 0), read by the UI as "not found in the wild".
                wild_levels: (
                    p.min_wild_level.unwrap_or(0).min(u8::MAX as u32) as u8,
                    p.max_wild_level.unwrap_or(0).min(u8::MAX as u32) as u8,
                ),
                elements: elements.get(&p.internal_name).cloned().unwrap_or_default(),
            }
        })
        .collect();

    // Element coverage is a hard data contract: every species should resolve.
    let missing_elements: Vec<&str> = species
        .iter()
        .filter(|s| s.elements.is_empty())
        .map(|s| s.internal_name.as_str())
        .collect();
    if !missing_elements.is_empty() {
        eprintln!(
            "warning: {} species missing elements: {:?}",
            missing_elements.len(),
            missing_elements
        );
    }

    let passives: Vec<PassiveSkill> = db
        .passive_skills
        .iter()
        .map(|s| PassiveSkill {
            internal_name: s.internal_name.clone(),
            name: s.name.clone(),
            rank: s.rank.clamp(i8::MIN as i32, i8::MAX as i32) as i8,
            is_standard: s.is_standard_passive_skill,
        })
        .collect();

    // Breeding table (fail-soft: skip rows referencing unknown species).
    let mut breeding = Vec::with_capacity(br.breeding.len());
    let mut skipped = 0usize;
    for row in &br.breeding {
        let (Some(&p1), Some(&p2), Some(&c)) = (
            index.get(&row.parent1_internal_name),
            index.get(&row.parent2_internal_name),
            index.get(&row.child_internal_name),
        ) else {
            eprintln!(
                "warning: skipping breeding row with unknown species: {} x {} -> {}",
                row.parent1_internal_name, row.parent2_internal_name, row.child_internal_name
            );
            skipped += 1;
            continue;
        };
        breeding.push(BreedingEntry {
            parent1: p1,
            parent1_gender: parse_gender(&row.parent1_gender),
            parent2: p2,
            parent2_gender: parse_gender(&row.parent2_gender),
            child: c,
        });
    }

    // Min-steps matrix, flattened row-major (from * n + to), UNREACHABLE default.
    let mut min_steps = vec![UNREACHABLE; n * n];
    for (from_name, row) in &br.min_breeding_steps {
        let Some(&from) = index.get(from_name) else {
            eprintln!("warning: skipping min-steps row for unknown species {from_name}");
            continue;
        };
        for (to_name, &steps) in row {
            let Some(&to) = index.get(to_name) else {
                continue;
            };
            min_steps[from as usize * n + to as usize] = steps.min(UNREACHABLE as u32) as u16;
        }
    }

    let pack = Pack {
        version: db.version.clone(),
        species,
        passives,
        breeding,
        min_steps,
        inheritance: InheritanceWeights::default(),
    };

    let bytes = bincode::serialize(&pack)?;
    let out_dir = dir.join("pack");
    std::fs::create_dir_all(&out_dir)?;
    let out = out_dir.join("paldata.pack");
    std::fs::write(&out, &bytes)?;

    let json_total = db_bytes.len() + breeding_bytes.len();
    let with_elements = pack.species.iter().filter(|s| !s.elements.is_empty()).count();
    let with_partner = pack.species.iter().filter(|s| s.partner_skill.is_some()).count();
    println!(
        "wrote {} ({} bytes) | species={} (elements {}/{}, partner {}/{}) passives={} breeding={} (skipped {}) | vendor JSON={} bytes ({:.1}% of JSON)",
        out.display(),
        bytes.len(),
        pack.species.len(),
        with_elements,
        pack.species.len(),
        with_partner,
        pack.species.len(),
        pack.passives.len(),
        pack.breeding.len(),
        skipped,
        json_total,
        100.0 * bytes.len() as f64 / json_total as f64,
    );
    Ok(())
}
