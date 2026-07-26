//! Frontend-facing pal-dex reference commands over the embedded [`GameData`]
//! pack, plus a per-save roster tally.
//!
//! All species/breeding data comes from `pal_data::GameData::get()` (decoded
//! once, `'static`). `roster_counts` reads a save directory via
//! `pal_save::read_save_dir` on each call — cheap relative to the solver and
//! keeps the command stateless.

use std::collections::HashMap;
use std::path::Path;

use pal_data::gamedata::{ItemDrop, ParentGender, PalSpecies};
use pal_data::types::Gender;
use pal_data::GameData;
use serde::Serialize;

/// A passive resolved to `{id, name, rank}` (falls back to the raw id when the
/// pack has no matching definition).
#[derive(Debug, Clone, Serialize)]
pub struct PassiveRef {
    pub id: String,
    pub name: String,
    pub rank: i8,
}

fn passive_ref(gd: &GameData, id: &str) -> PassiveRef {
    match gd.passive_by_id(id) {
        Some(p) => PassiveRef { id: p.internal_name.clone(), name: p.name.clone(), rank: p.rank },
        None => PassiveRef { id: id.to_string(), name: id.to_string(), rank: 0 },
    }
}

/// Base + extended stats the pack carries for a species. Extended fields
/// (price, speeds, stamina, size, …) come from the own-install extraction;
/// mirrors the frozen `SpeciesStats` TS contract.
#[derive(Debug, Clone, Serialize)]
pub struct SpeciesStats {
    pub hp: u16,
    pub attack: u16,
    pub defense: u16,
    pub rarity: u8,
    /// Merchant sell price.
    pub price: u32,
    /// Crafting-speed multiplier (percent; 100 for every pal).
    pub craft_speed: u16,
    pub slow_walk_speed: u16,
    pub walk_speed: u16,
    pub run_speed: u16,
    /// Mounted sprint speed; `-1` when the species is not rideable.
    pub ride_sprint_speed: i16,
    /// Transport hauling speed; `-1` when the species cannot transport.
    pub transport_speed: i16,
    pub stamina: u16,
    pub max_full_stomach: u16,
    /// Body-size class: `"XS"`, `"S"`, `"M"`, `"L"`, `"XL"`.
    pub size: String,
    /// P(male) as a percent (0-100). NOTE: `SpeciesEntry.male_probability` is
    /// the 0-1 fraction the gender bar reads; this percent copy exists per the
    /// frozen `SpeciesStats` contract.
    pub male_probability: f32,
    /// `Support` stat (partner-skill support value; 100 for every species).
    pub support: u16,
    /// `CaptureRateCorrect` — per-species capture-rate multiplier.
    pub capture_rate_correct: f32,
    /// `ExpRatio` — per-species XP-gain multiplier.
    pub exp_ratio: f32,
}

/// A lightweight species reference (`{id, name, paldex_no}`) for parent/child
/// links where full stats aren't needed.
#[derive(Debug, Clone, Serialize)]
pub struct SpeciesRef {
    pub id: String,
    pub name: String,
    pub paldex_no: u16,
}

fn species_ref(sp: &PalSpecies) -> SpeciesRef {
    SpeciesRef { id: sp.internal_name.clone(), name: sp.name.clone(), paldex_no: sp.paldex_no }
}

