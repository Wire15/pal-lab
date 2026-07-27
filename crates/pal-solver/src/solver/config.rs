//! Solver configuration. Defaults track palcalc's UI defaults
//! (`SerializableSolverSettings` in `PalCalc.UI/Model/AppSettings.cs`).

use serde::{Deserialize, Serialize};

use crate::solver::spec::TargetSpec;

/// TalentBonusMin from `DA_BreedingItemEffectData` (Mushroom/Deluxe Veg cakes):
/// the guaranteed minimum IV bump applied to a bred egg.
pub const TALENT_BONUS_MIN: u8 = 1;
/// TalentBonusMax from `DA_BreedingItemEffectData`: the maximum IV bump.
pub const TALENT_BONUS_MAX: u8 = 5;

/// A breeding cake fed at the farm, altering inheritance for that egg.
///
/// Effects are code-verified from `DA_BreedingItemEffectData` (datamined in
/// palcalc issue #208). Only the mechanics we model are listed; DeluxeVegetable
/// also carries `MutationRateBonusPercent=2.0` which we deliberately IGNORE
/// (mutation outcome tables are not publicly reverse-engineered — DESIGN.md
/// "out of scope v1").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum CakeKind {
    /// No cake (or a plain cake): the vanilla inheritance model.
    #[default]
    Normal,
    /// Cake02 `TalentBonusMin/Max=1/5`: raises the offspring IV floor.
    Mushroom,
    /// Cake03 `BreedCount=2`: two eggs per breeding cycle, halving breeding time.
    Vegetable,
    /// Cake04: `TalentBonus 1..5` IV floor + `MutationRateBonusPercent=2.0`
    /// (mutation ignored — outcomes out of scope).
    DeluxeVegetable,
    /// Cake05 `PassiveInheritCountOverride=4`, `bInheritAllActiveSkills=true`:
    /// forces the direct-inherit roll X to 4 (all desired passives inherited,
    /// up to the pool size) — the 10% four-passive ceiling becomes 100%.
    Special,
}

impl CakeKind {
    /// Special cake forces the direct-inherit passive roll X to 4.
    #[inline]
    pub fn forces_all_passives(self) -> bool {
        matches!(self, CakeKind::Special)
    }

    /// Eggs produced per breeding cycle (Vegetable/DeluxeVegetable => 2). The
    /// per-attempt breeding time divides by this, so time-to-success halves.
    #[inline]
    pub fn egg_multiplier(self) -> f64 {
        match self {
            CakeKind::Vegetable | CakeKind::DeluxeVegetable => 2.0,
            _ => 1.0,
        }
    }

    /// Guaranteed IV floor bump applied to a bred egg (Mushroom/DeluxeVegetable).
    ///
    /// The real mechanic adds a random `[TALENT_BONUS_MIN, TALENT_BONUS_MAX]` to
    /// each inherited IV. We take the maximum (5) as the effective floor bump —
    /// an optimistic best-case reachability model — and apply it by LOWERING the
    /// spec's IV thresholds (see [`CakeKind::apply_iv_floor`]). Documented
    /// simplification: a conservative model would use `TALENT_BONUS_MIN`.
    #[inline]
    pub fn iv_floor_bonus(self) -> u8 {
        match self {
            CakeKind::Mushroom | CakeKind::DeluxeVegetable => TALENT_BONUS_MAX,
            _ => 0,
        }
    }

    /// Whether breeding with this cake consumes cakes at all (everything but
    /// [`CakeKind::Normal`]). One cake is eaten per breeding attempt.
    #[inline]
    pub fn consumes_cakes(self) -> bool {
        !matches!(self, CakeKind::Normal)
    }

    /// Apply the IV floor bump to a spec by reducing every IV threshold by
    /// [`CakeKind::iv_floor_bonus`] (saturating at 0). A threshold at or below
    /// the bonus becomes "don't care" — the egg's guaranteed floor covers it.
    pub fn apply_iv_floor(self, spec: &mut TargetSpec) {
        let b = self.iv_floor_bonus();
        if b == 0 {
            return;
        }
        spec.iv_hp = spec.iv_hp.saturating_sub(b);
        spec.iv_attack = spec.iv_attack.saturating_sub(b);
        spec.iv_defense = spec.iv_defense.saturating_sub(b);
    }

    /// The cake-effective spec IV thresholds `[hp,atk,def]` after this cake's
    /// floor bump ([`CakeKind::apply_iv_floor`]). This is the basis for each
    /// bred plan node's `iv_targets`, kept in sync with the thresholds the
    /// search itself used to decide IV relevance.
    pub fn effective_iv_thresholds(self, spec: &TargetSpec) -> [u8; 3] {
        let mut s = spec.clone();
        self.apply_iv_floor(&mut s);
        [s.iv_hp, s.iv_attack, s.iv_defense]
    }
}

