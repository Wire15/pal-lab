//! Frontend-facing breeding-solver commands wrapping `pal_solver`.
//!
//! `solve` loads a save via `pal_save`, resolves the target species and required
//! passives through the same display-name-or-internal-id logic as the `solve`
//! CLI (`pal_solver::solver::resolve_*`), runs the CPU-bound solver off the async
//! runtime, and returns `pal_solver`'s `BreedingPlan` tree serialized to JSON.
//! `list_species` / `list_passives` feed the view's autocomplete inputs.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pal_data::gamedata::{BreedingBoostSource, BreedingEffect, PassiveTier};
use pal_data::types::{Guid, OwnedPal};
use pal_data::{ActiveSkill, GameData};
use pal_solver::solver::{
    resolve_passive, resolve_species, solve_queue_monitored, solve_with_catching_monitored,
    BreedingPlan, BreedingSetup, CakeKind, Catching, IvModel, ModeResult, QueueItem, SolveMonitor,
    SolvePhase, SolveProgress, SolverConfig, TargetPal, TargetSpec,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

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
    /// Owned instance ids (same serde shape as `OwnedPal.instance_id`, a
    /// 16-byte array) that MUST appear as leaves in every returned plan tree.
    /// Absent/empty => no pin constraint. See `TargetSpec::pinned_parents`.
    #[serde(default)]
    pub pinned_parents: Vec<Guid>,
    /// Opaque token correlating `solve-progress` events + `cancel_solve` to this
    /// request. Absent => no events emitted and the solve is not cancellable.
    #[serde(default)]
    pub progress_token: Option<u64>,
    /// Player scope: when set, the owned pool is restricted to pals whose
    /// `owner_player_uid` equals this uid before solving (see [`scope_owned`]).
    /// Same serde shape as `PlayerRef.uid`/`OwnedPal.owner_player_uid`: a
    /// 16-byte array. Absent => all players' pals (today's behavior).
    #[serde(default)]
    pub player_uid: Option<Guid>,
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
    /// Whether the `pinned_parents` constraint was satisfiable. `false` (with
    /// empty `plans`) only when pinning eliminated an otherwise-valid result;
    /// `true` when there are no pins or a pinned plan survived.
    pub pins_satisfied: bool,
}

/// An `{id, name}` pair (internal id + English display name) for autocomplete.
#[derive(Debug, Clone, Serialize)]
pub struct NamedEntry {
    pub id: String,
    pub name: String,
}

/// The `solve-progress` event payload (frozen snake_case contract). `queue_*`
/// fields are present only for queue solves.
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

/// Emits throttled `solve-progress` events through the app handle. Phase/step
/// boundaries (`pairs_done == 0`) always emit; intra-step chunk progress is
/// throttled to at most one event per 100ms.
struct ProgressEmitter {
    app: tauri::AppHandle,
    token: u64,
    kind: &'static str,
    start: Instant,
    last_emit: Mutex<Option<Instant>>,
}

impl ProgressEmitter {
    fn new(app: tauri::AppHandle, token: u64, kind: &'static str) -> Self {
        ProgressEmitter { app, token, kind, start: Instant::now(), last_emit: Mutex::new(None) }
    }

    fn emit(&self, queue_index: Option<u32>, queue_len: Option<u32>, p: SolveProgress) {
        let boundary = p.pairs_done == 0;
        {
            let mut last = self.last_emit.lock();
            if !boundary {
                if let Some(t) = *last {
                    if t.elapsed() < Duration::from_millis(100) {
                        return;
                    }
                }
            }
            *last = Some(Instant::now());
        }
        let ev = SolveProgressEvent {
            token: self.token,
            kind: self.kind,
            queue_index,
            queue_len,
            phase: phase_str(p.phase),
            step: p.step,
            max_steps: p.max_steps,
            pairs_done: p.pairs_done,
            pairs_total: p.pairs_total,
            working_set: p.working_set as u32,
            elapsed_ms: self.start.elapsed().as_millis() as u64,
        };
        let _ = self.app.emit("solve-progress", ev);
    }
}

