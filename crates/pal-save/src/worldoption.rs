//! `WorldOption.sav` reader: the same P1M/P1Z + Oodle compression wrapper as
//! `Level.sav`, then the GVAS property tree, to recover the world's breeding-
//! relevant option values. READ-ONLY, like the rest of this crate.
//!
//! Dedicated servers keep world settings elsewhere and ship no `WorldOption.sav`;
//! callers treat a missing file as "vanilla defaults" ([`crate::read_world_options`]
//! returns `Ok(None)`).

use crate::archive::Reader;
use crate::gvas::{self, GvasHeader, Value};
use crate::SaveError;

/// World option values relevant to breeding effort estimation.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldOptions {
    /// `OptionWorldData.PalEggDefaultHatchingTime` — egg hatch time in hours.
    /// `None` when the property is absent from the save (older/edited files).
    pub egg_hatch_hours: Option<f64>,
}

/// Parse a decompressed `WorldOption.sav` GVAS blob for the breeding options.
/// Fully materializes the (small) top-level property set and searches it for the
/// `PalEggDefaultHatchingTime` float, tolerating the exact nesting layout.
pub fn parse_world_options(blob: &[u8]) -> Result<WorldOptions, SaveError> {
    let mut r = Reader::new(blob);
    GvasHeader::read(&mut r)?;

    let mut egg_hatch_hours = None;
    while let Some((_name, type_name, size)) = gvas::read_tag(&mut r)? {
        let value = gvas::read_property(&mut r, &type_name, size)?;
        if egg_hatch_hours.is_none() {
            if let Some(f) = find_float(&value, "PalEggDefaultHatchingTime") {
                egg_hatch_hours = Some(f as f64);
            }
        }
    }
    Ok(WorldOptions { egg_hatch_hours })
}

/// Recursively search a materialized property value for a `FloatProperty`
/// named `key`, descending struct property sets and arrays.
fn find_float(value: &Value, key: &str) -> Option<f32> {
    match value {
        Value::Props(props) => {
            for (k, v) in props {
                if k == key {
                    if let Value::Float(f) = v {
                        return Some(*f);
                    }
                }
                if let Some(f) = find_float(v, key) {
                    return Some(f);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(|v| find_float(v, key)),
        _ => None,
    }
}