impl std::str::FromStr for CakeKind {
    type Err = String;
    fn from_str(s: &str) -> Result<CakeKind, String> {
        match s.trim().to_ascii_lowercase().replace(['-', '_', ' '], "").as_str() {
            "normal" | "none" | "plain" => Ok(CakeKind::Normal),
            "mushroom" => Ok(CakeKind::Mushroom),
            "vegetable" | "veg" => Ok(CakeKind::Vegetable),
            "deluxevegetable" | "deluxeveg" | "deluxe" => Ok(CakeKind::DeluxeVegetable),
            "special" => Ok(CakeKind::Special),
            other => Err(format!("unknown cake kind: {other}")),
        }
    }
}

/// Which inheritance-count distribution the IV probability model uses.
///
/// The pack ships two candidate weight arrays for the number of IV categories
/// inherited directly: the solver's empirically-validated `talent_inherit`
/// (`[2,1,1]` -> 50/25/25%) and the game-file CDO `combi_talent_inherit_num`
/// (`[3,2,1]` -> 50/33.3/16.7%). [`Empirical`](IvModel::Empirical) keeps the
/// former (default, unchanged behavior; oracle fixtures pin it); [`Cdo`](IvModel::Cdo)
/// swaps in the game-file weights for a datamined-accuracy alternative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IvModel {
    /// Solver's empirical 50/25/25 model (pack `talent_inherit`, `[2,1,1]`).
    #[default]
    Empirical,
    /// Game-file CDO weights (`combi_talent_inherit_num`, `[3,2,1]`).
    Cdo,
}

/// Breeding-farm setup multipliers threaded into the effort model. Bonuses are
/// fractions (e.g. `0.5` = +50%). Composed pre-solve by the caller from the
/// breeding-boost pack section + world settings; the solver treats them as
/// opaque numbers. Default is the neutral, vanilla setup.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BreedingSetup {
    /// Fractional egg-production speedup at the Breeding Farm (Plesiosaur-style
    /// partner boosts). `time_per_breed = AVG_BREEDING_TIME_SECS / (1 + this)`.
    pub farm_speed_bonus: f64,
    /// Fractional reduction of egg incubation time (ThunderFluffyBird-style
    /// boosts + Babysitter passive). `incubation *= (1 - this)`.
    pub incubation_reduction: f64,
    /// Fractional bonus egg yield per cycle (NaughtyCat extra-egg chance),
    /// composed with the cake `BreedCount` egg multiplier.
    pub extra_egg_chance: f64,
    /// World-setting egg hatch time in hours (`PalEggDefaultHatchingTime`,
    /// vanilla default 72). Drives the "massive" egg incubation base
    /// (`egg_hatch_hours * 3600`), divided down by egg size.
    pub egg_hatch_hours: f64,
}

impl Default for BreedingSetup {
    fn default() -> Self {
        BreedingSetup {
            farm_speed_bonus: 0.0,
            incubation_reduction: 0.0,
            extra_egg_chance: 0.0,
            egg_hatch_hours: crate::solver::refs::DEFAULT_EGG_HATCH_HOURS,
        }
    }
}

/// Surgery-table relaxation. When set, the solver may satisfy up to
/// `max_implants` REQUIRED passives that a candidate pal is missing by implanting
/// them from the surgery table on the final pal — a terminal step that competes
/// purely on effort: each implant adds `cost_secs` (the caller's time-cost
/// estimate) to the plan's ranking effort, so a cheaper exact-breeding plan still
/// wins. `max_implants` is clamped to `0..=4` (a pal has four passive slots).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SurgeryConfig {
    pub max_implants: u8,
    pub cost_secs: f64,
}

impl SurgeryConfig {
    /// `max_implants` clamped to a pal's `0..=4` passive slots.
    #[inline]
    pub fn implants(&self) -> u8 {
        self.max_implants.min(4)
    }
}

