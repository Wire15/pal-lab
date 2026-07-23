//! Multi-target breeding queue (Wave A).
//!
//! `solve_queue` runs a list of targets **sequentially, left to right**, each a
//! full [`solve_modes`] call. The key twist: after an item resolves, the BRED
//! pals of its best plan (`plans[0]`) — the target itself plus every
//! intermediate bred child — are materialized as synthetic owned pals and
//! appended to the working pool the *next* item breeds from, simulating "you
//! already bred those". This lets a later target reuse an earlier target's
//! output for free (zero acquisition effort) instead of re-deriving it.
//!
//! Estimates, not guarantees: the synthetic pals carry only the passives the
//! plan bred *for* (random slots are dropped, i.e. an optimistically clean
//! parent) and their IVs are the plan's guaranteed floor. `combined_effort_secs`
//! is the sum of each processed item's `plans[0].total_time_secs` (0 for a
//! no-plan item) — a lower-bound rollup of the whole queue's effort, since
//! reused bred pals cost nothing the second time. Treat it as a planning
//! estimate, never an exact schedule.
//!
//! Synthetic instance ids live in a reserved `b"QUEUED"`-prefixed namespace with
//! a monotonic counter, so they never collide with each other; they exist only
//! for the duration of the queue solve and are never persisted.

use pal_data::types::{ContainerKind, Gender, IvSet, OwnedPal, PassiveId};
use pal_data::GameData;

use crate::solver::config::SolverConfig;
use std::sync::atomic::AtomicBool;

use crate::solver::engine::solve_modes_monitored;
use crate::solver::progress::{SolveCancelled, SolveMonitor, SolveProgress};
use crate::solver::refs::{PalRef, SolverIv};
use crate::solver::results::BreedingPlan;
use crate::solver::spec::{TargetPal, TargetSpec};
use crate::solver::Catching;

/// One queued target: its spec (may carry `pinned_parents`), config, and catch
/// policy. Solved in order; earlier items' bred output seeds later items.
#[derive(Debug, Clone)]
pub struct QueueItem {
    pub spec: TargetSpec,
    pub cfg: SolverConfig,
    pub catching: Catching,
}

/// The outcome of solving one queue item.
#[derive(Debug, Clone)]
pub struct QueueItemResult {
    /// The item's target (echo of `spec.pal`).
    pub target: TargetPal,
    pub plans: Vec<BreedingPlan>,
    pub fallback_used: bool,
    pub pins_satisfied: bool,
}

/// The whole-queue result.
#[derive(Debug, Clone)]
pub struct QueueResult {
    pub items: Vec<QueueItemResult>,
    /// Sum of each processed item's `plans[0].total_time_secs` (0 for no-plan
    /// items). A lower-bound estimate — reused bred pals cost nothing again.
    pub combined_effort_secs: f64,
}

/// Solve a queue of targets sequentially, seeding each item's owned pool with
/// the previous items' bred output. When `stop_on_failure` is set, the first
/// item that yields no plan (unreachable or pins unsatisfiable) is included in
/// the results and processing stops; otherwise every item is attempted.
pub fn solve_queue(
    gd: &GameData,
    owned: &[OwnedPal],
    items: &[QueueItem],
    stop_on_failure: bool,
) -> QueueResult {
    solve_queue_monitored(gd, owned, items, stop_on_failure, None, None)
        .expect("noop monitor never cancels")
}

