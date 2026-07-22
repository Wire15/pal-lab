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
use pal_data::{ActiveSkill, GameData};
use pal_solver::solver::{
    resolve_passive, resolve_species, solve_with_catching, BreedingPlan, BreedingSetup, CakeKind,
    Catching, IvModel, ModeResult, SolverConfig, TargetPal, TargetSpec,
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
    pub include_wild: Option<bool>,
    pub max_irrelevant: Option<u8>,
    /// Catch policy (only meaningful when `include_wild` is set). Defaults to
    /// `BreedingOnly` — prefer pure owned breeding, fall back to catch-assisted
    /// only when the target is unreachable owned-only.
    #[serde(default)]
    pub catching: Catching,
    /// IV floor thresholds (0-100; 0 = don't-care). Maps to `TargetSpec.iv_*`.
    /// Absent => all don't-care (today's behavior).
    #[serde(default)]
    pub ivs: Option<IvThresholds>,
    /// Breeding cake token (`"normal"`/`"mushroom"`/`"vegetable"`/
    /// `"deluxe_vegetable"`/`"special"`, case/`_`-`-`-space-insensitive). Absent
    /// => `Normal` (no cake).
    #[serde(default)]
    pub cake: Option<String>,
    /// IV inherit-count model (`"empirical"` default / `"cdo"`). Absent =>
    /// `Empirical`.
    #[serde(default)]
    pub iv_model: Option<IvModel>,
    /// Breeding-farm setup multipliers (farm-speed / incubation / extra-egg /
    /// world egg-hatch hours). Absent => neutral vanilla setup.
    #[serde(default)]
    pub setup: Option<BreedingSetup>,
}

/// IV floor thresholds from the Solver view (`ivs` on [`SolveRequest`]). Each
/// is a 0-100 minimum; `0` means "don't care". Missing keys default to 0.
#[derive(Debug, Clone, Deserialize)]
pub struct IvThresholds {
    #[serde(default)]
    pub hp: u8,
    #[serde(default)]
    pub attack: u8,
    #[serde(default)]
    pub defense: u8,
}

/// Response for the [`solve`] command: the plans plus whether a `BreedingOnly`
/// request fell back to catch-assisted plans (no pure owned-breeding path).
#[derive(Debug, Clone, Serialize)]
pub struct SolveResponse {
    pub plans: Vec<BreedingPlan>,
    pub fallback_used: bool,
}

/// An `{id, name}` pair (internal id + English display name) for autocomplete.
#[derive(Debug, Clone, Serialize)]
pub struct NamedEntry {
    pub id: String,
    pub name: String,
}

/// The command body, factored out so tests can drive it synchronously.
fn run(save_dir: &str, req: SolveRequest) -> Result<SolveResponse, String> {
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
    if let Some(include_wild) = req.include_wild {
        cfg.include_wild = include_wild;
    }
    if let Some(n) = req.max_steps {
        cfg.max_breeding_steps = n;
        cfg.max_solver_iterations = n;
    }
    if let Some(cake) = &req.cake {
        cfg.cake = cake.parse::<CakeKind>()?;
    }
    if let Some(model) = req.iv_model {
        cfg.iv_model = model;
    }
    if let Some(setup) = req.setup {
        cfg.setup = setup;
    }

    let mut spec = TargetSpec::new(TargetPal::Species(target_species));
    spec.required_passives = required_passives;
    if let Some(m) = req.max_irrelevant {
        spec.max_irrelevant = m;
    }
    if let Some(ivs) = &req.ivs {
        spec.iv_hp = ivs.hp;
        spec.iv_attack = ivs.attack;
        spec.iv_defense = ivs.defense;
    }

    let save =
        pal_save::read_save_dir(Path::new(save_dir)).map_err(|e| format!("reading save: {e}"))?;

    let ModeResult { plans, fallback_used } =
        solve_with_catching(gd, &spec, &save.pals, &cfg, req.catching);
    Ok(SolveResponse { plans, fallback_used })
}

/// Solve for breeding plans toward `spec.target_species` with the required
/// passives. The solver is CPU-bound (seconds), so it runs on the blocking pool.
#[tauri::command]
pub async fn solve(save_dir: String, spec: SolveRequest) -> Result<SolveResponse, String> {
    tauri::async_runtime::spawn_blocking(move || run(&save_dir, spec))
        .await
        .map_err(|e| format!("solver task panicked: {e}"))?
}

/// World-setting values the Solver view needs (currently just egg hatch time).
/// `egg_hatch_hours` is `null` when the save has no `WorldOption.sav` (dedicated
/// servers) or the property is absent — the UI falls back to the vanilla 72h.
#[derive(Debug, Clone, Serialize)]
pub struct WorldOptionsResponse {
    pub egg_hatch_hours: Option<f64>,
}

