//! Web mirror of `app/src-tauri/src/paldex.rs`: pal-dex reference commands over
//! the embedded [`GameData`] pack, plus a per-save roster tally.
//!
//! Every command except [`roster_counts`] is pure over `GameData::get()` and
//! ports verbatim (only the `#[tauri::command]` attribute is dropped). The
//! `roster_counts` command reads a save directory on each native call; the web
//! build has no directory, so it tallies the save cached by `load_save_bundle`.

use std::collections::{HashMap, HashSet};

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
    /// P(male) as a percent (0-100).
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
/// `species`. Thin serde adapter over [`GameData::reverse_breeding`].
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

/// Per-species owned counts + best IVs from the cached save (web mirror of the
/// native `roster_counts`, which re-reads the save directory each call).
pub fn roster_counts(save: &pal_save::SaveData) -> HashMap<String, RosterCount> {
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
    counts
}

/// One dex row annotated with breed-reachability from an owned species set.
#[derive(Debug, Clone, Serialize)]
pub struct DexReachEntry {
    pub internal_name: String,
    pub owned: bool,
    pub steps: Option<u16>,
    pub witness: Option<(String, String)>,
}

/// Breed-reachability for every dex species from an owned species set.
#[derive(Debug, Clone, Serialize)]
pub struct DexReach {
    pub species: Vec<DexReachEntry>,
}

/// Child species of an unordered pair under *any* gender assignment.
fn child_any_gender(gd: &GameData, a: u16, b: u16) -> Option<u16> {
    for &ga in &[Gender::Male, Gender::Female] {
        for &gb in &[Gender::Male, Gender::Female] {
            if let Some(c) = gd.child_of(a, ga, b, gb) {
                return Some(c);
            }
        }
    }
    None
}

/// Species-level breeding BFS. Seed species are generation 0; each generation
/// forms every not-yet-tried unordered pair (self-pairs included) of species
/// reachable so far and records first-discovered children at generation+1.
fn breed_reachability(gd: &GameData, seed: &[u16]) -> (Vec<Option<u16>>, Vec<Option<(u16, u16)>>) {
    let n = gd.species_count();
    let mut steps: Vec<Option<u16>> = vec![None; n];
    let mut witness: Vec<Option<(u16, u16)>> = vec![None; n];
    let mut reachable: Vec<u16> = Vec::new();
    for &s in seed {
        if (s as usize) < n && steps[s as usize].is_none() {
            steps[s as usize] = Some(0);
            reachable.push(s);
        }
    }
    let mut tried: HashSet<(u16, u16)> = HashSet::new();
    let mut gen: u16 = 0;
    loop {
        let len = reachable.len();
        let mut discovered: Vec<(u16, (u16, u16))> = Vec::new();
        for i in 0..len {
            for j in i..len {
                let a = reachable[i];
                let b = reachable[j];
                let key = (a.min(b), a.max(b));
                if !tried.insert(key) {
                    continue;
                }
                if let Some(c) = child_any_gender(gd, key.0, key.1) {
                    if steps[c as usize].is_none() {
                        discovered.push((c, key));
                    }
                }
            }
        }
        if discovered.is_empty() {
            break;
        }
        gen += 1;
        for (c, pair) in discovered {
            if steps[c as usize].is_none() {
                steps[c as usize] = Some(gen);
                witness[c as usize] = Some(pair);
                reachable.push(c);
            }
        }
    }
    (steps, witness)
}

/// Breed-reachability for the whole dex from an owned species set. Unknown
/// `owned_species` names are silently skipped; the rest seed a species-level
/// breeding BFS. Returns one [`DexReachEntry`] per species in interned-index
/// order (matching [`paldex_species`]).
pub fn dex_reachability(owned_species: Vec<String>) -> Result<DexReach, String> {
    let gd = GameData::get();
    let seed: Vec<u16> = owned_species
        .iter()
        .filter_map(|name| gd.species_index(name))
        .collect();
    let (steps, witness) = breed_reachability(gd, &seed);
    let name = |i: u16| gd.species_at(i).map(|s| s.internal_name.clone()).unwrap_or_default();
    let species: Vec<DexReachEntry> = (0..gd.species_count() as u16)
        .filter_map(|i| {
            gd.species_at(i).map(|sp| DexReachEntry {
                internal_name: sp.internal_name.clone(),
                owned: steps[i as usize] == Some(0),
                steps: steps[i as usize],
                witness: witness[i as usize].map(|(a, b)| (name(a), name(b))),
            })
        })
        .collect();
    Ok(DexReach { species })
}
