//! Breeding-path solver core. Iterative working-set search over owned, wild, and
//! bred pal references, minimizing estimated real-world effort. Algorithm lineage:
//! palcalc `PalCalc.Solver` (MIT) — see `DESIGN.md` and each submodule's header.

pub mod config;
pub mod engine;
pub mod pruning;
pub mod queue;
pub mod refs;
pub mod resolve;
pub mod results;
pub mod spec;
pub mod working_set;

pub use config::{BreedingSetup, CakeKind, IvModel, SolverConfig};
pub use engine::{
    build_initial_content, solve, solve_modes, solve_reporting, solve_with_catching, Catching,
    ModeResult,
};
pub use refs::{
    BredPalRef, EffPassive, OwnedInstance, OwnedPalRef, PalRef, RefGender, SolverIv, SolverIvSet,
    WildPalRef,
};
pub use resolve::{resolve_passive, resolve_species};
pub use results::{filter_trivial_wild, is_trivial_wild_plan, BreedingPlan, PlanNode, PlanSource};
pub use queue::{solve_queue, QueueItem, QueueItemResult, QueueResult};
pub use spec::{TargetPal, TargetSpec};
pub use working_set::{key_of, RefKey, WorkingSet};
