//! Game-data model + binary-pack loader.
//!
//! The shipping build never parses JSON. `build-pack` (see `src/bin/build-pack.rs`)
//! converts palcalc's vendored `db.json` + `breeding.json` into a single compact
//! bincode file (`pack/paldata.pack`), which is embedded via `include_bytes!` and
//! decoded exactly once on first access.
//!
//! Species are interned to a `u16` index (their order in `db.json`'s `Pals` array).
//! The breeding table and min-steps matrix reference species by that index so the
//! pack and the resident structures stay small.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::types::Gender;

/// One of the 9 canonical Palworld element kinds, matching `db.json`'s
/// top-level `Elements` table order (`Normal`, `Fire`, `Water`, `Leaf`,
/// `Electricity`, `Ice`, `Earth`, `Dark`, `Dragon`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ElementKind {
    Normal,
    Fire,
    Water,
    Leaf,
    Electricity,
    Ice,
    Earth,
    Dark,
    Dragon,
}

/// Canonical element-kind names, indexed by [`ElementKind`] discriminant order.
pub const ELEMENT_KINDS: [&str; 9] = [
    "Normal",
    "Fire",
    "Water",
    "Leaf",
    "Electricity",
    "Ice",
    "Earth",
    "Dark",
    "Dragon",
];

impl ElementKind {
    /// Every kind in canonical [`ELEMENT_KINDS`] order.
    pub const ALL: [ElementKind; 9] = [
        ElementKind::Normal,
        ElementKind::Fire,
        ElementKind::Water,
        ElementKind::Leaf,
        ElementKind::Electricity,
        ElementKind::Ice,
        ElementKind::Earth,
        ElementKind::Dark,
        ElementKind::Dragon,
    ];

    /// Canonical display/id string (e.g. `"Leaf"`, `"Earth"`).
    #[inline]
    pub fn as_str(self) -> &'static str {
        ELEMENT_KINDS[self as usize]
    }

    /// Parse a canonical element name; `None` for anything outside the 9 kinds.
    pub fn parse(s: &str) -> Option<ElementKind> {
        ELEMENT_KINDS.iter().position(|k| *k == s).map(|i| Self::ALL[i])
    }
}

/// One pal species. `internal_name` is the save-file `CharacterID` key
/// (e.g. `"Anubis"`, `"BadCatgirl"`); `name` is the English display name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PalSpecies {
    /// `CharacterID` key used by saves and the breeding table.
    pub internal_name: String,
    /// English display name.
    pub name: String,
    pub paldex_no: u16,
    pub is_variant: bool,
    /// palcalc's `BreedingPower` — the "CombiRank" used by the child-species
    /// formula `floor((rankA + rankB + 1) / 2)`.
    pub breeding_power: u16,
    /// Tie-breaker priority for equal combi ranks (palcalc `BreedingPowerPriority`).
    pub breeding_power_priority: u32,
    /// P(male offspring) for this species. `female = 1 - male_probability`.
    pub male_probability: f32,
    pub rarity: u8,
    pub hp: u16,
    pub attack: u16,
    pub defense: u16,
    /// Passive internal ids every instance of this species is guaranteed to roll
    /// (e.g. Anubis -> `ElementBoost_Earth_2_PAL`).
    pub guaranteed_passives: Vec<String>,
    /// Work-suitability levels indexed by [`WORK_KINDS`] canonical order.
    /// Stored compact (12 bytes); use [`PalSpecies::work_level`] /
    /// [`PalSpecies::work_suitabilities`] to read by kind name.
    pub work_suitability: [u8; 12],
    /// Partner-skill display name (e.g. Lamball -> `Fluffy Shield`), sourced
    /// from `vendor/partner-skills.json`. `None` for the ~130 species (mostly
    /// DLC) with no permissive partner-skill source.
    pub partner_skill: Option<String>,
    /// Partner-skill effect description, paired with [`Self::partner_skill`];
    /// `None` when the name is `None` or the source carried no text.
    pub partner_skill_desc: Option<String>,
    /// Active only at night (`Nocturnal`).
    pub nocturnal: bool,
    /// Food-meter cost per feeding (`FoodAmount`, ~1..=10).
    pub food_amount: u8,
    /// `(MinWildLevel, MaxWildLevel)` — the wild spawn level range.
    pub wild_levels: (u8, u8),
    /// Element type(s): 1–2 of the 9 canonical [`ElementKind`]s, in the game's
    /// `ElementType1`/`ElementType2` (primary-then-secondary) order. Sourced
    /// from `vendor/elements.json`; every shipped species carries at least one.
    pub elements: Vec<ElementKind>,
}