/// One species row for the pal-dex list.
#[derive(Debug, Clone, Serialize)]
pub struct SpeciesEntry {
    pub id: String,
    pub name: String,
    pub paldex_no: u16,
    pub is_variant: bool,
    /// palcalc `BreedingPower` used by the child formula.
    pub combi_rank: u16,
    /// Tie-breaker priority for equal combi ranks.
    pub combi_rank_priority: u32,
    pub male_probability: f32,
    pub stats: SpeciesStats,
    pub guaranteed_passives: Vec<PassiveRef>,
    /// Work-suitability levels in `pal_data::gamedata::WORK_KINDS` canonical
    /// order (12 entries; the client filters to nonzero for display).
    pub work_suitability: Vec<u8>,
    /// Partner-skill display name, when known (`null` for ~130 DLC species).
    pub partner_skill: Option<String>,
    /// Partner-skill effect description, paired with `partner_skill`.
    pub partner_skill_desc: Option<String>,
    /// Partner-skill description with `{0}`..`{N}` slot markers where a value
    /// varies across ranks (Lv1..LvN); constants baked in. `null` when nothing
    /// varies. Paired with `partner_skill_values`.
    pub partner_skill_template: Option<String>,
    /// Per-slot display values for `partner_skill_template`: outer = slot, inner
    /// = value per rank ascending. Empty when there is no template.
    pub partner_skill_values: Vec<Vec<String>>,
    /// Partner-skill icon key (numeric `TextureID` string) when a PNG resolves
    /// at `app/public/partner/<id>.png`; `null` -> UI shows a generic glyph.
    pub partner_skill_icon: Option<String>,
    pub nocturnal: bool,
    pub food_amount: u8,
    /// `(min, max)` wild spawn level; `(0, 0)` means not found in the wild.
    pub wild_levels: (u8, u8),
    /// Element type(s): 1–2 canonical kind names (`"Normal"`, `"Fire"`, …) in
    /// the game's primary-then-secondary order.
    pub elements: Vec<String>,
}

fn species_entry(gd: &GameData, sp: &PalSpecies) -> SpeciesEntry {
    SpeciesEntry {
        id: sp.internal_name.clone(),
        name: sp.name.clone(),
        paldex_no: sp.paldex_no,
        is_variant: sp.is_variant,
        combi_rank: sp.breeding_power,
        combi_rank_priority: sp.breeding_power_priority,
        male_probability: sp.male_probability,
        stats: SpeciesStats {
            hp: sp.hp,
            attack: sp.attack,
            defense: sp.defense,
            rarity: sp.rarity,
            price: sp.price,
            craft_speed: sp.craft_speed,
            slow_walk_speed: sp.slow_walk_speed,
            walk_speed: sp.walk_speed,
            run_speed: sp.run_speed,
            ride_sprint_speed: sp.ride_sprint_speed,
            transport_speed: sp.transport_speed,
            stamina: sp.stamina,
            max_full_stomach: sp.max_full_stomach,
            size: sp.size.clone(),
            male_probability: (sp.male_probability * 100.0).round(),
            support: sp.support,
            capture_rate_correct: sp.capture_rate_correct,
            exp_ratio: sp.exp_ratio,
        },
        guaranteed_passives: sp
            .guaranteed_passives
            .iter()
            .map(|p| passive_ref(gd, p))
            .collect(),
        work_suitability: sp.work_suitability.to_vec(),
        partner_skill: sp.partner_skill.clone(),
        partner_skill_desc: sp.partner_skill_desc.clone(),
        partner_skill_template: sp.partner_skill_template.clone(),
        partner_skill_values: sp.partner_skill_values.clone(),
        partner_skill_icon: sp.partner_skill_icon.clone(),
        nocturnal: sp.nocturnal,
        food_amount: sp.food_amount,
        wild_levels: sp.wild_levels,
        elements: sp.elements.iter().map(|e| e.as_str().to_string()).collect(),
    }
}

/// Every species, in interned-index order, for the pal-dex grid.
#[tauri::command]
pub fn paldex_species() -> Vec<SpeciesEntry> {
    let gd = GameData::get();
    gd.species().map(|sp| species_entry(gd, sp)).collect()
}

/// A gender-pinned ("unique combo") breeding entry this species takes part in.
#[derive(Debug, Clone, Serialize)]
pub struct UniqueCombo {
    pub parent_a: SpeciesRef,
    pub parent_b: SpeciesRef,
    pub child: SpeciesRef,
    /// `"parent"` if this species is one of the parents, `"child"` otherwise.
    pub role: &'static str,
}

/// Breeding participation notes for a species detail.
#[derive(Debug, Clone, Serialize)]
pub struct BreedingNotes {
    /// Distinct parent pairs that breed into this species.
    pub parent_pair_count: usize,
    /// Gender-pinned unique combos involving this species (as parent or child).
    pub unique_combos: Vec<UniqueCombo>,
}

/// One resolved level-up learnable move for the detail view: the save-side waza
/// `id` (joins `list_active_skills`) plus the `level` it is learned at.
#[derive(Debug, Clone, Serialize)]
pub struct LearnMoveEntry {
    pub id: String,
    pub level: u16,
}

