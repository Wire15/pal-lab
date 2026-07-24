//! Converts the vendored JSON (`vendor/db.json`, `vendor/breeding.json`,
//! `vendor/extracted-game-data.json`) into the compact bincode pack embedded by
//! the library (`pack/paldata.pack`). Elements, partner-skill names/descriptions/
//! icons, extended stats, and passive effect/description/pal_facing metadata come
//! from the own-install extraction (joined case-insensitively by internal name);
//! everything else (passive id set + rank, breeding) from palcalc's
//! db.json/breeding.json.
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
    ActiveSkill, BreedingBoost, BreedingBoostSource, BreedingEffect, BreedingEntry, ElementKind,
    GameSettings, InheritanceWeights, LabResearch, LearnMove, Pack, PalSpecies, ParentGender,
    PassiveEffect, PassiveSkill, PassiveTier, UNREACHABLE,
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

// ---- own-install extraction (vendor/extracted-game-data.json) ----
// Authoritative source for elements, partner-skill names, and extended stats.
// Keys are snake_case (no PascalCase rename).

#[derive(Deserialize)]
struct RawExtract {
    meta: RawExtractMeta,
    game_settings: RawGameSettings,
    species: HashMap<String, RawExtractSpecies>,
    /// Passive-skill display metadata keyed by internal name (case may drift).
    passives: HashMap<String, RawExtractPassive>,
    /// Active-skill (waza) definitions keyed by prefix-stripped save-side id.
    #[serde(default)]
    active_skills: HashMap<String, RawExtractActive>,
    /// Level-up learnsets keyed by species internal name (`DT_WazaMasterLevel`),
    /// each already sorted by level ascending in the extraction.
    #[serde(default)]
    learnsets: HashMap<String, Vec<RawLearnMove>>,
    /// Structured breeding boosts (`breeding_boosts`), already deterministically
    /// ordered by the extractor. Enum fields parse straight from the snake_case JSON.
    #[serde(default)]
    breeding_boosts: Vec<RawBreedingBoost>,
    /// Breeding-relevant lab-research lines (`lab_research`), already grouped into
    /// per-category chains with cumulative per-rank fractions by the extractor.
    #[serde(default)]
    lab_research: Vec<RawLabResearch>,
}

/// One extraction breeding-boost entry; enums deserialize from the frozen
/// snake_case tokens directly into the pack [`BreedingBoost`] shape.
#[derive(Deserialize)]
struct RawBreedingBoost {
    source: String,
    source_kind: BreedingBoostSource,
    effect: BreedingEffect,
    values_per_rank: Vec<f32>,
}

/// One extraction lab-research line; the pack [`LabResearch`] shape 1:1 (the
/// extractor's per-node audit detail is dropped — the pack carries only the
/// cumulative curve the UI composes into `incubation_reduction`).
#[derive(Deserialize)]
struct RawLabResearch {
    id: String,
    name: String,
    category: String,
    effect: BreedingEffect,
    values_per_rank: Vec<f32>,
}

