//! Web mirror of `app/src-tauri/src/solver.rs`: the breeding-solver commands
//! wrapping `pal_solver`, plus the pack-reference list commands.
//!
//! The marshalling (request → `(spec, cfg, catching)`, player scope, response
//! shape) is copied faithfully from the native command bodies. The two things
//! that differ are the ambient plumbing the native build gets from Tauri:
//!
//! * **Progress** — native emits the frozen `solve-progress` event through the
//!   `AppHandle`; here a single JS callback (installed via
//!   [`set_progress_cb`]) receives the identical payload as a JSON string. The
//!   per-solve context (token / kind / queue length / clock) lives in a
//!   thread-local armed by [`begin_progress`] so the [`SolveMonitor`] callback
//!   can stay a non-capturing (`Sync`) closure. The clock is `js_sys::Date`
//!   (`std::time::Instant` panics on `wasm32-unknown-unknown`).
//! * **Cancellation** — the caller owns the token→flag map (see `lib.rs`); this
//!   module just threads the borrowed flag into the monitor.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use pal_data::gamedata::{BreedingBoostSource, BreedingEffect, PassiveTier};
use pal_data::types::{Guid, OwnedPal};
use pal_data::{ActiveSkill, GameData, LabResearch};
use pal_solver::solver::{
    diagnose_no_path, resolve_passive, resolve_species, solve_queue_monitored,
    solve_with_catching_monitored, BreedingPlan, BreedingSetup, CakeKind, Catching,
    GenderReverserConfig, IvModel, ModeResult, NoPathReason, QueueItem, SolveMonitor, SolvePhase,
    SolveProgress, SolverConfig, SurgeryConfig, TargetPal, TargetSpec,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;

// ------------------------------------------------------------------ *
// Request / response DTOs (byte-identical serde shapes to the native layer).
// ------------------------------------------------------------------ */

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
    #[serde(default)]
    pub catching: Catching,
    #[serde(default)]
    pub ivs: Option<IvThresholds>,
    #[serde(default)]
    pub cake: Option<String>,
    #[serde(default)]
    pub iv_model: Option<IvModel>,
    #[serde(default)]
    pub setup: Option<BreedingSetup>,
    #[serde(default)]
    pub pinned_parents: Vec<Guid>,
    #[serde(default)]
    pub progress_token: Option<u64>,
    #[serde(default)]
    pub player_uid: Option<Guid>,
    /// Surgery-table implants as a terminal cost option. Maps to
    /// `SolverConfig::surgery`.
    #[serde(default)]
    pub surgery: Option<SurgeryConfig>,
    /// Gender-reverser pairing relaxation. Maps to
    /// `SolverConfig::gender_reverser`.
    #[serde(default)]
    pub gender_reverser: Option<GenderReverserConfig>,
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

/// Response for the `solve` command: the plans plus whether a `BreedingOnly`
/// request fell back to catch-assisted plans (no pure owned-breeding path).
#[derive(Debug, Clone, Serialize)]
pub struct SolveResponse {
    pub plans: Vec<BreedingPlan>,
    pub fallback_used: bool,
    pub pins_satisfied: bool,
    pub diagnosis: Vec<NoPathReason>,
    pub search_truncated: bool,
}

/// An `{id, name}` pair (internal id + English display name) for autocomplete.
#[derive(Debug, Clone, Serialize)]
pub struct NamedEntry {
    pub id: String,
    pub name: String,
}

/// One resolved queue item in a [`QueueResponse`].
#[derive(Debug, Clone, Serialize)]
pub struct QueueItemResponse {
    pub target_species: String,
    pub plans: Vec<BreedingPlan>,
    pub fallback_used: bool,
    pub pins_satisfied: bool,
}

/// Response for the `solve_queue` command.
#[derive(Debug, Clone, Serialize)]
pub struct QueueResponse {
    pub items: Vec<QueueItemResponse>,
    pub combined_effort_secs: f64,
}

/// World-setting values the Solver view needs (currently just egg hatch time).
#[derive(Debug, Clone, Serialize)]
pub struct WorldOptionsResponse {
    pub egg_hatch_hours: Option<f64>,
}

/// A passive row for the pal-dex passive browse + the Solver's required-passive
/// multi-select. Mirrors the frozen `PassiveEntry` TS contract.
#[derive(Debug, Clone, Serialize)]
pub struct PassiveEntry {
    pub id: String,
    pub name: String,
    pub rank: i8,
    pub effects: Vec<PassiveEffect>,
    pub description: Option<String>,
    pub pal_facing: bool,
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

/// A breeding-boost row for the Solver's BREEDING SETUP panel.
#[derive(Debug, Clone, Serialize)]
pub struct BreedingBoostEntry {
    pub source: String,
    pub source_kind: BreedingBoostSource,
    pub effect: BreedingEffect,
    pub values_per_rank: Vec<f32>,
    pub display_name: String,
}

/// The `solve-progress` payload (frozen snake_case contract). `queue_*` fields
/// are present only for queue solves.
#[derive(Debug, Clone, Serialize)]
struct SolveProgressEvent {
    token: u64,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue_len: Option<u32>,
    phase: &'static str,
    step: u32,
    max_steps: u32,
    pairs_done: u64,
    pairs_total: u64,
    working_set: u32,
    elapsed_ms: u64,
}

fn phase_str(p: SolvePhase) -> &'static str {
    match p {
        SolvePhase::Seeding => "seeding",
        SolvePhase::Step => "step",
        SolvePhase::CatchFallback => "catch_fallback",
        SolvePhase::Finalizing => "finalizing",
    }
}

// ------------------------------------------------------------------ *
// Progress plumbing (JS callback + thread-local per-solve context).
// ------------------------------------------------------------------ */

thread_local! {
    static PROGRESS_CB: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
    static SOLVE_CTX: RefCell<SolveCtx> = const { RefCell::new(SolveCtx::new()) };
}

/// Per-solve progress context, armed by [`begin_progress`]. `enabled` gates
/// emission (mirrors native, which only emits when a `progress_token` is set);
/// `start_ms` / `last_emit_ms` are `js_sys::Date` epoch milliseconds.
struct SolveCtx {
    enabled: bool,
    token: u64,
    kind: &'static str,
    start_ms: f64,
    last_emit_ms: Option<f64>,
    queue_len: Option<u32>,
}

impl SolveCtx {
    const fn new() -> Self {
        SolveCtx {
            enabled: false,
            token: 0,
            kind: "single",
            start_ms: 0.0,
            last_emit_ms: None,
            queue_len: None,
        }
    }
}

/// Install the JS callback that receives `solve-progress` payloads (as JSON
/// strings). Idempotent; replaces any prior callback.
pub fn set_progress_cb(f: js_sys::Function) {
    PROGRESS_CB.with(|c| *c.borrow_mut() = Some(f));
}

/// Arm the progress context before a solve. `enabled == false` (no token)
/// suppresses all events, matching the native `progress_token`-gated emission.
pub fn begin_progress(enabled: bool, token: u64, kind: &'static str, queue_len: Option<u32>) {
    SOLVE_CTX.with(|c| {
        *c.borrow_mut() = SolveCtx {
            enabled,
            token,
            kind,
            start_ms: js_sys::Date::now(),
            last_emit_ms: None,
            queue_len,
        };
    });
}

/// Disarm the progress context after a solve.
pub fn end_progress() {
    SOLVE_CTX.with(|c| c.borrow_mut().enabled = false);
}

/// Throttled progress emission (matches native `ProgressEmitter`): phase/step
/// boundaries (`pairs_done == 0`) always emit; intra-step chunk progress is
/// capped at one event per 100ms. Reads the JS callback + context from
/// thread-locals so the [`SolveMonitor`] closure stays non-capturing (`Sync`).
fn emit_progress(queue_index: Option<u32>, p: SolveProgress) {
    let json = SOLVE_CTX.with(|c| {
        let mut ctx = c.borrow_mut();
        if !ctx.enabled {
            return None;
        }
        let boundary = p.pairs_done == 0;
        let now = js_sys::Date::now();
        if !boundary {
            if let Some(last) = ctx.last_emit_ms {
                if now - last < 100.0 {
                    return None;
                }
            }
        }
        ctx.last_emit_ms = Some(now);
        let ev = SolveProgressEvent {
            token: ctx.token,
            kind: ctx.kind,
            queue_index,
            queue_len: ctx.queue_len,
            phase: phase_str(p.phase),
            step: p.step,
            max_steps: p.max_steps,
            pairs_done: p.pairs_done,
            pairs_total: p.pairs_total,
            working_set: p.working_set as u32,
            elapsed_ms: (now - ctx.start_ms) as u64,
        };
        serde_json::to_string(&ev).ok()
    });
    if let Some(json) = json {
        PROGRESS_CB.with(|c| {
            if let Some(f) = c.borrow().as_ref() {
                let _ = f.call1(&JsValue::NULL, &JsValue::from_str(&json));
            }
        });
    }
}

// ------------------------------------------------------------------ *
// Request building + player scope (copied from the native layer).
// ------------------------------------------------------------------ */

/// Resolve a [`SolveRequest`] into the solver's `(spec, cfg, catching)` triple,
/// shared by [`run`] and [`run_queue`].
fn build_request(
    gd: &GameData,
    req: &SolveRequest,
) -> Result<(TargetSpec, SolverConfig, Catching), String> {
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
    cfg.surgery = req.surgery;
    cfg.gender_reverser = req.gender_reverser;

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
    spec.pinned_parents = req.pinned_parents.clone();
    Ok((spec, cfg, req.catching))
}

/// Restrict the owned pool to a single player's pals when `uid` is set.
/// Null-owner pals (base-camp workers / guild stock) are excluded under a scope.
fn scope_owned(pals: &[OwnedPal], uid: Option<Guid>) -> Cow<'_, [OwnedPal]> {
    match uid {
        None => Cow::Borrowed(pals),
        Some(uid) => {
            Cow::Owned(pals.iter().filter(|p| p.owner_player_uid == Some(uid)).cloned().collect())
        }
    }
}