/// Canonical order of the 12 work-suitability kinds, matching `db.json`'s
/// `WorkSuitability` object-key order. [`PalSpecies::work_suitability`] is a
/// `[u8; 12]` indexed by this array; `work[i]` is the level for `WORK_KINDS[i]`.
pub const WORK_KINDS: [&str; 12] = [
    "Kindling",
    "Watering",
    "Planting",
    "GenerateElectricity",
    "Handiwork",
    "Gathering",
    "Lumbering",
    "Mining",
    "MedicineProduction",
    "Cooling",
    "Transporting",
    "Farming",
];

impl PalSpecies {
    /// Work-suitability level for a named kind, or `None` when `kind` is not one
    /// of the 12 canonical [`WORK_KINDS`].
    #[inline]
    pub fn work_level(&self, kind: &str) -> Option<u8> {
        WORK_KINDS
            .iter()
            .position(|k| *k == kind)
            .map(|i| self.work_suitability[i])
    }

    /// Iterate `(kind, level)` in canonical order (includes zero levels).
    pub fn work_suitabilities(&self) -> impl Iterator<Item = (&'static str, u8)> + '_ {
        WORK_KINDS
            .iter()
            .copied()
            .zip(self.work_suitability.iter().copied())
    }
}

/// A passive skill definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PassiveSkill {
    pub internal_name: String,
    /// English display name.
    pub name: String,
    /// Rank / tier (negative = detrimental, per palcalc's data).
    pub rank: i8,
    /// A "standard" random-inheritable passive (excludes test/special entries).
    pub is_standard: bool,
}

/// Parent-gender constraint on a breeding entry. Most entries are `Any`
/// (gender-independent); a handful of 1.0 unique combos pin both genders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParentGender {
    Any,
    Male,
    Female,
}

impl ParentGender {
    #[inline]
    fn matches(self, g: Gender) -> bool {
        match self {
            ParentGender::Any => true,
            ParentGender::Male => g == Gender::Male,
            ParentGender::Female => g == Gender::Female,
        }
    }
}

/// A single row of the breeding table, with species interned to indices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreedingEntry {
    pub parent1: u16,
    pub parent1_gender: ParentGender,
    pub parent2: u16,
    pub parent2_gender: ParentGender,
    pub child: u16,
}

/// Inheritance roll weight arrays — solver INPUTS, not fixed constants.
///
/// Defaults mirror the game's shipped `[4,3,2,1]` weights (40/30/20/10% for
/// 1/2/3/4 inherited) documented in `DESIGN.md`. These are intended to be
/// **overridable by a future game-file extractor**: once the GameSetting CDO
/// weight arrays are dumped they should replace these baked defaults rather
/// than being hardcoded at call sites.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InheritanceWeights {
    /// `Combi_PassiveInheritNum`: weights for # passives inherited (1..=4).
    pub passive_inherit: Vec<f32>,
    /// `Combi_PassiveRandomAddNum`: weights for # random extra passives.
    pub passive_random_add: Vec<f32>,
    /// `Combi_TalentInheritNum`: weights for # IVs inherited (weakest-verified;
    /// see DESIGN.md — palcalc's 50/25/25 model vs the wiki's per-stat model).
    pub talent_inherit: Vec<f32>,
}

impl Default for InheritanceWeights {
    fn default() -> Self {
        // Passives: [4,3,2,1] -> 40/30/20/10%. Kept as raw weights so an
        // extractor can drop in the true CDO arrays without changing the
        // normalization logic.
        //
        // Talents (IVs): [2,1,1] -> 50/25/25% for 1/2/3 IVs inherited. This
        // matches palcalc's manually-sampled `IVProbabilityDirect` table
        // ({1:0.5, 2:0.25, 3:0.25}); the game's `Combi_TalentInheritNum` CDO
        // ships [3,2,1] but palcalc's reverse-engineered model (and our oracle
        // fixtures) use the [2,1,1]-equivalent distribution. See DESIGN.md
        // "Mechanics ground truth" (weakest-verified parameter).
        InheritanceWeights {
            passive_inherit: vec![4.0, 3.0, 2.0, 1.0],
            passive_random_add: vec![4.0, 3.0, 2.0, 1.0],
            talent_inherit: vec![2.0, 1.0, 1.0],
        }
    }
}