/// Full detail: the list row plus breeding participation notes and the level-up
/// learnset (sorted by level ascending).
#[derive(Debug, Clone, Serialize)]
pub struct SpeciesDetail {
    #[serde(flatten)]
    pub species: SpeciesEntry,
    pub breeding: BreedingNotes,
    /// Level-up learnable actives, sorted by level ascending; empty when the
    /// species has no level-up rows.
    pub learnset: Vec<LearnMoveEntry>,
    /// Per-pal item drops (`DT_PalDropItem`), in slot order; empty for the few
    /// variant species with no drop row. Detail-only (kept off the grid row).
    pub drops: Vec<ItemDrop>,
}

/// Detail for one species by its internal id (`CharacterID`).
#[tauri::command]
pub fn paldex_species_detail(id: String) -> Result<SpeciesDetail, String> {
    let gd = GameData::get();
    let idx = gd
        .species_index(&id)
        .ok_or_else(|| format!("unknown pal: {id}"))?;
    let sp = gd.species_at(idx).expect("index in range");

    let parent_pair_count = gd.parents_of(idx).len();

    // Scan the breeding table for gender-pinned rows this species appears in.
    let mut unique_combos = Vec::new();
    for e in gd.breeding() {
        let pinned = e.parent1_gender != ParentGender::Any || e.parent2_gender != ParentGender::Any;
        if !pinned {
            continue;
        }
        let role = if e.parent1 == idx || e.parent2 == idx {
            "parent"
        } else if e.child == idx {
            "child"
        } else {
            continue;
        };
        let (Some(pa), Some(pb), Some(ch)) =
            (gd.species_at(e.parent1), gd.species_at(e.parent2), gd.species_at(e.child))
        else {
            continue;
        };
        unique_combos.push(UniqueCombo {
            parent_a: species_ref(pa),
            parent_b: species_ref(pb),
            child: species_ref(ch),
            role,
        });
    }

    let learnset = gd
        .learnset(idx)
        .iter()
        .map(|m| LearnMoveEntry { id: m.waza_id.clone(), level: m.level })
        .collect();

    Ok(SpeciesDetail {
        species: species_entry(gd, sp),
        breeding: BreedingNotes { parent_pair_count, unique_combos },
        learnset,
        drops: sp.drops.clone(),
    })
}

/// Genders to try for a parent: the one specified, or both when unspecified.
fn gender_opts(g: Option<String>) -> Vec<Gender> {
    match g.as_deref() {
        Some("Male") => vec![Gender::Male],
        Some("Female") => vec![Gender::Female],
        _ => vec![Gender::Male, Gender::Female],
    }
}

/// Result of breeding two parents.
#[derive(Debug, Clone, Serialize)]
pub struct ChildResult {
    pub child: Option<SpeciesRef>,
}

/// Resolve the child of breeding `parent_a` x `parent_b`. Genders are optional;
/// when omitted every Male/Female combination is tried and the first resolved
/// child returned (covers the gender-independent majority and the unique combos).
#[tauri::command]
pub fn breeding_child(
    parent_a: String,
    parent_b: String,
    gender_a: Option<String>,
    gender_b: Option<String>,
) -> Result<ChildResult, String> {
    let gd = GameData::get();
    let a = gd
        .species_index(&parent_a)
        .ok_or_else(|| format!("unknown pal: {parent_a}"))?;
    let b = gd
        .species_index(&parent_b)
        .ok_or_else(|| format!("unknown pal: {parent_b}"))?;

    let a_opts = gender_opts(gender_a);
    let b_opts = gender_opts(gender_b);

    let mut child_idx = None;
    'outer: for &pga in &a_opts {
        for &pgb in &b_opts {
            if let Some(c) = gd.child_of(a, pga, b, pgb) {
                child_idx = Some(c);
                break 'outer;
            }
        }
    }

    Ok(ChildResult {
        child: child_idx
            .and_then(|c| gd.species_at(c))
            .map(species_ref),
    })
}

/// A canonical parent pair that breeds into a target child.
#[derive(Debug, Clone, Serialize)]
pub struct ParentPair {
    pub parent_a: SpeciesRef,
    pub parent_b: SpeciesRef,
}

