//! Palworld `.sav` reader: PlZ/PlM compression wrapper -> GVAS property tree
//! -> `pal_data::OwnedPal` extraction. READ-ONLY by design; this crate never
//! writes save data.

pub mod compress;

use thiserror::Error;

/// Errors surfaced by the save reader. Per-entity failures do NOT produce these;
/// they are collected as warnings on [`SaveData`] instead (fail-soft parsing).
#[derive(Debug, Error)]
pub enum SaveError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("compression: {0}")]
    Compression(String),
    #[error("not supported yet: {0}")]
    NotSupportedYet(String),
    #[error("gvas: {0}")]
    Gvas(String),
    #[error("save layout: {0}")]
    Layout(String),
}
