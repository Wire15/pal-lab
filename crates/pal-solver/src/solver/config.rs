//! Solver configuration. Defaults track palcalc's UI defaults
//! (`SerializableSolverSettings` in `PalCalc.UI/Model/AppSettings.cs`).

use serde::{Deserialize, Serialize};

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