/// One extraction active-skill entry (see `tools/pal-extract`). Field names match
/// the JSON and the pack [`ActiveSkill`] shape 1:1.
#[derive(Deserialize)]
struct RawExtractActive {
    name: String,
    element: String,
    #[serde(default)]
    power: Option<i32>,
    #[serde(default)]
    cool_time: Option<i32>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct RawExtractMeta {
    game_build: String,
}

#[derive(Deserialize)]
struct RawGameSettings {
    combi_talent_inherit_num: Vec<u32>,
    combi_passive_inherit_num: Vec<u32>,
    combi_passive_random_add_num: Vec<u32>,
    combi_boss_pal_rate: f32,
}

#[derive(Deserialize)]
struct RawExtractSpecies {
    elements: Vec<String>,
    partner_skill: RawExtractPartner,
    stats: RawExtractStats,
}

#[derive(Deserialize)]
struct RawExtractPartner {
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    /// Numeric `TextureID` string (partner-skill icon key), when present.
    #[serde(default)]
    icon: Option<String>,
    /// Per-LEVEL description template (`{0}`..`{N}` slots), `None` when nothing
    /// varies across ranks or a placeholder was unresolvable.
    #[serde(default)]
    template: Option<String>,
    /// Per-slot per-rank display values, parallel to `template`'s slots. Absent
    /// (`null`)/empty when there is no template.
    #[serde(default)]
    values: Option<Vec<Vec<String>>>,
}

/// One level-up learnset row from the extraction (`DT_WazaMasterLevel`).
#[derive(Deserialize)]
struct RawLearnMove {
    waza_id: String,
    level: u16,
}

/// One extraction passive entry (additive display metadata; joined by internal
/// name onto the db.json passive set — rank/id semantics stay db.json's).
#[derive(Deserialize)]
struct RawExtractPassive {
    /// True when the passive is in a lottery pool (AddPal/AddRarePal/...).
    is_pal: bool,
    /// Lottery-pool tier membership (mutation ⇒ rainbow, world-tree ⇒ worldtree).
    #[serde(default)]
    world_tree_pool: bool,
    #[serde(default)]
    mutation_pool: bool,
    #[serde(default)]
    effects: Vec<RawExtractEffect>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct RawExtractEffect {
    #[serde(rename = "type")]
    effect_type: String,
    value: f32,
    target: String,
}

#[derive(Deserialize)]
struct RawExtractStats {
    price: u32,
    craft_speed: u32,
    slow_walk_speed: u32,
    walk_speed: u32,
    run_speed: u32,
    ride_sprint_speed: i32,
    transport_speed: i32,
    stamina: u32,
    max_full_stomach: u32,
    size: String,
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

    // Own-install extraction (build 24181527): authoritative source for
    // elements, partner-skill names, and extended stats (see vendor/NOTICE +
    // DESIGN.md). Replaces the former elements.json element source.
    let extract_bytes = std::fs::read(vendor.join("extracted-game-data.json"))?;
    let extract: RawExtract = serde_json::from_slice(&extract_bytes)?;
    // Case-insensitive join on InternalName (our db.json ids match exactly, but
    // extraction casing may drift across builds).
    let extract_ci: HashMap<String, &RawExtractSpecies> = extract
        .species
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v))
        .collect();