/// Scan `<save_dir>/WorldOption.sav` for breeding-relevant world settings.
/// Never errors on a missing file (returns `egg_hatch_hours: null`); only a
/// present-but-corrupt save surfaces an error.
#[tauri::command]
pub fn get_world_options(save_dir: String) -> Result<WorldOptionsResponse, String> {
    let opts = pal_save::read_world_options(Path::new(&save_dir))
        .map_err(|e| format!("reading world options: {e}"))?;
    Ok(WorldOptionsResponse {
        egg_hatch_hours: opts.and_then(|o| o.egg_hatch_hours),
    })
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

/// Active-skill (waza) definitions keyed by the save-side waza id
/// (enum-prefix-stripped, e.g. `"Unique_SheepBall_Roll"`, `"AirCanon"`). The UI
/// resolves raw active-skill ids from a save to their localized names + stats
/// (element/power/cooldown/description).
#[tauri::command]
pub fn list_active_skills() -> HashMap<String, ActiveSkill> {
    GameData::get()
        .active_skills()
        .iter()
        .map(|(id, s)| (id.clone(), s.clone()))
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
            include_wild: None,
            max_irrelevant: None,
            catching: Catching::default(),
            ivs: None,
            cake: None,
            iv_model: None,
            setup: None,
        };
        let resp = run(&testdata_dir(), req).expect("solve should succeed");
        assert!(!resp.plans.is_empty(), "expected >=1 plan");
        assert!(!resp.fallback_used, "owned-only never sets fallback_used");

        let best = &resp.plans[0];
        assert!(best.total_steps > 0, "expected total_steps > 0, got 0");
        eprintln!(
            "solve summary: {} plan(s); best = {} steps, {:.0}s total ({} wild)",
            resp.plans.len(),
            best.total_steps,
            best.total_time_secs,
            best.total_wild_pals
        );
    }

    /// breeding_only + include_wild for a target the testdata roster can breed
    /// from owned pals: the command must return the pure owned-breeding plans
    /// (no fallback, no wild nodes) even though wild seeding was requested.
    #[test]
    fn breeding_only_prefers_owned_over_catch() {
        use pal_solver::solver::PlanSource;
        fn has_wild(node: &pal_solver::solver::PlanNode) -> bool {
            matches!(node.source, PlanSource::Wild { .. })
                || node.children.iter().any(has_wild)
        }
        let req = SolveRequest {
            target_species: "Anubis".into(),
            required_passives: vec!["Runner".into()],
            max_steps: Some(5),
            include_wild: Some(true),
            max_irrelevant: None,
            catching: Catching::BreedingOnly,
            ivs: None,
            cake: None,
            iv_model: None,
            setup: None,
        };
        let resp = run(&testdata_dir(), req).expect("solve should succeed");
        assert!(!resp.plans.is_empty(), "expected an owned-breeding plan for Anubis");
        assert!(
            !resp.fallback_used,
            "Anubis is owned-breedable — breeding_only must not fall back to catching"
        );
        for p in &resp.plans {
            assert!(!has_wild(&p.root), "breeding_only owned-reachable plan has no wild nodes");
        }
    }

    /// ivs + cake set on the request must map through `run` (backward-compatible
    /// deserialize path) and still produce plans. Anubis IVs are unknown on the
    /// bred target, but modest thresholds with a Mushroom IV-floor cake keep it
    /// reachable — proving the fields wire into `TargetSpec`/`SolverConfig`.
    #[test]
    fn maps_ivs_and_cake_from_request() {
        let req = SolveRequest {
            target_species: "Anubis".into(),
            required_passives: vec!["Runner".into()],
            max_steps: Some(5),
            include_wild: None,
            max_irrelevant: None,
            catching: Catching::default(),
            ivs: Some(IvThresholds { hp: 3, attack: 3, defense: 0 }),
            cake: Some("mushroom".into()),
            iv_model: Some(IvModel::Empirical),
            setup: Some(BreedingSetup {
                farm_speed_bonus: 0.5,
                incubation_reduction: 0.2,
                extra_egg_chance: 0.0,
                egg_hatch_hours: 24.0,
            }),
        };
        let resp = run(&testdata_dir(), req).expect("solve with ivs+cake should succeed");
        assert!(!resp.plans.is_empty(), "expected a plan with modest IVs + mushroom cake");
        eprintln!(
            "ivs+cake solve: {} plan(s); best {} steps, {:.0}s",
            resp.plans.len(),
            resp.plans[0].total_steps,
            resp.plans[0].total_time_secs
        );
    }

    /// `get_world_options` reads the real WorldOption.sav fixture (scanned egg
    /// hatch time) and returns `null` for a save without one.
    #[test]
    fn get_world_options_reads_and_defaults() {
        let wo_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/worldoption");
        if wo_dir.join("WorldOption.sav").is_file() {
            let resp = get_world_options(wo_dir.to_string_lossy().into_owned())
                .expect("world options parse");
            let hours = resp.egg_hatch_hours.expect("fixture carries egg hatch hours");
            assert!(hours > 0.0 && hours <= 240.0, "plausible hours: {hours}");
            eprintln!("get_world_options scanned egg_hatch_hours = {hours}");
        }
        // A save dir with no WorldOption.sav => null (never an error).
        let none = get_world_options(testdata_dir()).expect("missing file is not an error");
        assert!(none.egg_hatch_hours.is_none());
    }
}