/// Parent pairs that produce `child`, capped for payload size.
#[derive(Debug, Clone, Serialize)]
pub struct ParentsResult {
    /// Total distinct parent pairs (before the cap).
    pub total: usize,
    /// At most 500 pairs.
    pub pairs: Vec<ParentPair>,
}

const MAX_PAIRS: usize = 500;

/// Reverse breeding lookup: canonical parent pairs that breed into `child`.
#[tauri::command]
pub fn breeding_parents(child: String) -> Result<ParentsResult, String> {
    let gd = GameData::get();
    let idx = gd
        .species_index(&child)
        .ok_or_else(|| format!("unknown pal: {child}"))?;
    let all = gd.parents_of(idx);
    let pairs = all
        .iter()
        .take(MAX_PAIRS)
        .filter_map(|&(a, b)| {
            let (pa, pb) = (gd.species_at(a)?, gd.species_at(b)?);
            Some(ParentPair { parent_a: species_ref(pa), parent_b: species_ref(pb) })
        })
        .collect();
    Ok(ParentsResult { total: all.len(), pairs })
}

/// One parent pair that breeds into a target child, per the frozen `ReversePair`
/// contract. Parents are internal names (the cross-layer species key); `kind` is
/// `"unique"` for a gender-pinned combo row and `"rank"` for the gender-
/// independent combi-rank majority; the gender fields are `Some` only on a
/// pinned `"unique"` pair (`null` otherwise).
#[derive(Debug, Clone, Serialize)]
pub struct ReversePair {
    pub parent1: String,
    pub parent2: String,
    pub kind: &'static str,
    pub parent1_gender: Option<Gender>,
    pub parent2_gender: Option<Gender>,
}

/// Reverse breeding: every unordered parent pair whose bred child resolves to
/// `species`. Thin serde adapter over [`GameData::reverse_breeding`] — the pair
/// enumeration, dedup, ordering, and gender pins live in `pal-data` (unit-tested
/// against the forward `child_of`). Parents are mapped to internal names; the
/// pal-data `unique` flag becomes the `"unique"`/`"rank"` `kind` token.
#[tauri::command]
pub fn reverse_breeding(species: String) -> Result<Vec<ReversePair>, String> {
    let gd = GameData::get();
    let idx = gd
        .species_index(&species)
        .ok_or_else(|| format!("unknown pal: {species}"))?;
    let pairs = gd
        .reverse_breeding(idx)
        .into_iter()
        .filter_map(|p| {
            let (p1, p2) = (gd.species_at(p.parent1)?, gd.species_at(p.parent2)?);
            Some(ReversePair {
                parent1: p1.internal_name.clone(),
                parent2: p2.internal_name.clone(),
                kind: if p.unique { "unique" } else { "rank" },
                parent1_gender: p.parent1_gender,
                parent2_gender: p.parent2_gender,
            })
        })
        .collect();
    Ok(pairs)
}

/// Owned-roster tally for one species.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RosterCount {
    pub male: u32,
    pub female: u32,
    /// Best (max) IV seen across owned instances of this species.
    pub best_ivs: BestIvs,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct BestIvs {
    pub hp: u8,
    pub atk: u8,
    pub def: u8,
}

