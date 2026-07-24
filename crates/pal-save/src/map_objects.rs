//! Decoder for `Level.sav` `worldSaveData.MapObjectSaveData` instance headers.
//!
//! `MapObjectSaveData` holds ONLY player-built base-camp objects (buildings,
//! chests, production stations, the Pal Box anchor). It is an `ArrayProperty`
//! whose elements are property sets `{ MapObjectId, Model, ConcreteModel }`.
//! The per-instance identity, owning base camp, and world transform live in the
//! `Model.RawData` byte blob, whose fixed header (per the
//! cheahjs/palworld-save-tools `rawdata/map_object` lineage) is:
//!
//! | offset | field                              | bytes |
//! |--------|------------------------------------|-------|
//! | 0      | `instance_id` (Guid)               | 16    |
//! | 16     | `concrete_model_instance_id` (Guid)| 16    |
//! | 32     | `base_camp_id_belong_to` (Guid)    | 16    |
//! | 48     | `group_id_belong_to` (Guid)        | 16    |
//! | 64     | `hp.current` (i32)                 | 4     |
//! | 68     | `hp.max` (i32)                     | 4     |
//! | 72     | rotation `FQuat` (4 x f64)         | 32    |
//! | 104    | translation `FVector` (3 x f64)    | 24    |
//! | 128    | scale `FVector` (3 x f64)          | 24    |
//!
//! Only the header (instance id, owning base-camp id, translation `x`/`y`) is
//! decoded; the concrete-model payload past byte 152 is ignored. Offsets were
//! established empirically against `testdata/probe/coop-Level.sav` (all 386
//! instances decode to sane `MainMap` coords) — see the module tests.
//!
//! # What this is NOT
//!
//! Fast-travel and effigy actors are world-static (baked into the persistent-
//! level uasset `PL_MainWorld5.umap`, `BP_LevelObject_TowerFastTravelPoint_C`
//! x152 / `BP_LevelObject_Relic_C` x155), NOT serialized into the save. An
//! exhaustive byte search of the decompressed co-op `Level.sav` finds ZERO of
//! the host's fast-travel / effigy unlock GUIDs in any byte order. Their
//! GUID -> world-coord mapping is therefore only recoverable at pak extraction
//! time. This module surfaces only player base camps ([`read_base_points`]).

use std::collections::HashMap;

use pal_data::types::Guid;

use crate::archive::Reader;
use crate::gvas::{self, GvasHeader, Value};
use crate::SaveError;

/// The `MapObjectId` of the Pal Box — the anchor building that defines a base
/// camp's canonical location. Empirically the single Pal Box per base camp in
/// `testdata/probe/coop-Level.sav`. When present in a base group its position is
/// the base point; otherwise the group centroid is used.
const PALBOX_ID: &str = "PalBoxV2";

/// Byte offsets inside a `Model.RawData` header (see module docs).
const INSTANCE_ID: usize = 0;
const BASE_CAMP_ID: usize = 32;
const TRANSLATION_X: usize = 104;
/// Minimum `Model.RawData` length to carry a full identity + translation
/// (`translation.y` ends at byte 120).
const HEADER_MIN: usize = TRANSLATION_X + 16;

/// One decoded `MapObjectSaveData` instance: its class id, instance GUID,
/// owning base-camp GUID, and world `x`/`y` (the `z` axis is dropped — the map
/// is 2D).
#[derive(Debug, Clone)]
pub struct MapObjectInstance {
    pub map_object_id: String,
    pub instance_id: Guid,
    pub base_camp_id: Guid,
    pub x: f64,
    pub y: f64,
}

/// A player base-camp map point: the world `x`/`y` of one base camp.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BasePoint {
    pub x: f64,
    pub y: f64,
}

/// Decode the `worldSaveData.MapObjectSaveData` instance headers from a
/// decompressed `Level.sav` blob. Each element yields `{ map_object_id,
/// instance_id, base_camp_id, x, y }`; instances whose `Model.RawData` is
/// shorter than a full header are skipped (no recoverable location). Per-element
/// decoding is bounded by the vetted `gvas` array reader (`capped_capacity`), so
/// a corrupt count cannot over-allocate.
///
/// NOT part of the shared summary hot path (`read_save_dir`); call only from the
/// lazy map path.
pub fn read_map_objects(level_blob: &[u8]) -> Result<Vec<MapObjectInstance>, SaveError> {
    let mut r = Reader::new(level_blob);
    GvasHeader::read(&mut r)?;

    while let Some((name, type_name, size)) = gvas::read_tag(&mut r)? {
        if name == "worldSaveData" && type_name == "StructProperty" {
            r.fstring()?; // struct_type
            r.skip(16)?; // struct_id
            r.optional_guid()?;
            return read_map_object_array(&mut r);
        }
        gvas::skip_property(&mut r, &type_name, size)?;
    }
    Err(SaveError::Gvas(
        "worldSaveData not found in level save".into(),
    ))
}

/// Decode `MapObjectSaveData` and reduce it to one [`BasePoint`] per player base
/// camp. Instances are grouped by their (non-nil) `base_camp_id`; the base point
/// is the Pal Box ([`PALBOX_ID`]) position when the camp has one, else the
/// centroid of that camp's buildings. Returns an empty vec when the level has no
/// base camps.
pub fn read_base_points(level_blob: &[u8]) -> Result<Vec<BasePoint>, SaveError> {
    Ok(base_points(&read_map_objects(level_blob)?))
}

