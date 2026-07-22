//! Frontend-facing breeding-solver commands wrapping `pal_solver`.
//!
//! `solve` loads a save via `pal_save`, resolves the target species and required
//! passives through the same display-name-or-internal-id logic as the `solve`
//! CLI (`pal_solver::solver::resolve_*`), runs the CPU-bound solver off the async
//! runtime, and returns `pal_solver`'s `BreedingPlan` tree serialized to JSON.
//! `list_species` / `list_passives` feed the view's autocomplete inputs.

use std::collections::HashMap;
use std::path::Path;

use pal_data::gamedata::PassiveTier;
use pal_data::GameData;
use pal_solver::solver::{
    resolve_passive, resolve_species, solve as run_solver, BreedingPlan, SolverConfig, TargetPal,
    TargetSpec,
};
use serde::{Deserialize, Serialize};

/// Solve request from the frontend Solver view. Optional fields fall back to
/// `SolverConfig` / `TargetSpec` defaults when absent.
#[derive(Debug, Clone, Deserialize)]
pub struct SolveRequest {
    pub target_species: String,
    #[serde(default)]
    pub required_passives: Vec<String>,
    pub max_steps: Option<u32>,
    pub allow_wild: Option<bool>,
    pub max_irrelevant: Option<u8>,
}

/// An `{id, name}` pair (internal id + English display name) for autocomplete.
#[derive(Debug, Clone, Serialize)]
pub struct NamedEntry {
    pub id: String,
    pub name: String,
}

/// The command body, factored out so tests can drive it synchronously.
fn run(save_dir: &str, req: SolveRequest) -> Result<Vec<BreedingPlan>, String> {
    if save_dir.trim().is_empty() {
        return Err("No save folder selected.".into());
    }
    let gd = GameData::get();

    let target_species = resolve_species(gd, &req.target_species)
        .ok_or_else(|| format!("unknown pal: {}", req.target_species))?;
    let required_passives = req
        .required_passives
        .iter()
        .map(|n| resolve_passive(gd, n).ok_or_else(|| format!("unknown passive: {n}")))
        .collect::<Result<Vec<_>, _>>()?;

    let mut cfg = SolverConfig::default();
    if let Some(allow_wild) = req.allow_wild {
        cfg.allow_wild = allow_wild;
    }
    if let Some(n) = req.max_steps {
        cfg.max_breeding_steps = n;
        cfg.max_solver_iterations = n;
    }

    let mut spec = TargetSpec::new(TargetPal::Species(target_species));
    spec.required_passives = required_passives;
    if let Some(m) = req.max_irrelevant {
        spec.max_irrelevant = m;
    }

    let save =
        pal_save::read_save_dir(Path::new(save_dir)).map_err(|e| format!("reading save: {e}"))?;

    Ok(run_solver(gd, &spec, &save.pals, &cfg))
}

/// Solve for breeding plans toward `spec.target_species` with the required
/// passives. The solver is CPU-bound (seconds), so it runs on the blocking pool.
#[tauri::command]
pub async fn solve(save_dir: String, spec: SolveRequest) -> Result<Vec<BreedingPlan>, String> {
    tauri::async_runtime::spawn_blocking(move || run(&save_dir, spec))
        .await
        .map_err(|e| format!("solver task panicked: {e}"))?
}

/// Every species as `{id, name}`, in interned-index order, for the target input.
#[tauri::command]
pub fn list_species() -> Vec<NamedEntry> {
    GameData::get()
        .species()
        .map(|s| NamedEntry { id: s.internal_name.clone(), name: s.name.clone() })
        .collect()
}

/// A passive row for the pal-dex passive browse + the Solver's required-passive
/// multi-select. Mirrors the frozen `PassiveEntry` TS contract: identity/rank
/// stay the pack's, `effects`/`description`/`pal_facing` are extraction-sourced
/// display metadata. ALL passives are emitted (the UI filters on `pal_facing`).
#[derive(Debug, Clone, Serialize)]
pub struct PassiveEntry {
    pub id: String,
    pub name: String,
    pub rank: i8,
    pub effects: Vec<PassiveEffect>,
    pub description: Option<String>,
    pub pal_facing: bool,
    /// Special lottery-pool tier: `"rainbow"` (mutation pool) / `"worldtree"`
    /// (world-tree pool) / `null`. Additive; the UI colors the strip by it when
    /// present, else falls back to rank-based coloring.
    pub tier: Option<PassiveTier>,
}

/// One structured effect line (`{type, value, target}`) for [`PassiveEntry`].
#[derive(Debug, Clone, Serialize)]
pub struct PassiveEffect {
    #[serde(rename = "type")]
    pub effect_type: String,
    pub value: f32,
    pub target: String,
}

/// Every passive with its full display metadata; UI filters to `pal_facing`.
#[tauri::command]
pub fn list_passives() -> Vec<PassiveEntry> {
    GameData::get()
        .passives()
        .iter()
        .map(|p| PassiveEntry {
            id: p.internal_name.clone(),
            name: p.name.clone(),
            rank: p.rank,
            effects: p
                .effects
                .iter()
                .map(|e| PassiveEffect {
                    effect_type: e.effect_type.clone(),
                    value: e.value,
                    target: e.target.clone(),
                })
                .collect(),
            description: p.description.clone(),
            pal_facing: p.pal_facing,
            tier: p.tier,
        })
        .collect()
}

/// Active-skill (waza) display names keyed by the save-side waza id
/// (enum-prefix-stripped, e.g. `"Unique_SheepBall_Roll"`, `"AirCanon"`). The UI
/// resolves raw active-skill ids from a save to their localized names.
#[tauri::command]
pub fn list_active_names() -> HashMap<String, String> {
    GameData::get()
        .active_names()
        .iter()
        .map(|(id, name)| (id.clone(), name.clone()))
        .collect()
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
    fn solves_anubis_from_testdata() {
        let req = SolveRequest {
            target_species: "Anubis".into(),
            required_passives: vec!["Runner".into(), "PAL_Sanity_Up_1".into()],
            max_steps: Some(5),
            allow_wild: None,
            max_irrelevant: None,
        };
        let plans = run(&testdata_dir(), req).expect("solve should succeed");
        assert!(!plans.is_empty(), "expected >=1 plan");

        let best = &plans[0];
        assert!(best.total_steps > 0, "expected total_steps > 0, got 0");
        eprintln!(
            "solve summary: {} plan(s); best = {} steps, {:.0}s total ({} wild)",
            plans.len(),
            best.total_steps,
            best.total_time_secs,
            best.total_wild_pals
        );
    }
}