/// Per-species owned counts + best IVs from a loaded save directory.
#[tauri::command]
pub fn roster_counts(save_dir: String) -> Result<HashMap<String, RosterCount>, String> {
    if save_dir.trim().is_empty() {
        return Err("No save folder selected.".into());
    }
    let save = pal_save::read_save_dir(Path::new(&save_dir)).map_err(|e| e.to_string())?;
    let mut counts: HashMap<String, RosterCount> = HashMap::new();
    for pal in &save.pals {
        let entry = counts.entry(pal.character_id.clone()).or_default();
        match pal.gender {
            Some(Gender::Male) => entry.male += 1,
            Some(Gender::Female) => entry.female += 1,
            None => {}
        }
        entry.best_ivs.hp = entry.best_ivs.hp.max(pal.ivs.hp);
        entry.best_ivs.atk = entry.best_ivs.atk.max(pal.ivs.attack);
        entry.best_ivs.def = entry.best_ivs.def.max(pal.ivs.defense);
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn testdata_dir() -> String {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58")
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn species_list_is_full_dex() {
        let list = paldex_species();
        assert_eq!(list.len(), 299, "expected 299 species, got {}", list.len());
    }

    #[test]
    fn anubis_detail_has_combi_rank_480() {
        let detail = paldex_species_detail("Anubis".into()).expect("Anubis exists");
        assert_eq!(detail.species.combi_rank, 480, "Anubis combi_rank");
    }

    #[test]
    fn anubis_has_parents() {
        let parents = breeding_parents("Anubis".into()).expect("Anubis exists");
        assert!(parents.total > 0, "expected >=1 parent pair for Anubis");
        assert!(!parents.pairs.is_empty(), "expected non-empty pairs");
        assert!(parents.pairs.len() <= MAX_PAIRS, "pairs capped at {MAX_PAIRS}");
    }

    /// Forward-consistency property: every emitted parent pair, when bred
    /// forward via [`GameData::child_of`], resolves to the target species.
    /// Covers a common mid-rank species, a self-pair species, and the two
    /// gender-pinned unique combos. Rank pairs are gender-independent (an `Any`
    /// pin matches `Male`); unique pairs are checked with their pins.
    #[test]
    fn reverse_breeding_forward_consistent() {
        let gd = GameData::get();
        for target in ["Anubis", "Alpaca", "CatMage_Fire", "FoxMage_Dark"] {
            let idx = gd.species_index(target).expect("target exists");
            let pairs = reverse_breeding(target.to_string()).expect("reverse");
            assert!(!pairs.is_empty(), "expected >=1 parent pair for {target}");
            for p in &pairs {
                let a = gd.species_index(&p.parent1).expect("parent1 exists");
                let b = gd.species_index(&p.parent2).expect("parent2 exists");
                let ga = p.parent1_gender.unwrap_or(Gender::Male);
                let gb = p.parent2_gender.unwrap_or(Gender::Male);
                assert_eq!(
                    gd.child_of(a, ga, b, gb),
                    Some(idx),
                    "forward({} x {}) should breed {target}",
                    p.parent1,
                    p.parent2
                );
            }
        }
    }

    /// CatMage_Fire is bred BOTH by the gender-pinned CatMage x FoxMage unique
    /// combo AND by a rank self-pair (CatMage_Fire x CatMage_Fire) — so it pins
    /// down the unique badge, the gender fields, and the self-pair/rank path in
    /// one species.
    #[test]
    fn reverse_breeding_unique_and_self_pair() {
        let pairs = reverse_breeding("CatMage_Fire".to_string()).expect("reverse");
        assert_eq!(pairs.len(), 2, "CatMage_Fire has exactly two parent pairs");

        let unique = pairs.iter().find(|p| p.kind == "unique").expect("a unique pair");
        assert!(
            unique.parent1_gender.is_some() && unique.parent2_gender.is_some(),
            "unique combo carries both gender pins"
        );
        let unique_names = [unique.parent1.as_str(), unique.parent2.as_str()];
        assert!(
            unique_names.contains(&"CatMage") && unique_names.contains(&"FoxMage"),
            "unique combo is CatMage x FoxMage, got {unique_names:?}"
        );

        let rank = pairs.iter().find(|p| p.kind == "rank").expect("a rank pair");
        assert!(
            rank.parent1_gender.is_none() && rank.parent2_gender.is_none(),
            "rank pair has null genders"
        );
        assert_eq!(
            (rank.parent1.as_str(), rank.parent2.as_str()),
            ("CatMage_Fire", "CatMage_Fire"),
            "rank pair is the self-pair"
        );
    }

    #[test]
    fn roster_counts_from_testdata() {
        let counts = roster_counts(testdata_dir()).expect("save reads");
        assert!(!counts.is_empty(), "expected >0 species in roster");
        let total: u32 = counts.values().map(|c| c.male + c.female).sum();
        assert!(total > 0, "expected some gendered pals");
    }

    /// Regenerate the dev-mode fixtures under `app/src/dev-fixtures/` from the
    /// real commands run against `testdata`. Ignored by default; run with
    /// `cargo test gen_dev_fixtures -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn gen_dev_fixtures() {
        use std::collections::HashMap as Map;
        use std::fs;

        let out = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/dev-fixtures");
        fs::create_dir_all(&out).expect("create dev-fixtures dir");
        let write = |name: &str, json: String| {
            fs::write(out.join(name), json).unwrap_or_else(|e| panic!("write {name}: {e}"));
            eprintln!("wrote {name}");
        };

        // paldex-species.json — full 299.
        write(
            "paldex-species.json",
            serde_json::to_string_pretty(&paldex_species()).unwrap(),
        );

        // roster-counts.json — testdata roster tally.
        write(
            "roster-counts.json",
            serde_json::to_string_pretty(&roster_counts(testdata_dir()).expect("roster")).unwrap(),
        );

        // list-passives.json — the Solver view's passive autocomplete.
        write(
            "list-passives.json",
            serde_json::to_string_pretty(&crate::solver::list_passives()).unwrap(),
        );

        // breeding-boosts.json — the Solver BREEDING SETUP panel's booster list
        // (source + resolved display name + per-rank fractions). Mechanical mirror
        // of the pack; ALL entries emitted, the UI filters cosmetics.
        write(
            "breeding-boosts.json",
            serde_json::to_string_pretty(&crate::solver::list_breeding_boosts()).unwrap(),
        );

        // lab-research.json — the Solver BREEDING SETUP panel's LAB RESEARCH group
        // (incubation-acceleration lines + cumulative per-rank fractions). Mechanical
        // mirror of the pack; the UI dedupes identical lines.
        write(
            "lab-research.json",
            serde_json::to_string_pretty(&crate::solver::list_lab_research()).unwrap(),
        );

        // active-skills.json — waza id -> ActiveSkill (name/element/power/cool_time/
        // description), sorted by id for determinism.
        let active_skills: std::collections::BTreeMap<String, pal_data::ActiveSkill> =
            crate::solver::list_active_skills().into_iter().collect();
        write(
            "active-skills.json",
            serde_json::to_string_pretty(&active_skills).unwrap(),
        );

        // solve-result.json — Anubis + Runner + PAL_Sanity_Up_1, up to 3 plans.
        // Computed BEFORE the save-summary trim so the trim (pass 0 below) can
        // guarantee the owned pals these plans reference survive into
        // save-summary.json — the frontend hover-by-instance lookup resolves a
        // plan node's `Owned.instance_id` against the save-summary roster, so at
        // least one owned node's id MUST exist there for the demo to resolve.
        use pal_solver::solver::{
            resolve_passive, resolve_species, solve as run_solver, SolverConfig, TargetPal,
            TargetSpec,
        };
        let gd = GameData::get();
        let target = resolve_species(gd, "Anubis").expect("Anubis");
        let passives = ["Runner", "PAL_Sanity_Up_1"]
            .iter()
            .map(|n| resolve_passive(gd, n).expect("passive"))
            .collect();
        let mut cfg = SolverConfig::default();
        cfg.max_breeding_steps = 5;
        cfg.max_solver_iterations = 5;
        let mut spec = TargetSpec::new(TargetPal::Species(target));
        spec.required_passives = passives;
        let save = pal_save::read_save_dir(std::path::Path::new(&testdata_dir())).expect("save");
        let mut plans: Vec<_> = run_solver(gd, &spec, &save.pals, &cfg)
            .into_iter()
            .take(3)
            .collect();
        assert!(!plans.is_empty(), "expected solver plans for fixture");
        // Append a wild catch->breed chain example (include_wild): a non-catchable
        // target bred from two wild-catchable parents. Surfaces the "wild" node kind
        // that SolverUI renders. Icelyn is a clean same-cost chain on the stable pack.
        if let Some(icelyn) = resolve_species(gd, "Icelyn") {
            let mut wcfg = SolverConfig::default();
            wcfg.include_wild = true;
            wcfg.max_breeding_steps = 4;
            wcfg.max_solver_iterations = 4;
            let wspec = TargetSpec::new(TargetPal::Species(icelyn));
            if let Some(p) = run_solver(gd, &wspec, &[], &wcfg).into_iter().next() {
                plans.push(p);
            }
        }
        // Owned instance ids referenced by these plans (walk each plan tree).
        fn collect_owned_ids(
            node: &pal_solver::solver::results::PlanNode,
            out: &mut Vec<pal_data::types::Guid>,
        ) {
            if let pal_solver::solver::results::PlanSource::Owned { instance_id, .. } = &node.source {
                out.push(*instance_id);
            }
            for c in &node.children {
                collect_owned_ids(c, out);
            }
        }
        let mut plan_owned_ids: Vec<pal_data::types::Guid> = Vec::new();
        for p in &plans {
            collect_owned_ids(&p.root, &mut plan_owned_ids);
        }

        // save-summary.json — real summary, pals trimmed to a representative
        // ~60 covering every container kind present.
        let mut summary = crate::save::load_save(testdata_dir()).expect("load save");
        let mut per_kind: Map<String, u32> = Map::new();
        let mut kinds_seen: Map<String, ()> = Map::new();
        let mut trimmed: Vec<pal_data::types::OwnedPal> = Vec::new();
        // pass 0: guarantee every owned pal the solve-result plans reference
        // survives the trim, so a plan node's `Owned.instance_id` resolves
        // against the save-summary roster in dev-mode hover.
        for pal in &summary.pals {
            if plan_owned_ids.contains(&pal.instance_id)
                && !trimmed.iter().any(|p| p.instance_id == pal.instance_id)
            {
                let k = format!("{:?}", pal.container_kind);
                trimmed.push(pal.clone());
                *per_kind.entry(k).or_default() += 1;
            }
        }
        // pass 1: one representative per kind.
        for pal in &summary.pals {
            let k = format!("{:?}", pal.container_kind);
            if kinds_seen.insert(k.clone(), ()).is_none()
                && !trimmed.iter().any(|p| p.instance_id == pal.instance_id)
            {
                trimmed.push(pal.clone());
                *per_kind.entry(k).or_default() += 1;
            }
        }
        // pass 1b: guarantee a few human NPCs so the dev shim exercises the
        // is_human rendering path (humans share Base/Palbox kinds with pals, so
        // pass 1 may miss them).
        for pal in &summary.pals {
            if trimmed.iter().filter(|p| p.is_human).count() >= 3 {
                break;
            }
            if pal.is_human && !trimmed.iter().any(|p| p.instance_id == pal.instance_id) {
                let k = format!("{:?}", pal.container_kind);
                trimmed.push(pal.clone());
                *per_kind.entry(k).or_default() += 1;
            }
        }
        // pass 1c: guarantee a couple of lucky (IsRarePal) pals so the dev shim
        // exercises the is_lucky "Alpha" rendering path (13 exist in the real
        // save but the representative-per-kind passes above may miss them all).
        for pal in &summary.pals {
            if trimmed.iter().filter(|p| p.is_lucky).count() >= 2 {
                break;
            }
            if pal.is_lucky && !trimmed.iter().any(|p| p.instance_id == pal.instance_id) {
                let k = format!("{:?}", pal.container_kind);
                trimmed.push(pal.clone());
                *per_kind.entry(k).or_default() += 1;
            }
        }
        // pass 2: fill to ~60, <=12 per kind.
        for pal in &summary.pals {
            if trimmed.len() >= 60 {
                break;
            }
            let k = format!("{:?}", pal.container_kind);
            let c = per_kind.entry(k).or_default();
            if *c < 12 && !trimmed.iter().any(|p| p.instance_id == pal.instance_id) {
                trimmed.push(pal.clone());
                *c += 1;
            }
        }
        summary.pals = trimmed;
        // Sanity: at least one plan-referenced owned pal made it into the roster,
        // otherwise dev-mode hover-by-instance can't be demoed.
        assert!(
            plan_owned_ids.iter().any(|id| summary.pals.iter().any(|p| &p.instance_id == id)),
            "save-summary must retain >=1 owned pal referenced by solve-result plans",
        );
        write(
            "save-summary.json",
            serde_json::to_string_pretty(&summary).unwrap(),
        );

        // Wrap into the `solve` command's SolveResponse shape {plans, fallback_used}.
        // fallback_used=false: this is the realistic breeding-first response for an
        // owned-reachable target (the Icelyn chain is appended purely to exercise
        // the wild-node rendering + the "N wild" stat). The UI's fallback / catch-only
        // callouts key off fallback_used=true or a lone 0-step wild-root plan.
        let response = crate::solver::SolveResponse {
            plans,
            fallback_used: false,
            pins_satisfied: true,
            diagnosis: Vec::new(),
        };
        let solve_json = serde_json::to_string_pretty(&response).unwrap();
        assert!(
            solve_json.contains("\"Wild\""),
            "solve-result fixture must contain a wild node example (include_wild chain)",
        );
        assert!(
            solve_json.contains("\"fallback_used\""),
            "solve-result fixture must carry the SolveResponse wrapper",
        );
        write("solve-result.json", solve_json);

        // --- Pal-dex reference fixtures (round 2) ---
        // Detail for every species so any clicked pal renders in dev; the map is
        // keyed by internal id. Small per entry (list row + breeding notes).
        let all_ids: Vec<String> =
            GameData::get().species().map(|sp| sp.internal_name.clone()).collect();
        let mut detail_map: Map<String, SpeciesDetail> = Map::new();
        for id in &all_ids {
            detail_map.insert(id.clone(), paldex_species_detail(id.clone()).expect("detail"));
        }
        write(
            "paldex-species-detail.json",
            serde_json::to_string_pretty(&detail_map).unwrap(),
        );

        // Reverse breeding (parent pairs) for every species. `total` stays exact
        // (matches the real command); the pair list is trimmed to a display
        // prefix so the fixture stays compact — the view only shows the first N.
        const FIXTURE_PAIRS: usize = 16;
        let mut parents_map: Map<String, ParentsResult> = Map::new();
        for id in &all_ids {
            let mut res = breeding_parents(id.clone()).expect("parents");
            res.pairs.truncate(FIXTURE_PAIRS);
            parents_map.insert(id.clone(), res);
        }
        write("breeding-parents.json", serde_json::to_string(&parents_map).unwrap());

        // reverse-breeding.json — `reverse_breeding` output for every species,
        // keyed by internal id, for the BRED FROM panel. Capped to a display
        // prefix per species (deterministic dex order, unique combos sort first)
        // so the fixture stays compact — the panel renders the returned list and
        // its length. The cap (> the search threshold) keeps the search filter
        // demoable for high-pair species in `bun run dev`.
        const FIXTURE_REVERSE_PAIRS: usize = 60;
        let mut reverse_map: Map<String, Vec<ReversePair>> = Map::new();
        for id in &all_ids {
            let mut res = reverse_breeding(id.clone()).expect("reverse");
            res.truncate(FIXTURE_REVERSE_PAIRS);
            reverse_map.insert(id.clone(), res);
        }
        write("reverse-breeding.json", serde_json::to_string(&reverse_map).unwrap());

        // Forward breeding (child of a x b) for every pair with a featured
        // first parent. Covers the "breed with..." widget on the pages screenshot
        // review exercises; the dev shim falls back to null for uncovered pairs.
        // Keyed by canonical "min_id|max_id"; only resolvable pairs are stored.
        const FEATURED: &[&str] = &[
            "Anubis", "JetDragon", "IceHorse", "KingBahamut", "Bastet", "SheepBall",
            "PinkCat", "ChickenPal", "ElecPanda", "Horus", "CaptainPenguin",
            "NegativeKoala", "LazyDragon", "Deer", "Monkey", "Kitsunebi", "Ganesha",
            "Sekhmet", "FairyDragon", "BlueDragon", "Kelpie", "Plesiosaur",
            "Serpent_Ground", "CuteFox",
        ];
        let mut child_map: Map<String, SpeciesRef> = Map::new();
        for f in FEATURED {
            for t in &all_ids {
                let res = breeding_child((*f).to_string(), t.clone(), None, None)
                    .expect("child lookup");
                if let Some(child) = res.child {
                    let (lo, hi) = if *f <= t.as_str() { (*f, t.as_str()) } else { (t.as_str(), *f) };
                    child_map.entry(format!("{lo}|{hi}")).or_insert(child);
                }
            }
        }
        write("breeding-child.json", serde_json::to_string(&child_map).unwrap());
    }
}
