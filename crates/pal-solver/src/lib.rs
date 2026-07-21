//! Breeding-path solver: iterative working-set dynamic programming over owned,
//! wild, and bred pal references, minimizing estimated real-world effort.
//! Algorithm lineage: palcalc's PalCalc.Solver (MIT), see DESIGN.md.

pub mod probabilities;
pub mod solver;

pub use probabilities::*;
pub use solver::*;