/// Gender-reverser relaxation. When set, a pairing blocked ONLY because both
/// parents share a concrete gender may be made viable by reversing one parent's
/// gender: one parent is flagged reversed, that step's effort gains `cost_secs`
/// (the caller's time-cost estimate), and the gender resolution is deterministic
/// (no re-roll penalty). Same-species pairs the game forbids outright stay
/// forbidden.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GenderReverserConfig {
    pub cost_secs: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolverConfig {
    /// Max total breeding steps in any single plan tree (palcalc `MaxBreedingSteps`, default 10).
    pub max_breeding_steps: u32,
    /// Max solver passes / the reachability horizon (palcalc `MaxSolverIterations`, default 20).
    pub max_solver_iterations: u32,
    /// Max wild pals usable across a single plan. palcalc's UI default
    /// (`MaxWildPals`) is 1 — a conservative "owned pals + at most one catch"
    /// mode. Our "include pals I don't own" mode ([`Self::include_wild`]) needs
    /// more: a self-only-breeding legendary (Jetragon, Frostallion, …) is bred
    /// exclusively from a same-species pair, so a passive-concentrating plan
    /// must catch >= 2 of them. We default to 10 (only consulted when
    /// `include_wild` is set — owned-only mode forces the budget to 0) to permit
    /// realistic catch->breed chains while staying bounded.
    pub max_wild_pals: u32,
    /// Max irrelevant passives kept on the reduced initial owned set
    /// (palcalc `MaxInputIrrelevantPassives`, default 3).
    pub max_input_irrelevant_passives: u8,
    /// "Include pals I don't own": when true, the search is seeded with one
    /// hypothetical wild (to-be-caught) pal per wild-spawnable species, so
    /// targets with no owned breeding path (self-only legendaries) still get
    /// catch->breed plans. Default false (owned pals only). Gates
    /// [`Self::max_wild_pals`] via [`Self::effective_max_wild`].
    pub include_wild: bool,
    /// Effort ceiling in seconds; refs above this are discarded
    /// (palcalc `MaxEffort`, default 7 days).
    pub max_effort_secs: f64,
    /// Number of final plans returned (palcalc `ResultLimitPruning` maxResults = 3).
    pub result_limit: usize,
    /// Breeding cake fed at the farm (default [`CakeKind::Normal`] — no cake,
    /// vanilla inheritance). `#[serde(default)]` keeps callers that omit it
    /// (e.g. the Tauri command deserializing older requests) compatible.
    #[serde(default)]
    pub cake: CakeKind,
    /// Breeding-farm setup multipliers (farm-speed / incubation / extra-egg /
    /// world hatch time) threaded into the effort model. Default is the neutral
    /// vanilla setup ([`BreedingSetup::default`]). `#[serde(default)]` keeps
    /// older callers that omit it behaving exactly as before.
    #[serde(default)]
    pub setup: BreedingSetup,
    /// IV inherit-count distribution model (default [`IvModel::Empirical`],
    /// pinned by the oracle fixtures). `#[serde(default)]` for back-compat.
    #[serde(default)]
    pub iv_model: IvModel,
    /// Wall-clock search budget in seconds. When the step/chunk loop's elapsed
    /// time exceeds this, the search stops expanding and finalizes with the
    /// best-so-far results ([`crate::solver::ModeResult::truncated`] = true).
    /// `<= 0.0` disables the budget (unlimited). Default 120s.
    /// `#[serde(default)]` keeps older payloads that omit it deserializing.
    #[serde(default = "default_search_budget_secs")]
    pub search_budget_secs: f64,
    /// Surgery-table relaxation (terminal, result-layer). Absent = off (no
    /// implants; byte-identical to pre-surgery behavior). `#[serde(default)]`
    /// keeps older payloads deserializing.
    #[serde(default)]
    pub surgery: Option<SurgeryConfig>,
    /// Gender-reverser relaxation (pair-viability layer). Absent = off (a
    /// same-gender pairing stays unbreedable). `#[serde(default)]` keeps older
    /// payloads deserializing.
    #[serde(default)]
    pub gender_reverser: Option<GenderReverserConfig>,
}

impl Default for SolverConfig {
    fn default() -> Self {
        SolverConfig {
            max_breeding_steps: 10,
            max_solver_iterations: 20,
            max_wild_pals: 10,
            max_input_irrelevant_passives: 3,
            include_wild: false,
            max_effort_secs: 7.0 * 24.0 * 3600.0,
            result_limit: 3,
            cake: CakeKind::Normal,
            setup: BreedingSetup::default(),
            iv_model: IvModel::Empirical,
            search_budget_secs: 120.0,
            surgery: None,
            gender_reverser: None,
        }
    }
}

/// Serde default for [`SolverConfig::search_budget_secs`] (120s).
fn default_search_budget_secs() -> f64 {
    120.0
}

impl SolverConfig {
    /// Effective wild-pal budget (0 when wild pals are disabled).
    #[inline]
    pub fn effective_max_wild(&self) -> u32 {
        if self.include_wild {
            self.max_wild_pals
        } else {
            0
        }
    }
}
