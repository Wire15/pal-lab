//! Progress reporting + cooperative cancellation for the breeding search.
//!
//! The engine is CPU-bound and can run for many seconds on a large roster with
//! several required passives. [`SolveMonitor`] threads two orthogonal concerns
//! through the search without touching its algorithm:
//!
//! * an optional progress callback that receives coarse-grained [`SolveProgress`]
//!   snapshots (phase transitions and intra-step batch progress), and
//! * an optional cooperative cancel flag polled at chunk and step boundaries.
//!
//! Everything here is presentation/plumbing: `elapsed`, `token`, and the
//! `single`/`queue` `kind` are the Tauri layer's job (see
//! `app/src-tauri/src/solver.rs`). The engine only knows phase/step/pair/working-set
//! counts, which is all [`SolveProgress`] carries.

use std::sync::atomic::{AtomicBool, Ordering};

/// Which stage of the search a [`SolveProgress`] snapshot describes. Mirrors the
/// frozen `solve-progress` event `phase` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolvePhase {
    /// Initial working set built from owned (+ wild) pals; no breeding yet.
    Seeding,
    /// One breeding pass over all cross pairs of the working set.
    Step,
    /// A `BreedingOnly` request found no owned path and is re-running with
    /// catching allowed (emitted by [`crate::solver::solve_modes`]).
    CatchFallback,
    /// Search finished; results are about to be pin-filtered / pruned / mapped.
    Finalizing,
}

/// A coarse-grained snapshot of search progress. `elapsed`/`token`/`kind` are
/// added by the Tauri layer; the engine only fills the algorithmic counts.
#[derive(Debug, Clone, Copy)]
pub struct SolveProgress {
    pub phase: SolvePhase,
    /// 1-based step number for display (`0` during [`SolvePhase::Seeding`] /
    /// [`SolvePhase::Finalizing`] / [`SolvePhase::CatchFallback`]).
    pub step: u32,
    /// The search horizon (`SolverConfig::max_solver_iterations`).
    pub max_steps: u32,
    /// Pairs bred so far within the current step (`0` at a phase/step boundary).
    pub pairs_done: u64,
    /// Total pairs in the current step's batch.
    pub pairs_total: u64,
    /// Working-set size at the moment of the snapshot.
    pub working_set: usize,
}

/// Returned by the monitored solve entry points when the cancel flag tripped
/// mid-search. The Tauri layer maps this to `Err("cancelled")`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolveCancelled;

/// Progress + cancellation handle threaded through the search. Cheap to copy
/// (two borrowed handles); `Sync` so it can be shared freely. A no-op monitor
/// ([`SolveMonitor::noop`]) never reports and never cancels, so the historical
/// non-monitored entry points wrap it and unwrap the always-`Ok` result.
#[derive(Clone, Copy)]
pub struct SolveMonitor<'a> {
    progress: Option<&'a (dyn Fn(SolveProgress) + Sync)>,
    cancel: Option<&'a AtomicBool>,
}

impl<'a> SolveMonitor<'a> {
    /// Build a monitor from an optional progress callback and cancel flag.
    #[inline]
    pub fn new(
        progress: Option<&'a (dyn Fn(SolveProgress) + Sync)>,
        cancel: Option<&'a AtomicBool>,
    ) -> Self {
        SolveMonitor { progress, cancel }
    }

    /// A monitor that reports nothing and never cancels.
    #[inline]
    pub fn noop() -> SolveMonitor<'static> {
        SolveMonitor { progress: None, cancel: None }
    }

    /// Deliver a progress snapshot to the callback, if any.
    #[inline]
    pub fn report(&self, p: SolveProgress) {
        if let Some(cb) = self.progress {
            cb(p);
        }
    }

    /// Whether cancellation has been requested. Polled at chunk/step boundaries.
    #[inline]
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(Ordering::Relaxed))
    }

    /// `Err(SolveCancelled)` when cancellation was requested, else `Ok(())`.
    /// Lets callers bail with `?` at a boundary.
    #[inline]
    pub fn check(&self) -> Result<(), SolveCancelled> {
        if self.is_cancelled() {
            Err(SolveCancelled)
        } else {
            Ok(())
        }
    }
}