    // Extraction passive metadata (additive): joined case-insensitively onto the
    // db.json passive set. Ids/rank stay db.json's; effects/description/pal_facing
    // are display-only enrichment.
    let extract_passives_ci: HashMap<String, &RawExtractPassive> = extract
        .passives
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v))
        .collect();

    // Partner-skill icon keys resolve to a shipped PNG at app/public/partner/<id>.png
    // (crate is crates/pal-data, so repo-root app/ is two levels up). An icon id
    // with no PNG stays None so the UI can show a generic fallback glyph.
    let partner_icon_dir = dir.join("../../app/public/partner");
    let partner_pngs: std::collections::HashSet<String> = std::fs::read_dir(&partner_icon_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let p = e.path();
                    (p.extension().and_then(|x| x.to_str()) == Some("png"))
                        .then(|| p.file_stem().and_then(|s| s.to_str()).map(String::from))
                        .flatten()
                })
                .collect()
        })
        .unwrap_or_default();
    eprintln!(
        "partner icons: {} PNGs present at {}",
        partner_pngs.len(),
        partner_icon_dir.display()
    );

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
            // Extended data (elements, partner name, extended stats) is a hard
            // contract: every pack species MUST be present in the extraction.
            let ex = extract_ci
                .get(&p.internal_name.to_ascii_lowercase())
                .unwrap_or_else(|| {
                    panic!(
                        "extracted-game-data.json missing pack species {} — reconcile before building",
                        p.internal_name
                    )
                });
            let st = &ex.stats;
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
                // Extended stats — own-install extraction ground truth.
                price: st.price,
                craft_speed: st.craft_speed.min(u16::MAX as u32) as u16,
                slow_walk_speed: st.slow_walk_speed.min(u16::MAX as u32) as u16,
                walk_speed: st.walk_speed.min(u16::MAX as u32) as u16,
                run_speed: st.run_speed.min(u16::MAX as u32) as u16,
                // `-1` sentinel = not rideable / cannot transport; preserved.
                ride_sprint_speed: st.ride_sprint_speed.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
                transport_speed: st.transport_speed.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
                stamina: st.stamina.min(u16::MAX as u32) as u16,
                max_full_stomach: st.max_full_stomach.min(u16::MAX as u32) as u16,
                size: st.size.clone(),
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
                // Partner-skill NAME from the extraction (authoritative, all
                // species); "-"/empty normalized to None.
                partner_skill: ex
                    .partner_skill
                    .name
                    .clone()
                    .filter(|nm| !nm.trim().is_empty() && nm != "-"),
                // DESCRIPTION from the extraction (DT_PalFirstActivatedInfoText —
                // real in-game text); replaces the former partner-skills.json.
                partner_skill_desc: ex
                    .partner_skill
                    .description
                    .clone()
                    .filter(|d| !d.trim().is_empty()),
                // ICON key: the extraction's numeric TextureID, kept only when a
                // PNG for it is shipped in app/public/partner/. Unresolved -> None.
                partner_skill_icon: ex
                    .partner_skill
                    .icon
                    .clone()
                    .filter(|id| partner_pngs.contains(id)),
                // Per-LEVEL template + per-slot per-rank values (own-install extraction).
                // Element-swap variant stubs inherit the base pal's row in the extractor,
                // so both carry the base's template/values already.
                partner_skill_template: ex.partner_skill.template.clone(),
                partner_skill_values: ex.partner_skill.values.clone().unwrap_or_default(),
                nocturnal: p.nocturnal,
                food_amount: p.food_amount.min(u8::MAX as u32) as u8,
                // 13 uncatchable pals (bosses/quest) have null wild levels ->
                // (0, 0), read by the UI as "not found in the wild".
                wild_levels: (
                    p.min_wild_level.unwrap_or(0).min(u8::MAX as u32) as u8,
                    p.max_wild_level.unwrap_or(0).min(u8::MAX as u32) as u8,
                ),
                // Elements: own-install extraction ground truth.
                elements: ex
                    .elements
                    .iter()
                    .map(|k| {
                        ElementKind::parse(k).unwrap_or_else(|| {
                            panic!("extraction: unknown element {k:?} for {}", p.internal_name)
                        })
                    })
                    .collect(),
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

    // Reconciliation (extraction vs pack). Extra extraction species are
    // cut / NPC-only content we intentionally do not carry (no icons/breeding);
    // any pack species absent from the extraction would have panicked above, so
    // the reverse direction is guaranteed empty here.
    let pack_ci: std::collections::HashSet<String> =
        species.iter().map(|s| s.internal_name.to_ascii_lowercase()).collect();
    let mut extra: Vec<&str> = extract
        .species
        .keys()
        .filter(|k| !pack_ci.contains(&k.to_ascii_lowercase()))
        .map(|k| k.as_str())
        .collect();
    extra.sort_unstable();
    println!(
        "reconciliation: {} extraction species not in pack (dropped): {:?}",
        extra.len(),
        extra
    );

    // Guaranteed-passive id set across every species (case-insensitive): an
    // always-on passive like `Legend` is pal-facing even though its lottery
    // flag is false.
    let guaranteed_ci: std::collections::HashSet<String> = species
        .iter()
        .flat_map(|s| s.guaranteed_passives.iter())
        .map(|g| g.to_ascii_lowercase())
        .collect();

    let passives: Vec<PassiveSkill> = db
        .passive_skills
        .iter()
        .map(|s| {
            let ci = s.internal_name.to_ascii_lowercase();
            let ex = extract_passives_ci.get(&ci);
            // pal_facing = in a lottery pool (extraction is_pal) OR guaranteed on
            // some species (catches always-on passives absent from lottery pools).
            let pal_facing = ex.map(|e| e.is_pal).unwrap_or(false) || guaranteed_ci.contains(&ci);
            PassiveSkill {
                internal_name: s.internal_name.clone(),
                name: s.name.clone(),
                rank: s.rank.clamp(i8::MIN as i32, i8::MAX as i32) as i8,
                is_standard: s.is_standard_passive_skill,
                effects: ex
                    .map(|e| {
                        e.effects
                            .iter()
                            .map(|f| PassiveEffect {
                                effect_type: f.effect_type.clone(),
                                value: f.value,
                                target: f.target.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                description: ex.and_then(|e| e.description.clone()),
                pal_facing,
                // Mutation pool ⇒ rainbow, world-tree pool ⇒ worldtree (mutation
                // wins if both). None for ordinary passives / no extraction join.
                tier: ex.and_then(|e| {
                    if e.mutation_pool {
                        Some(PassiveTier::Rainbow)
                    } else if e.world_tree_pool {
                        Some(PassiveTier::WorldTree)
                    } else {
                        None
                    }
                }),
            }
        })
        .collect();

    // Passive join reconciliation (both directions), reported honestly.
    let db_passive_ci: std::collections::HashSet<String> = db
        .passive_skills
        .iter()
        .map(|s| s.internal_name.to_ascii_lowercase())
        .collect();
    let mut db_not_in_extract: Vec<&str> = db
        .passive_skills
        .iter()
        .filter(|s| !extract_passives_ci.contains_key(&s.internal_name.to_ascii_lowercase()))
        .map(|s| s.internal_name.as_str())
        .collect();
    db_not_in_extract.sort_unstable();
    let mut extract_not_in_db: Vec<&str> = extract
        .passives
        .keys()
        .filter(|k| !db_passive_ci.contains(&k.to_ascii_lowercase()))
        .map(|k| k.as_str())
        .collect();
    extract_not_in_db.sort_unstable();
    let pal_facing_count = passives.iter().filter(|p| p.pal_facing).count();
    println!(
        "passive join: db={} extraction={} | db-not-in-extraction={} (mostly test/NPC ids) | extraction-not-in-db={} | pal_facing={} (paldb reference 114)",
        db.passive_skills.len(),
        extract.passives.len(),
        db_not_in_extract.len(),
        extract_not_in_db.len(),
        pal_facing_count,
    );
    if !extract_not_in_db.is_empty() {
        println!("  extraction passives absent from db.json: {extract_not_in_db:?}");
    }
    eprintln!("passive db-not-in-extraction ids ({}): {db_not_in_extract:?}", db_not_in_extract.len());

    // Active skills: sorted `(id, ActiveSkill)` pairs for deterministic pack bytes.
    let mut active_skills: Vec<(String, ActiveSkill)> = extract
        .active_skills
        .iter()
        .map(|(id, a)| {
            (
                id.clone(),
                ActiveSkill {
                    name: a.name.clone(),
                    element: a.element.clone(),
                    power: a.power,
                    cool_time: a.cool_time,
                    description: a.description.clone(),
                },
            )
        })
        .collect();
    active_skills.sort_by(|a, b| a.0.cmp(&b.0));
    let tier_count = passives.iter().filter(|p| p.tier.is_some()).count();
    let rainbow = passives.iter().filter(|p| p.tier == Some(PassiveTier::Rainbow)).count();
    let worldtree = passives.iter().filter(|p| p.tier == Some(PassiveTier::WorldTree)).count();
    println!(
        "passive tiers: {tier_count} tiered (rainbow={rainbow} worldtree={worldtree}) | active_skills={}",
        active_skills.len(),
    );

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

    // Learnsets parallel to `species` (interned index order), joined case-insensitively
    // by internal name. Stable sort by level preserves the extraction's per-level order.
    let learn_ci: HashMap<String, &Vec<RawLearnMove>> = extract
        .learnsets
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v))
        .collect();
    let mut learn_total = 0usize;
    let mut learn_species = 0usize;
    let learnsets: Vec<Vec<LearnMove>> = species
        .iter()
        .map(|s| {
            let mut moves: Vec<LearnMove> = learn_ci
                .get(&s.internal_name.to_ascii_lowercase())
                .map(|rows| {
                    rows.iter()
                        .map(|r| LearnMove { waza_id: r.waza_id.clone(), level: r.level })
                        .collect()
                })
                .unwrap_or_default();
            moves.sort_by(|a, b| a.level.cmp(&b.level));
            if !moves.is_empty() {
                learn_species += 1;
                learn_total += moves.len();
            }
            moves
        })
        .collect();

    // Breeding boosts (data only; solver ignores this wave). Extractor order is already
    // deterministic; the pack mirrors it 1:1. Partner sources join species by internal name.
    let breeding_boosts: Vec<BreedingBoost> = extract
        .breeding_boosts
        .iter()
        .map(|b| BreedingBoost {
            source: b.source.clone(),
            source_kind: b.source_kind,
            effect: b.effect,
            values_per_rank: b.values_per_rank.clone(),
        })
        .collect();
    let cosmetic_boosts = breeding_boosts.iter().filter(|b| b.effect.is_cosmetic()).count();
    println!(
        "breeding boosts: {} total ({} cosmetic alpha-egg)",
        breeding_boosts.len(),
        cosmetic_boosts,
    );

    // Lab research (data only; solver ignores this wave). Extractor order is already
    // deterministic (by category id); the pack mirrors it 1:1.
    let lab_research: Vec<LabResearch> = extract
        .lab_research
        .iter()
        .map(|l| LabResearch {
            id: l.id.clone(),
            name: l.name.clone(),
            category: l.category.clone(),
            effect: l.effect,
            values_per_rank: l.values_per_rank.clone(),
        })
        .collect();
    println!(
        "lab research: {} lines ({})",
        lab_research.len(),
        lab_research
            .iter()
            .map(|l| format!("{}={:?}", l.id, l.values_per_rank))
            .collect::<Vec<_>>()
            .join(", "),
    );

    let pack = Pack {
        version: db.version.clone(),
        game_build: extract.meta.game_build.clone(),
        species,
        passives,
        active_skills,
        breeding,
        min_steps,
        inheritance: InheritanceWeights::default(),
        game_settings: GameSettings {
            combi_talent_inherit_num: extract.game_settings.combi_talent_inherit_num.clone(),
            combi_passive_inherit_num: extract.game_settings.combi_passive_inherit_num.clone(),
            combi_passive_random_add_num: extract.game_settings.combi_passive_random_add_num.clone(),
            combi_boss_pal_rate: extract.game_settings.combi_boss_pal_rate,
        },
        learnsets,
        breeding_boosts,
        lab_research,
    };

    let bytes = bincode::serialize(&pack)?;
    let out_dir = dir.join("pack");
    std::fs::create_dir_all(&out_dir)?;
    let out = out_dir.join("paldata.pack");
    std::fs::write(&out, &bytes)?;

    let json_total = db_bytes.len() + breeding_bytes.len() + extract_bytes.len();
    let with_elements = pack.species.iter().filter(|s| !s.elements.is_empty()).count();
    let with_partner = pack.species.iter().filter(|s| s.partner_skill.is_some()).count();
    let with_partner_desc = pack.species.iter().filter(|s| s.partner_skill_desc.is_some()).count();
    let with_partner_icon = pack.species.iter().filter(|s| s.partner_skill_icon.is_some()).count();
    println!(
        "wrote {} ({} bytes) | build={} | species={} (elements {}/{}, partner name {}/{} desc {}/{} icon {}/{}) passives={} breeding={} (skipped {}) | vendor JSON={} bytes ({:.1}% of JSON)",
        out.display(),
        bytes.len(),
        pack.game_build,
        pack.species.len(),
        with_elements,
        pack.species.len(),
        with_partner,
        pack.species.len(),
        with_partner_desc,
        pack.species.len(),
        with_partner_icon,
        pack.species.len(),
        pack.passives.len(),
        pack.breeding.len(),
        skipped,
        json_total,
        100.0 * bytes.len() as f64 / json_total as f64,
    );
    let with_template = pack.species.iter().filter(|s| s.partner_skill_template.is_some()).count();
    let template_slots: usize = pack.species.iter().map(|s| s.partner_skill_values.len()).sum();
    println!(
        "partner per-level: {}/{} species have a template ({} total slots) | learnsets: {}/{} species, {} moves total",
        with_template,
        pack.species.len(),
        template_slots,
        learn_species,
        pack.species.len(),
        learn_total,
    );
    Ok(())
}
