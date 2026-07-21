//! Frontend-facing pal-dex reference commands over the embedded [`GameData`]
//! pack, plus a per-save roster tally.
//!
//! All species/breeding data comes from `pal_data::GameData::get()` (decoded
//! once, `'static`). `roster_counts` reads a save directory via
//! `pal_save::read_save_dir` on each call — cheap relative to the solver and
//! keeps the command stateless.

use std::collections::HashMap;
use std::path::Path;

use pal_data::gamedata::{ParentGender, PalSpecies};
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

/// Base stats the pack carries for a species.
#[derive(Debug, Clone, Serialize)]
pub struct SpeciesStats {
    pub hp: u16,
    pub attack: u16,
    pub defense: u16,
    pub rarity: u8,
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
        },
        guaranteed_passives: sp
            .guaranteed_passives
            .iter()
            .map(|p| passive_ref(gd, p))
            .collect(),
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

/// Full detail: the list row plus breeding participation notes.
#[derive(Debug, Clone, Serialize)]
pub struct SpeciesDetail {
    #[serde(flatten)]
    pub species: SpeciesEntry,
    pub breeding: BreedingNotes,
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

    Ok(SpeciesDetail {
        species: species_entry(gd, sp),
        breeding: BreedingNotes { parent_pair_count, unique_combos },
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

        // save-summary.json — real summary, pals trimmed to a representative
        // ~60 covering every container kind present.
        let mut summary = crate::save::load_save(testdata_dir()).expect("load save");
        let mut per_kind: Map<String, u32> = Map::new();
        let mut kinds_seen: Map<String, ()> = Map::new();
        let mut trimmed = Vec::new();
        // pass 1: one representative per kind.
        for pal in &summary.pals {
            let k = format!("{:?}", pal.container_kind);
            if kinds_seen.insert(k.clone(), ()).is_none() {
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
        write(
            "save-summary.json",
            serde_json::to_string_pretty(&summary).unwrap(),
        );

        // solve-result.json — Anubis + Runner + PAL_Sanity_Up_1, up to 3 plans.
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
        let plans: Vec<_> = run_solver(gd, &spec, &save.pals, &cfg)
            .into_iter()
            .take(3)
            .collect();
        assert!(!plans.is_empty(), "expected solver plans for fixture");
        write(
            "solve-result.json",
            serde_json::to_string_pretty(&plans).unwrap(),
        );
    }
}
