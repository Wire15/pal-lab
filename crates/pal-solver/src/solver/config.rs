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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolverConfig {
    /// Max total breeding steps in any single plan tree (palcalc `MaxBreedingSteps`, default 10).
    pub max_breeding_steps: u32,
    /// Max solver passes / the reachability horizon (palcalc `MaxSolverIterations`, default 20).
    pub max_solver_iterations: u32,
    /// Max wild pals usable across a plan (palcalc `MaxWildPals`, default 1).
    pub max_wild_pals: u32,
    /// Max irrelevant passives kept on the reduced initial owned set
    /// (palcalc `MaxInputIrrelevantPassives`, default 3).
    pub max_input_irrelevant_passives: u8,
    /// Whether wild pals may be introduced at all (convenience gate on `max_wild_pals`).
    pub allow_wild: bool,
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
}

impl Default for SolverConfig {
    fn default() -> Self {
        SolverConfig {
            max_breeding_steps: 10,
            max_solver_iterations: 20,
            max_wild_pals: 1,
            max_input_irrelevant_passives: 3,
            allow_wild: true,
            max_effort_secs: 7.0 * 24.0 * 3600.0,
            result_limit: 3,
            cake: CakeKind::Normal,
        }
    }
}

impl SolverConfig {
    /// Effective wild-pal budget (0 when wild pals are disabled).
    #[inline]
    pub fn effective_max_wild(&self) -> u32 {
        if self.allow_wild {
            self.max_wild_pals
        } else {
            0
        }
    }
}