/// The full serialized pack. This is exactly what `bincode` reads/writes; every
/// field is a `Vec` (deterministic order) — no `HashMap`s cross the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pack {
    /// palcalc data version (e.g. `"v26"`).
    pub version: String,
    /// Species in `db.json` order; index is the interned species id.
    pub species: Vec<PalSpecies>,
    pub passives: Vec<PassiveSkill>,
    pub breeding: Vec<BreedingEntry>,
    /// Directional min-breeding-steps, row-major `from * n + to`. `UNREACHABLE`
    /// marks pairs with no known path (palcalc's `10000` sentinel is preserved).
    pub min_steps: Vec<u16>,
    pub inheritance: InheritanceWeights,
}

/// Sentinel used by palcalc's min-steps matrix for "no path".
pub const UNREACHABLE: u16 = 10000;

/// Decoded, index-augmented game data. Cheap to access via [`GameData::get`].
#[derive(Debug)]
pub struct GameData {
    pack: Pack,
    n: usize,
    /// `internal_name` -> species index (exact).
    by_id: HashMap<String, u16>,
    /// lowercased `internal_name` -> species index. Fallback for save
    /// `CharacterID`s whose casing differs from palcalc's db.json (e.g. the
    /// save's `GhostAnglerFish` vs the pack's `GhostAnglerfish`).
    by_id_ci: HashMap<String, u16>,
    /// canonical `(min_idx, max_idx)` -> indices into `pack.breeding`.
    breed_index: HashMap<(u16, u16), Vec<u32>>,
    /// child idx -> distinct canonical `(parent_a, parent_b)` pairs that breed
    /// into it (reverse of the breeding table). Built eagerly alongside
    /// `breed_index` — dedup keeps it far smaller than the 44851 raw rows.
    parents_index: HashMap<u16, Vec<(u16, u16)>>,
}

/// Errors decoding the embedded / on-disk pack.
#[derive(Debug, thiserror::Error)]
pub enum PackError {
    #[error("failed to decode pack: {0}")]
    Decode(#[from] bincode::Error),
}

static PACK_BYTES: &[u8] = include_bytes!("../pack/paldata.pack");

static GAME_DATA: LazyLock<GameData> =
    LazyLock::new(|| GameData::decode(PACK_BYTES).expect("embedded pal-data pack is valid"));

impl GameData {
    /// The embedded game data, decoded exactly once (single bincode pass).
    pub fn get() -> &'static GameData {
        &GAME_DATA
    }