/// [`solve_queue`] threaded with progress + cancellation. `cancel` is a
/// queue-wide flag (polled inside each item's search); `progress` receives each
/// item's [`SolveProgress`] tagged with its 0-based `queue_index` (the queue
/// itself adds nothing else — `queue_len`/`kind`/`elapsed` are the Tauri
/// layer's job). Returns `Err(SolveCancelled)` if cancellation tripped.
pub fn solve_queue_monitored(
    gd: &GameData,
    owned: &[OwnedPal],
    items: &[QueueItem],
    stop_on_failure: bool,
    cancel: Option<&AtomicBool>,
    progress: Option<&(dyn Fn(usize, SolveProgress) + Sync)>,
) -> Result<QueueResult, SolveCancelled> {
    let mut pool: Vec<OwnedPal> = owned.to_vec();
    let mut counter: u32 = 0;
    let mut out: Vec<QueueItemResult> = Vec::with_capacity(items.len());
    let mut combined_effort_secs = 0.0f64;

    for (idx, item) in items.iter().enumerate() {
        // Per-item monitor: tag every snapshot with this item's queue index for
        // the outer callback, sharing the queue-wide cancel flag.
        let item_cb = progress.map(|outer| move |p: SolveProgress| outer(idx, p));
        let monitor = SolveMonitor::new(
            item_cb.as_ref().map(|f| f as &(dyn Fn(SolveProgress) + Sync)),
            cancel,
        );

        let (refs, fallback_used, pins_satisfied) =
            solve_modes_monitored(gd, &item.spec, &pool, &item.cfg, item.catching, monitor)?;
        let iv_thresholds = item.cfg.cake.effective_iv_thresholds(&item.spec);
        let plans: Vec<BreedingPlan> = refs
            .iter()
            .map(|r| BreedingPlan::from_ref(gd, r, item.cfg.cake, iv_thresholds))
            .collect();

        let failed = plans.is_empty();
        if let (Some(best_ref), Some(best_plan)) = (refs.first(), plans.first()) {
            combined_effort_secs += best_plan.total_time_secs;
            // Materialize the best plan's bred pals into the pool for the next
            // item ("you bred these already", zero further effort).
            let mut bred: Vec<&PalRef> = Vec::new();
            collect_bred(best_ref, &mut bred);
            for r in bred {
                for pal in synth_owned(gd, r, &mut counter) {
                    pool.push(pal);
                }
            }
        }

        out.push(QueueItemResult { target: item.spec.pal, plans, fallback_used, pins_satisfied });

        if failed && stop_on_failure {
            break;
        }
    }

    Ok(QueueResult { items: out, combined_effort_secs })
}

/// Collect every bred node in a reference tree (the root if bred, plus every
/// bred ancestor along both parent chains). Owned/wild leaves are skipped.
fn collect_bred<'a>(r: &'a PalRef, out: &mut Vec<&'a PalRef>) {
    if let PalRef::Bred(b) = r {
        out.push(r);
        collect_bred(&b.parent1, out);
        collect_bred(&b.parent2, out);
    }
}

/// Materialize a bred reference as one synthetic owned pal per concrete gender
/// (two when the bred node's gender is unresolved, so the next item can use it
/// as either parent). Carries the desired passives it was bred for and the
/// plan's guaranteed IV floor.
fn synth_owned(gd: &GameData, r: &PalRef, counter: &mut u32) -> Vec<OwnedPal> {
    let species = r.species();
    let character_id =
        gd.species_at(species).map(|s| s.internal_name.clone()).unwrap_or_default();
    let ivs = r.ivs();
    let floor = |v: SolverIv| if v.random { 0 } else { v.min };
    let iv_set = IvSet { hp: floor(ivs.hp), attack: floor(ivs.attack), defense: floor(ivs.defense) };
    let passives: Vec<PassiveId> =
        r.effective_passives().iter().filter_map(|p| p.desired().cloned()).collect();

    let genders = match r.gender().concrete() {
        Some(g) => vec![g],
        None => vec![Gender::Male, Gender::Female],
    };

    genders
        .into_iter()
        .map(|gender| {
            let mut instance_id = [0u8; 16];
            instance_id[..6].copy_from_slice(b"QUEUED");
            instance_id[12..].copy_from_slice(&counter.to_le_bytes());
            *counter += 1;
            OwnedPal {
                instance_id,
                character_id: character_id.clone(),
                is_boss: false,
                is_lucky: false,
                is_human: false,
                gender: Some(gender),
                level: 1,
                rank: 0,
                passives: passives.clone(),
                active_skills: Vec::new(),
                ivs: iv_set,
                nickname: None,
                owner_player_uid: None,
                container_id: None,
                slot_index: None,
                container_kind: ContainerKind::Palbox,
            }
        })
        .collect()
}