/// Generation guard for the in-flight solve: the currently-registered progress
/// token and its cancel flag. `cancel_solve(token)` trips the flag only when the
/// token matches the live generation, so a stale cancel can't touch a newer or
/// already-finished solve.
#[derive(Default)]
pub struct SolveGate {
    inner: Mutex<GateInner>,
}

#[derive(Default)]
struct GateInner {
    token: Option<u64>,
    cancel: Option<Arc<AtomicBool>>,
}

impl SolveGate {
    /// Register a fresh cancel flag under `token`, replacing any prior
    /// generation; returns the flag for the solve to poll.
    fn register(&self, token: u64) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut g = self.inner.lock();
        g.token = Some(token);
        g.cancel = Some(flag.clone());
        flag
    }

    /// Trip the cancel flag iff `token` is the live generation.
    fn cancel(&self, token: u64) {
        let g = self.inner.lock();
        if g.token == Some(token) {
            if let Some(f) = &g.cancel {
                f.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Clear the registration iff `token` is still the live generation (a newer
    /// solve may have already replaced it).
    fn clear(&self, token: u64) {
        let mut g = self.inner.lock();
        if g.token == Some(token) {
            g.token = None;
            g.cancel = None;
        }
    }
}

/// Resolve a [`SolveRequest`] into the solver's `(spec, cfg, catching)` triple,
/// shared by [`solve`] and [`solve_queue`].
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
///
/// Pals with a `None` `owner_player_uid` (base-camp worker pals / guild stock —
/// e.g. 76 of the real save's 1669 pals, exactly its Base-container count) are
/// EXCLUDED under a scope: they belong to no individual player. `None` uid
/// returns the pool unchanged (all players), so the borrowed path allocates
/// nothing for the default (unscoped) request.
fn scope_owned(pals: &[OwnedPal], uid: Option<Guid>) -> Cow<'_, [OwnedPal]> {
    match uid {
        None => Cow::Borrowed(pals),
        Some(uid) => {
            Cow::Owned(pals.iter().filter(|p| p.owner_player_uid == Some(uid)).cloned().collect())
        }
    }
}

/// The command body, factored out so tests can drive it synchronously (no
/// AppHandle => no progress events, no cancellation).
#[cfg(test)]
fn run(save_dir: &str, req: SolveRequest) -> Result<SolveResponse, String> {
    run_with_progress(None, save_dir, req, None)
}

/// [`run`] with optional progress emission + cooperative cancellation. Progress
/// events fire only when both an `app` handle and `req.progress_token` are
/// present; a tripped `cancel` flag maps to `Err("cancelled")`.
fn run_with_progress(
    app: Option<tauri::AppHandle>,
    save_dir: &str,
    req: SolveRequest,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<SolveResponse, String> {
    if save_dir.trim().is_empty() {
        return Err("No save folder selected.".into());
    }
    let gd = GameData::get();
    let (spec, cfg, catching) = build_request(gd, &req)?;

    let save =
        pal_save::read_save_dir(Path::new(save_dir)).map_err(|e| format!("reading save: {e}"))?;

    let emitter = match (app, req.progress_token) {
        (Some(app), Some(token)) => Some(ProgressEmitter::new(app, token, "single")),
        _ => None,
    };
    let cb = |p: SolveProgress| {
        if let Some(e) = &emitter {
            e.emit(None, None, p);
        }
    };
    let progress: Option<&(dyn Fn(SolveProgress) + Sync)> =
        emitter.as_ref().map(|_| &cb as &(dyn Fn(SolveProgress) + Sync));
    let monitor = SolveMonitor::new(progress, cancel.as_deref());

    let pool = scope_owned(&save.pals, req.player_uid);
    match solve_with_catching_monitored(gd, &spec, &pool, &cfg, catching, monitor) {
        Ok(ModeResult { plans, fallback_used, pins_satisfied }) => {
            Ok(SolveResponse { plans, fallback_used, pins_satisfied })
        }
        Err(_) => Err("cancelled".into()),
    }
}

/// Solve for breeding plans toward `spec.target_species` with the required
/// passives. The solver is CPU-bound (seconds), so it runs on the blocking pool.
/// When `spec.progress_token` is set, `solve-progress` events are emitted and
/// the solve becomes cancellable via [`cancel_solve`].
#[tauri::command]
pub async fn solve(
    app: tauri::AppHandle,
    gate: State<'_, SolveGate>,
    save_dir: String,
    spec: SolveRequest,
) -> Result<SolveResponse, String> {
    let token = spec.progress_token;
    let cancel = token.map(|t| gate.register(t));
    let joined = tauri::async_runtime::spawn_blocking(move || {
        run_with_progress(Some(app), &save_dir, spec, cancel)
    })
    .await;
    if let Some(t) = token {
        gate.clear(t);
    }
    joined.map_err(|e| format!("solver task panicked: {e}"))?
}

/// One resolved queue item in a [`QueueResponse`]. `target_species` echoes the
/// request's target id.
#[derive(Debug, Clone, Serialize)]
pub struct QueueItemResponse {
    pub target_species: String,
    pub plans: Vec<BreedingPlan>,
    pub fallback_used: bool,
    pub pins_satisfied: bool,
}

/// Response for the [`solve_queue`] command: one entry per solved item (in
/// order; truncated at the first failure when `stop_on_failure`) plus the
/// summed best-plan effort. `combined_effort_secs` is an estimate — reused bred
/// pals cost nothing the second time (see `pal_solver::solver::queue`).
#[derive(Debug, Clone, Serialize)]
pub struct QueueResponse {
    pub items: Vec<QueueItemResponse>,
    pub combined_effort_secs: f64,
}

/// Body of [`solve_queue`], factored out for synchronous tests (no AppHandle =>
/// no progress events, no cancellation).
#[cfg(test)]
fn run_queue(
    save_dir: &str,
    requests: Vec<SolveRequest>,
    stop_on_failure: bool,
) -> Result<QueueResponse, String> {
    run_queue_with_progress(None, save_dir, requests, stop_on_failure, None)
}

/// [`run_queue`] with optional progress emission + cooperative cancellation. The
/// queue's token is the first item's `progress_token` (one token per queue run);
/// each item's progress is tagged with its 0-based `queue_index` + `queue_len`.
fn run_queue_with_progress(
    app: Option<tauri::AppHandle>,
    save_dir: &str,
    requests: Vec<SolveRequest>,
    stop_on_failure: bool,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<QueueResponse, String> {
    if save_dir.trim().is_empty() {
        return Err("No save folder selected.".into());
    }
    let gd = GameData::get();

    // Resolve every request up front (echoing target ids for the response) so a
    // bad request fails the whole queue before any solving.
    let target_ids: Vec<String> = requests.iter().map(|r| r.target_species.clone()).collect();
    let token = requests.iter().find_map(|r| r.progress_token);
    // One player scope governs the whole queue run (the frontend injects the
    // same `player_uid` into every item); take the first present, mirroring the
    // one-token-per-queue rule above.
    let scope_uid = requests.iter().find_map(|r| r.player_uid);
    let queue_len = requests.len() as u32;
    let items: Vec<QueueItem> = requests
        .iter()
        .map(|req| {
            let (spec, cfg, catching) = build_request(gd, req)?;
            Ok(QueueItem { spec, cfg, catching })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let save =
        pal_save::read_save_dir(Path::new(save_dir)).map_err(|e| format!("reading save: {e}"))?;

    let emitter = match (app, token) {
        (Some(app), Some(token)) => Some(ProgressEmitter::new(app, token, "queue")),
        _ => None,
    };
    let cb = |idx: usize, p: SolveProgress| {
        if let Some(e) = &emitter {
            e.emit(Some(idx as u32), Some(queue_len), p);
        }
    };
    let progress: Option<&(dyn Fn(usize, SolveProgress) + Sync)> =
        emitter.as_ref().map(|_| &cb as &(dyn Fn(usize, SolveProgress) + Sync));

    let pool = scope_owned(&save.pals, scope_uid);
    let result =
        match solve_queue_monitored(gd, &pool, &items, stop_on_failure, cancel.as_deref(), progress) {
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

/// Solve a queue of targets sequentially, seeding each item's owned pool with
/// the previous items' bred output (see `pal_solver::solver::queue`). CPU-bound,
/// so it runs on the blocking pool. When the first item carries a
/// `progress_token`, `solve-progress` events (kind `"queue"`) are emitted and
/// the whole queue becomes cancellable via [`cancel_solve`].
#[tauri::command]
pub async fn solve_queue(
    app: tauri::AppHandle,
    gate: State<'_, SolveGate>,
    save_dir: String,
    items: Vec<SolveRequest>,
    stop_on_failure: bool,
) -> Result<QueueResponse, String> {
    let token = items.iter().find_map(|r| r.progress_token);
    let cancel = token.map(|t| gate.register(t));
    let joined = tauri::async_runtime::spawn_blocking(move || {
        run_queue_with_progress(Some(app), &save_dir, items, stop_on_failure, cancel)
    })
    .await;
    if let Some(t) = token {
        gate.clear(t);
    }
    joined.map_err(|e| format!("solver task panicked: {e}"))?
}

/// Cancel the in-flight solve/queue whose `progress_token` matches `token`. A
/// no-op when `token` doesn't match the live generation (already finished, or a
/// newer solve replaced it). The cancelled solve resolves to `Err("cancelled")`.
#[tauri::command]
pub fn cancel_solve(token: u64, gate: State<'_, SolveGate>) {
    gate.cancel(token);
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

/// A breeding-boost row for the Solver's BREEDING SETUP panel. Mechanical mirror
/// of the pack's [`pal_data::gamedata::BreedingBoost`] with one added field:
/// `display_name`, the source resolved to a localized label — a species name for
/// partner skills (`Plesiosaur` -> `Braloha`), a passive name for passives
/// (`MutationPal_Babysitter` -> `Babysitter`, `Test_PalEgg_HatchingSpeed_Up` ->
/// `Philanthropist`), falling back to the raw id when the pack lacks the entry.
#[derive(Debug, Clone, Serialize)]
pub struct BreedingBoostEntry {
    /// Species internal name (partner skills) or passive id (passives).
    pub source: String,
    pub source_kind: BreedingBoostSource,
    pub effect: BreedingEffect,
    /// Per-rank magnitude fractions (partner: one per condensation rank 0..N-1;
    /// passive: a single flat value).
    pub values_per_rank: Vec<f32>,
    /// Localized display label resolved from the source id.
    pub display_name: String,
}

/// Every breeding/egg/incubation boost the pack carries, each with a resolved
/// display name. Mechanical mirror of [`list_passives`] over `breeding_boosts()`;
/// ALL entries are emitted, including `alpha_egg_chance` (which only raises the
/// odds a hatched Pal is an Alpha — no breeding-effort impact). The UI renders
/// those as read-only info rows rather than effort toggles.
#[tauri::command]
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
            pinned_parents: vec![],
            progress_token: None,
            player_uid: None,
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
            pinned_parents: vec![],
            progress_token: None,
            player_uid: None,
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
            pinned_parents: vec![],
            progress_token: None,
            player_uid: None,
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

    /// The queue command echoes each target id, reports `pins_satisfied`, and
    /// sums each item's best-plan effort into `combined_effort_secs`.
    #[test]
    fn queue_command_solves_and_sums() {
        let dir = testdata_dir();
        if !std::path::Path::new(&dir).is_dir() {
            eprintln!("queue_command_solves_and_sums: testdata absent, skipping");
            return;
        }
        let mk = |species: &str| SolveRequest {
            target_species: species.into(),
            required_passives: vec!["Runner".into()],
            max_steps: Some(5),
            include_wild: None,
            max_irrelevant: None,
            catching: Catching::default(),
            ivs: None,
            cake: None,
            iv_model: None,
            setup: None,
            pinned_parents: vec![],
            progress_token: None,
            player_uid: None,
        };
        let resp = run_queue(&dir, vec![mk("Anubis"), mk("Anubis")], false)
            .expect("queue solve should succeed");
        assert_eq!(resp.items.len(), 2, "both items returned");
        assert_eq!(resp.items[0].target_species, "Anubis");
        assert!(resp.items.iter().all(|i| i.pins_satisfied), "no pins -> all satisfied");
        let expected: f64 =
            resp.items.iter().map(|i| i.plans.first().map_or(0.0, |p| p.total_time_secs)).sum();
        assert!(
            (resp.combined_effort_secs - expected).abs() < 1e-6,
            "combined must sum each item's best-plan effort"
        );
    }

    /// `list_breeding_boosts` mirrors the pack and resolves display names:
    /// partner species -> localized name, passives -> their (prefix-stripped)
    /// passive name. Every entry carries a non-empty label.
    #[test]
    fn list_breeding_boosts_resolves_display_names() {
        let boosts = list_breeding_boosts();
        assert_eq!(
            boosts.len(),
            GameData::get().breeding_boosts().len(),
            "one entry per pack boost (nothing dropped)"
        );
        assert!(
            boosts.iter().all(|b| !b.display_name.is_empty()),
            "every boost resolves a non-empty display name"
        );
        let find = |source: &str| boosts.iter().find(|b| b.source == source).expect(source);
        // Partner species localize to their in-game names.
        assert_eq!(find("Plesiosaur").display_name, "Braloha");
        assert_eq!(find("ThunderFluffyBird").display_name, "Dynamoff");
        assert_eq!(find("NaughtyCat").display_name, "Grintale");
        // Passives resolve to the pack's clean names, prefix already stripped.
        assert_eq!(find("MutationPal_Babysitter").display_name, "Babysitter");
        assert_eq!(find("Test_PalEgg_HatchingSpeed_Up").display_name, "Philanthropist");
    }

    /// `scope_owned` restricts the pool to one player's pals, dropping the other
    /// players' pals AND the null-owner (guild-stock/base) pals; `None` returns
    /// the whole pool by borrow (no allocation).
    #[test]
    fn scope_owned_filters_by_player() {
        use pal_data::types::{ContainerKind, Gender, IvSet};
        let uid_a: Guid = [1u8; 16];
        let uid_b: Guid = [2u8; 16];
        let mk = |owner: Option<Guid>| OwnedPal {
            instance_id: [0u8; 16],
            character_id: "PinkCat".into(),
            is_boss: false,
            is_lucky: false,
            is_human: false,
            gender: Some(Gender::Male),
            level: 1,
            rank: 0,
            passives: vec![],
            active_skills: vec![],
            ivs: IvSet::default(),
            nickname: None,
            owner_player_uid: owner,
            container_id: None,
            slot_index: None,
            container_kind: ContainerKind::Palbox,
        };
        let pals = vec![mk(Some(uid_a)), mk(Some(uid_a)), mk(Some(uid_b)), mk(None)];

        // Unscoped: whole pool, borrowed (no clone).
        let all = scope_owned(&pals, None);
        assert_eq!(all.len(), 4);
        assert!(matches!(all, Cow::Borrowed(_)), "None uid must borrow the pool");

        // Scoped to A: only A's two pals; B and the null-owner pal are excluded.
        let scoped = scope_owned(&pals, Some(uid_a));
        assert_eq!(scoped.len(), 2);
        assert!(scoped.iter().all(|p| p.owner_player_uid == Some(uid_a)));
        assert!(matches!(scoped, Cow::Owned(_)), "Some uid must own a filtered vec");

        // A uid nobody owns => empty pool.
        assert!(scope_owned(&pals, Some([9u8; 16])).is_empty());
    }
}