// ------------------------------------------------------------------ *
// Command bodies.
// ------------------------------------------------------------------ */

/// Solve for breeding plans toward the target species. Runs synchronously in the
/// worker (the native build offloads to a blocking thread; wasm is single-
/// threaded). `cancel` is the caller-owned cooperative flag; the built-in search
/// deadline is the hard stop. A tripped flag maps to `Err("cancelled")`.
pub fn run(
    pals: &[OwnedPal],
    req: SolveRequest,
    cancel: Option<&AtomicBool>,
) -> Result<SolveResponse, String> {
    let gd = GameData::get();
    let (spec, cfg, catching) = build_request(gd, &req)?;

    let cb = |p: SolveProgress| emit_progress(None, p);
    let progress: Option<&(dyn Fn(SolveProgress) + Sync)> = Some(&cb);
    let monitor = SolveMonitor::new(progress, cancel);

    let pool = scope_owned(pals, req.player_uid);
    match solve_with_catching_monitored(gd, &spec, &pool, &cfg, catching, monitor) {
        Ok(ModeResult { plans, fallback_used, pins_satisfied, truncated }) => {
            let diagnosis = if !plans.is_empty() {
                Vec::new()
            } else if truncated {
                vec![NoPathReason::SearchBudgetExhausted { budget_secs: cfg.search_budget_secs }]
            } else {
                diagnose_no_path(gd, &spec, &pool, &cfg)
            };
            Ok(SolveResponse {
                plans,
                fallback_used,
                pins_satisfied,
                diagnosis,
                search_truncated: truncated,
            })
        }
        Err(_) => Err("cancelled".into()),
    }
}