    /// Raw embedded pack bytes (for tooling / load-time benchmarks).
    pub fn embedded_bytes() -> &'static [u8] {
        PACK_BYTES
    }

    /// Decode a pack from raw bincode bytes and build lookup indices.
    pub fn decode(bytes: &[u8]) -> Result<GameData, PackError> {
        let pack: Pack = bincode::deserialize(bytes)?;
        Ok(GameData::from_pack(pack))
    }

    /// Build the augmented view (id map + breeding index) around a pack.
    pub fn from_pack(pack: Pack) -> GameData {
        let n = pack.species.len();
        let mut by_id = HashMap::with_capacity(n);
        let mut by_id_ci = HashMap::with_capacity(n);
        for (i, sp) in pack.species.iter().enumerate() {
            by_id.insert(sp.internal_name.clone(), i as u16);
            // First writer wins on case-collision; exact `by_id` still shadows.
            by_id_ci
                .entry(sp.internal_name.to_ascii_lowercase())
                .or_insert(i as u16);
        }
        let mut breed_index: HashMap<(u16, u16), Vec<u32>> = HashMap::new();
        let mut parents_index: HashMap<u16, Vec<(u16, u16)>> = HashMap::new();
        for (i, e) in pack.breeding.iter().enumerate() {
            let pair = (e.parent1.min(e.parent2), e.parent1.max(e.parent2));
            breed_index.entry(pair).or_default().push(i as u32);
            let parents = parents_index.entry(e.child).or_default();
            if !parents.contains(&pair) {
                parents.push(pair);
            }
        }
        GameData {
            pack,
            n,
            by_id,
            by_id_ci,
            breed_index,
            parents_index,
        }
    }

    /// palcalc data version string.
    pub fn version(&self) -> &str {
        &self.pack.version
    }

    /// Number of species.
    pub fn species_count(&self) -> usize {
        self.n
    }

    /// Iterate every species in interned-index order.
    pub fn species(&self) -> impl Iterator<Item = &PalSpecies> {
        self.pack.species.iter()
    }

    /// Interned index for a `CharacterID` / internal name. Falls back to a
    /// case-insensitive match so save `CharacterID`s whose casing differs from
    /// palcalc's db.json (e.g. `GhostAnglerFish` vs `GhostAnglerfish`) resolve.
    pub fn species_index(&self, internal_name: &str) -> Option<u16> {
        self.by_id
            .get(internal_name)
            .copied()
            .or_else(|| self.by_id_ci.get(&internal_name.to_ascii_lowercase()).copied())
    }

    /// Look up a species by its `CharacterID` / internal name.
    pub fn species_by_id(&self, internal_name: &str) -> Option<&PalSpecies> {
        self.species_index(internal_name)
            .map(|i| &self.pack.species[i as usize])
    }

    /// Look up a species by interned index.
    pub fn species_at(&self, idx: u16) -> Option<&PalSpecies> {
        self.pack.species.get(idx as usize)
    }

    /// All passive-skill definitions.
    pub fn passives(&self) -> &[PassiveSkill] {
        &self.pack.passives
    }

    /// The full breeding table (species interned to indices).
    pub fn breeding(&self) -> &[BreedingEntry] {
        &self.pack.breeding
    }

    /// Passive-skill definition by its internal id (e.g. `"Runner"`).
    pub fn passive_by_id(&self, internal_name: &str) -> Option<&PassiveSkill> {
        self.pack
            .passives
            .iter()
            .find(|p| p.internal_name == internal_name)
    }

    /// Distinct canonical `(parent_a, parent_b)` index pairs that breed into
    /// `child` (reverse breeding lookup). Empty slice for unreachable children.
    pub fn parents_of(&self, child: u16) -> &[(u16, u16)] {
        self.parents_index
            .get(&child)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Solver inheritance weight arrays.
    pub fn inheritance(&self) -> &InheritanceWeights {
        &self.pack.inheritance
    }

    /// Resolve the child species of breeding two parents of given genders.
    ///
    /// Faithful to palcalc: a canonical (unordered) pair usually has a single
    /// gender-independent result; the 1.0 unique combos (CatMage x FoxMage) are
    /// resolved by matching both parent genders in either orientation.
    pub fn child_of(&self, a: u16, gender_a: Gender, b: u16, gender_b: Gender) -> Option<u16> {
        let key = (a.min(b), a.max(b));
        let entries = self.breed_index.get(&key)?;
        for &ei in entries {
            let e = &self.pack.breeding[ei as usize];
            let fwd = e.parent1 == a
                && e.parent2 == b
                && e.parent1_gender.matches(gender_a)
                && e.parent2_gender.matches(gender_b);
            let rev = e.parent1 == b
                && e.parent2 == a
                && e.parent1_gender.matches(gender_b)
                && e.parent2_gender.matches(gender_a);
            if fwd || rev {
                return Some(e.child);
            }
        }
        None
    }

    /// Minimum breeding steps to reach `target` starting from `from`.
    /// Directional (palcalc's matrix is not symmetric). Returns [`UNREACHABLE`]
    /// when no path is recorded, `0` for `from == target`.
    pub fn min_steps(&self, from: u16, target: u16) -> u16 {
        let (from, target) = (from as usize, target as usize);
        if from >= self.n || target >= self.n {
            return UNREACHABLE;
        }
        self.pack.min_steps[from * self.n + target]
    }

    /// `(P(male), P(female))` offspring probability for a species by index.
    pub fn gender_probability(&self, idx: u16) -> Option<(f32, f32)> {
        self.species_at(idx)
            .map(|s| (s.male_probability, 1.0 - s.male_probability))
    }
}
