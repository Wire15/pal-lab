//! Domain types + game data pack for Pal Calc.
//!
//! `types` holds the shared vocabulary used across crates (pal-save produces
//! `OwnedPal`s; the solver consumes them). Game-data structs (species, breeding
//! table, probability weight arrays) live in `gamedata` and are loaded from a
//! compact binary pack converted from extracted game data — never parsed from
//! JSON at startup.

pub mod types;

pub use types::*;
