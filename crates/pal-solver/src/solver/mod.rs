//! Breeding-path solver core. Iterative working-set search over owned, wild, and
//! bred pal references, minimizing estimated real-world effort. Algorithm lineage:
//! palcalc `PalCalc.Solver` (MIT) — see `DESIGN.md` and each submodule's header.

pub mod config;
pub mod diagnose;
pub mod engine;
pub mod progress;
pub mod pruning;
pub mod queue;
pub mod refs;
pub mod resolve;
pub mod results;
pub mod spec;
pub mod working_set;

pub use config::{
    BreedingSetup, CakeKind, GenderReverserConfig, IvModel, SolverConfig, SurgeryConfig,
};
pub use diagnose::{diagnose_no_path, NoPathReason};
pub use engine::{
    build_initial_content, solve, solve_modes, solve_modes_monitored, solve_reporting,
    solve_with_catching, solve_with_catching_monitored, Catching, ModeResult,
};
pub use progress::{SolveCancelled, SolveMonitor, SolvePhase, SolveProgress};
pub use refs::{
    BredPalRef, EffPassive, OwnedInstance, OwnedPalRef, PalRef, RefGender, SolverIv, SolverIvSet,
    WildPalRef,
};
pub use resolve::{resolve_passive, resolve_species};
pub use results::{
    filter_trivial_wild, is_trivial_wild_plan, BreedingPlan, PlanNode, PlanSource, SolvedRef,
    SurgeryStep,
};
pub use queue::{solve_queue, solve_queue_monitored, QueueItem, QueueItemResult, QueueResult};
pub use spec::{TargetPal, TargetSpec};
pub use working_set::{key_of, RefKey, WorkingSet};