/// Group decoded instances by owning base camp into one [`BasePoint`] each.
/// Camps are ordered by first appearance for a stable result.
fn base_points(objects: &[MapObjectInstance]) -> Vec<BasePoint> {
    struct Group {
        palbox: Option<BasePoint>,
        sum_x: f64,
        sum_y: f64,
        n: u32,
    }
    let mut order: Vec<Guid> = Vec::new();
    let mut groups: HashMap<Guid, Group> = HashMap::new();
    for o in objects {
        if is_nil(&o.base_camp_id) {
            continue; // not tied to a base camp
        }
        let g = groups.entry(o.base_camp_id).or_insert_with(|| {
            order.push(o.base_camp_id);
            Group {
                palbox: None,
                sum_x: 0.0,
                sum_y: 0.0,
                n: 0,
            }
        });
        g.sum_x += o.x;
        g.sum_y += o.y;
        g.n += 1;
        if o.map_object_id == PALBOX_ID {
            g.palbox = Some(BasePoint { x: o.x, y: o.y });
        }
    }
    order
        .iter()
        .filter_map(|id| groups.get(id))
        .filter_map(|g| {
            g.palbox.or_else(|| {
                (g.n > 0).then_some(BasePoint {
                    x: g.sum_x / g.n as f64,
                    y: g.sum_y / g.n as f64,
                })
            })
        })
        .collect()
}

fn is_nil(g: &Guid) -> bool {
    g.iter().all(|&b| b == 0)
}

/// Walk `worldSaveData`, materializing only `MapObjectSaveData` (every other
/// section is structurally skipped by size). Returns an empty vec if the section
/// is absent.
fn read_map_object_array(r: &mut Reader) -> Result<Vec<MapObjectInstance>, SaveError> {
    while let Some((name, type_name, size)) = gvas::read_tag(r)? {
        if name == "MapObjectSaveData" && type_name == "ArrayProperty" {
            let value = gvas::read_property(r, &type_name, size)?;
            let elems = value.as_array().unwrap_or(&[]);
            let mut out = Vec::with_capacity(elems.len());
            for el in elems {
                if let Some(inst) = decode_instance(el) {
                    out.push(inst);
                }
            }
            return Ok(out);
        }
        gvas::skip_property(r, &type_name, size)?;
    }
    Ok(Vec::new())
}

/// Decode one array element into a [`MapObjectInstance`]. Returns `None` when
/// the `Model.RawData` header is missing or too short to carry the identity +
/// translation.
fn decode_instance(el: &Value) -> Option<MapObjectInstance> {
    let props = el.as_props()?;
    let map_object_id = gvas::find(props, "MapObjectId")
        .and_then(Value::as_str)?
        .to_string();
    let raw = gvas::find(props, "Model")
        .and_then(Value::as_props)
        .and_then(|m| gvas::find(m, "RawData"))
        .and_then(Value::as_bytes)?;
    if raw.len() < HEADER_MIN {
        return None;
    }
    let instance_id: Guid = raw.get(INSTANCE_ID..INSTANCE_ID + 16)?.try_into().ok()?;
    let base_camp_id: Guid = raw.get(BASE_CAMP_ID..BASE_CAMP_ID + 16)?.try_into().ok()?;
    let x = read_f64(raw, TRANSLATION_X)?;
    let y = read_f64(raw, TRANSLATION_X + 8)?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(MapObjectInstance {
        map_object_id,
        instance_id,
        base_camp_id,
        x,
        y,
    })
}

fn read_f64(buf: &[u8], off: usize) -> Option<f64> {
    let bytes: [u8; 8] = buf.get(off..off + 8)?.try_into().ok()?;
    Some(f64::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::decompress_sav;

    // MainMap world bounds from the pak-extracted map-data.json meta.
    const X_MIN: f64 = -1_099_400.0;
    const X_MAX: f64 = 349_400.0;
    const Y_MIN: f64 = -724_400.0;
    const Y_MAX: f64 = 724_400.0;

    fn load(name: &str) -> Vec<u8> {
        let path = format!("{}/../../testdata/probe/{name}", env!("CARGO_MANIFEST_DIR"));
        let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        decompress_sav(&raw).expect("decompress")
    }

    fn in_bounds(x: f64, y: f64) -> bool {
        (X_MIN..=X_MAX).contains(&x) && (Y_MIN..=Y_MAX).contains(&y)
    }

    /// Decoder correctness: the co-op `Level.sav` `MapObjectSaveData` decodes to
    /// many base-camp instances, every one with sane in-bounds `MainMap` coords.
    #[test]
    fn coop_level_map_objects_decode_with_sane_coords() {
        let objs = read_map_objects(&load("coop-Level.sav")).expect("decode map objects");
        assert!(
            objs.len() >= 300,
            "expected >=300 map objects, got {}",
            objs.len()
        );
        for o in &objs {
            assert!(
                in_bounds(o.x, o.y),
                "instance {} coord out of MainMap bounds: ({}, {})",
                o.map_object_id,
                o.x,
                o.y
            );
        }
    }

    /// GROUND TRUTH (R2): the co-op `Level.sav` yields >=1 base camp, every base
    /// point sits inside `MainMap`, and one base is the host's, near the known
    /// palbox anchor at ~(-324932, 220032).
    #[test]
    fn coop_bases_resolve_with_ground_truth_coords() {
        let bases = read_base_points(&load("coop-Level.sav")).expect("decode bases");
        assert!(!bases.is_empty(), "expected >=1 base camp, got 0");
        for b in &bases {
            assert!(
                in_bounds(b.x, b.y),
                "base point out of MainMap bounds: ({}, {})",
                b.x,
                b.y
            );
        }
        let host = bases
            .iter()
            .find(|b| (b.x - -324_932.0).abs() < 5_000.0 && (b.y - 220_032.0).abs() < 5_000.0);
        assert!(
            host.is_some(),
            "no base near the host's known anchor (-324932, 220032); got {bases:?}"
        );
    }
}