/// Solve a queue of targets sequentially, seeding each item's owned pool with
/// the previous items' bred output. Progress events are tagged `"queue"` with
/// the item's 0-based `queue_index`.
pub fn run_queue(
    pals: &[OwnedPal],
    requests: Vec<SolveRequest>,
    stop_on_failure: bool,
    cancel: Option<&AtomicBool>,
) -> Result<QueueResponse, String> {
    let gd = GameData::get();

    let target_ids: Vec<String> = requests.iter().map(|r| r.target_species.clone()).collect();
    let scope_uid = requests.iter().find_map(|r| r.player_uid);
    let items: Vec<QueueItem> = requests
        .iter()
        .map(|req| {
            let (spec, cfg, catching) = build_request(gd, req)?;
            Ok(QueueItem { spec, cfg, catching })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let cb = |idx: usize, p: SolveProgress| emit_progress(Some(idx as u32), p);
    let progress: Option<&(dyn Fn(usize, SolveProgress) + Sync)> = Some(&cb);

    let pool = scope_owned(pals, scope_uid);
    let result =
        match solve_queue_monitored(gd, &pool, &items, stop_on_failure, cancel, progress) {
            Ok(r) => r,
            Err(_) => return Err("cancelled".into()),
        };
    let items = result
        .items
        .into_iter()
        .zip(target_ids)
        .map(|(item, target_species)| QueueItemResponse {
            target_species,
            plans: item.plans,
            fallback_used: item.fallback_used,
            pins_satisfied: item.pins_satisfied,
        })
        .collect();
    Ok(QueueResponse { items, combined_effort_secs: result.combined_effort_secs })
}

/// Breeding-relevant world settings from the cached save's `WorldOption.sav`
/// bytes (raw, still compressed). `None` (no file) → `egg_hatch_hours: null`,
/// mirroring native `get_world_options`; a present-but-corrupt file errors.
pub fn get_world_options(worldoption_raw: Option<&[u8]>) -> Result<WorldOptionsResponse, String> {
    let egg_hatch_hours = match worldoption_raw {
        None => None,
        Some(bytes) => {
            let blob = pal_save::compress::decompress_sav(bytes)
                .map_err(|e| format!("reading world options: {e}"))?;
            pal_save::worldoption::parse_world_options(&blob)
                .map_err(|e| format!("reading world options: {e}"))?
                .egg_hatch_hours
        }
    };
    Ok(WorldOptionsResponse { egg_hatch_hours })
}

/// Every species as `{id, name}`, in interned-index order, for the target input.
pub fn list_species() -> Vec<NamedEntry> {
    GameData::get()
        .species()
        .map(|s| NamedEntry { id: s.internal_name.clone(), name: s.name.clone() })
        .collect()
}

/// Every passive with its full display metadata; UI filters to `pal_facing`.
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

/// Every breeding/egg/incubation boost the pack carries, each with a resolved
/// display name.
pub fn list_breeding_boosts() -> Vec<BreedingBoostEntry> {
    let gd = GameData::get();
    gd.breeding_boosts()
        .iter()
        .map(|b| {
            let display_name = match b.source_kind {
                BreedingBoostSource::Passive => {
                    gd.passive_by_id(&b.source).map(|p| p.name.clone())
                }
                BreedingBoostSource::PartnerBase | BreedingBoostSource::PartnerParty => {
                    gd.species_by_id(&b.source).map(|s| s.name.clone())
                }
            }
            .unwrap_or_else(|| b.source.clone());
            BreedingBoostEntry {
                source: b.source.clone(),
                source_kind: b.source_kind,
                effect: b.effect,
                values_per_rank: b.values_per_rank.clone(),
                display_name,
            }
        })
        .collect()
}

/// Breeding-relevant lab-research lines for the Breeding Setup panel.
pub fn list_lab_research() -> Vec<LabResearch> {
    GameData::get().lab_research().to_vec()
}

/// Active-skill (waza) definitions keyed by the save-side waza id.
pub fn list_active_skills() -> HashMap<String, ActiveSkill> {
    GameData::get()
        .active_skills()
        .iter()
        .map(|(id, s)| (id.clone(), s.clone()))
        .collect()
}
