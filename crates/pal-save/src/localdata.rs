//! Map-feature readers: the client `LocalData.sav` (world-map fog + custom
//! markers) and the per-player map state pulled from a player `.sav`
//! (`LastTransform` position + the `RecordData` unlock/possession flags).
//! Read-only, like the rest of this crate.

use pal_data::types::Guid;

use crate::archive::Reader;
use crate::gvas::{self, GvasHeader, Value};
use crate::SaveError;

/// The `LocalData.sav` save-game class we require.
const LOCAL_SAVE_CLASS: &str = "/Script/Pal.PalLocalWorldSaveGame";

/// One world-map fog layer recovered from `SaveData.WorldMapUISaveDataMap`.
/// `width`/`height` are derived from the mask byte length (`sqrt(len / 4)`),
/// never hardcoded: `MainMap` is 1024x1024 and `Tree` 512x512 in real saves.
#[derive(Debug, Clone)]
pub struct FogLayer {
    /// Map key, e.g. `"MainMap"` or `"Tree"`.
    pub map_id: String,
    pub width: usize,
    pub height: usize,
    /// Extracted alpha channel, one byte per pixel in the source row order.
    /// Alpha `0xFF` means fogged; any other value means revealed.
    pub alpha: Vec<u8>,
}

impl FogLayer {
    /// Percentage (0..100) of pixels revealed (`alpha != 0xFF`).
    pub fn revealed_pct(&self) -> f64 {
        if self.alpha.is_empty() {
            return 0.0;
        }
        let revealed = self.alpha.iter().filter(|&&a| a != 0xFF).count();
        revealed as f64 * 100.0 / self.alpha.len() as f64
    }
}

/// A player-placed custom map marker (`SaveData.Local_CustomMarkerSaveData`).
#[derive(Debug, Clone)]
pub struct CustomMarker {
    /// World X (from `IconLocation` `Vector`).
    pub x: f64,
    /// World Y.
    pub y: f64,
    pub icon_type: i32,
}

/// Everything the client `LocalData.sav` yields for the map.
#[derive(Debug, Default, Clone)]
pub struct LocalData {
    pub layers: Vec<FogLayer>,
    pub markers: Vec<CustomMarker>,
}

/// Read a decompressed `LocalData.sav` blob into its fog layers + markers.
pub fn read_local_data(blob: &[u8]) -> Result<LocalData, SaveError> {
    let mut r = Reader::new(blob);
    let hdr = GvasHeader::read(&mut r)?;
    if hdr.save_game_class_name != LOCAL_SAVE_CLASS {
        return Err(SaveError::Gvas(format!(
            "not a LocalData save: class {:?}",
            hdr.save_game_class_name
        )));
    }
    // Top level holds a single `SaveData` StructProperty (PalLocalSaveData).
    while let Some((name, type_name, size)) = gvas::read_tag(&mut r)? {
        if name == "SaveData" && type_name == "StructProperty" {
            r.fstring()?; // struct type
            r.skip(16)?; // struct id
            r.optional_guid()?;
            return parse_local_save_data(&mut r);
        }
        gvas::skip_property(&mut r, &type_name, size)?;
    }
    Err(SaveError::Gvas("SaveData not found in LocalData save".into()))
}

/// Walk the `PalLocalSaveData` body, materializing only the two properties the
/// map needs; everything else (dozens of small flag maps + the palette) is
/// structurally skipped by size.
fn parse_local_save_data(r: &mut Reader) -> Result<LocalData, SaveError> {
    let mut out = LocalData::default();
    while let Some((name, type_name, size)) = gvas::read_tag(r)? {
        match name.as_str() {
            "WorldMapUISaveDataMap" if type_name == "MapProperty" => {
                let map = gvas::read_property(r, &type_name, size)?;
                if let Some(entries) = map.as_map() {
                    for (k, v) in entries {
                        let Some(map_id) = k.as_str() else { continue };
                        let Some(props) = v.as_props() else { continue };
                        if let Some(layer) = fog_layer(map_id.to_string(), props) {
                            out.layers.push(layer);
                        }
                    }
                }
            }
            "Local_CustomMarkerSaveData" if type_name == "ArrayProperty" => {
                let arr = gvas::read_property(r, &type_name, size)?;
                if let Some(elems) = arr.as_array() {
                    for elem in elems {
                        if let Some(m) = elem.as_props().and_then(|p| custom_marker(p)) {
                            out.markers.push(m);
                        }
                    }
                }
            }
            _ => gvas::skip_property(r, &type_name, size)?,
        }
    }
    Ok(out)
}

/// Build a [`FogLayer`] from one `WorldMapUISaveDataMap` value struct. The mask
/// is raw RGBA8; dimensions come from its byte length. Returns `None` if the
/// mask is missing or not a square RGBA8 buffer.
fn fog_layer(map_id: String, props: &[(String, Value)]) -> Option<FogLayer> {
    let rgba = gvas::find(props, "MaskTextureData").and_then(Value::as_bytes)?;
    if rgba.is_empty() || rgba.len() % 4 != 0 {
        return None;
    }
    let pixels = rgba.len() / 4;
    let side = (pixels as f64).sqrt() as usize;
    if side == 0 || side * side != pixels {
        return None;
    }
    // The alpha channel is every 4th byte; that is all the fog decode needs.
    let alpha: Vec<u8> = rgba.iter().skip(3).step_by(4).copied().collect();
    Some(FogLayer {
        map_id,
        width: side,
        height: side,
        alpha,
    })
}

fn custom_marker(props: &[(String, Value)]) -> Option<CustomMarker> {
    let (x, y, _z) = gvas::find(props, "IconLocation").and_then(Value::as_vec3)?;
    let icon_type = gvas::find(props, "IconType")
        .and_then(Value::as_i32)
        .unwrap_or(0);
    Some(CustomMarker { x, y, icon_type })
}

/// One player's map-relevant state, recovered from their `.sav`. `uid` is the
/// `PlayerUId`; `x`/`y` are the last-known world position (`z` dropped — the map
/// is 2D). The flag vectors carry only the keys whose flag is `true`.
#[derive(Debug, Default, Clone)]
pub struct PlayerMapRecord {
    pub uid: Guid,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub fast_travel_unlocked: Vec<String>,
    pub effigies_found: Vec<String>,
    pub effigy_possess_num: i32,
    pub bosses_defeated: Vec<String>,
    pub areas_found: Vec<String>,
    /// Per-player tower progress. The save exposes no dedicated tower-defeat flag, so this is the
    /// `Tower_<Region>`-prefixed subset of `FindAreaFlagMap` (semantics: tower area reached), which
    /// is the only per-player tower-keyed signal in the save. Joins to `map-data.json` `towers[].key`.
    pub towers_defeated: Vec<String>,
}

/// Parse a decompressed player `.sav` blob into its map state.
///
/// The player position is taken from `SaveData.LastTransform.Translation`, which
/// is the authoritative last-logout transform. (The `Level.sav` character entry
/// for a player carries only `LastJumpedLocation` — a transient jump event, not
/// the logout position — so this player-save path is the correct source.)
pub fn parse_player_map_state(blob: &[u8]) -> Result<PlayerMapRecord, SaveError> {
    let mut r = Reader::new(blob);
    GvasHeader::read(&mut r)?;
    // Player top level holds `SaveData` (PalWorldPlayerSaveData).
    while let Some((name, type_name, size)) = gvas::read_tag(&mut r)? {
        if name == "SaveData" && type_name == "StructProperty" {
            r.fstring()?;
            r.skip(16)?;
            r.optional_guid()?;
            return parse_player_body_map(&mut r);
        }
        gvas::skip_property(&mut r, &type_name, size)?;
    }
    Err(SaveError::Gvas("SaveData not found in player save".into()))
}

/// Walk the `PalWorldPlayerSaveData` body, materializing only the uid, the
/// last transform, and the `RecordData` sub-struct; the bulky inventory / skin /
/// quest arrays are structurally skipped.
fn parse_player_body_map(r: &mut Reader) -> Result<PlayerMapRecord, SaveError> {
    let mut rec = PlayerMapRecord::default();
    while let Some((name, type_name, size)) = gvas::read_tag(r)? {
        match name.as_str() {
            "PlayerUId" if type_name == "StructProperty" => {
                rec.uid = gvas::read_property(r, &type_name, size)?
                    .as_guid()
                    .unwrap_or_default();
            }
            "LastTransform" if type_name == "StructProperty" => {
                let v = gvas::read_property(r, &type_name, size)?;
                if let Some((x, y, _z)) = v
                    .as_props()
                    .and_then(|p| gvas::find(p, "Translation"))
                    .and_then(Value::as_vec3)
                {
                    rec.x = Some(x);
                    rec.y = Some(y);
                }
            }
            "RecordData" if type_name == "StructProperty" => {
                let v = gvas::read_property(r, &type_name, size)?;
                if let Some(props) = v.as_props() {
                    fill_record(&mut rec, props);
                }
            }
            _ => gvas::skip_property(r, &type_name, size)?,
        }
    }
    Ok(rec)
}

/// Populate the `RecordData`-sourced fields of a [`PlayerMapRecord`].
fn fill_record(rec: &mut PlayerMapRecord, props: &[(String, Value)]) {
    rec.fast_travel_unlocked = true_keys(props, "FastTravelPointUnlockFlag");
    rec.effigies_found = true_keys(props, "RelicObtainForInstanceFlag");
    rec.effigy_possess_num = gvas::find(props, "RelicPossessNum")
        .and_then(Value::as_i32)
        .unwrap_or(0);
    rec.bosses_defeated = true_keys(props, "NormalBossDefeatFlag");
    rec.areas_found = true_keys(props, "FindAreaFlagMap");
    // No dedicated tower-defeat flag exists in the save; the `Tower_<Region>` area keys are the only
    // per-player tower signal (join key for map-data.json towers[].key).
    rec.towers_defeated = rec
        .areas_found
        .iter()
        .filter(|k| k.starts_with("Tower_"))
        .cloned()
        .collect();
}

/// Collect the keys of a `Map<Name, Bool>` property whose value is `true`.
fn true_keys(props: &[(String, Value)], name: &str) -> Vec<String> {
    gvas::find(props, name)
        .and_then(Value::as_map)
        .map(|entries| {
            entries
                .iter()
                .filter(|(_, v)| v.as_bool().unwrap_or(false))
                .filter_map(|(k, _)| k.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compress::decompress_sav;

    fn load(name: &str) -> Vec<u8> {
        let path = format!(
            "{}/../../testdata/probe/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        let raw = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        decompress_sav(&raw).expect("decompress")
    }

    fn layer<'a>(data: &'a LocalData, id: &str) -> &'a FogLayer {
        data.layers
            .iter()
            .find(|l| l.map_id == id)
            .unwrap_or_else(|| panic!("layer {id} missing"))
    }

    #[test]
    fn coop_localdata_fog_dimensions_and_reveal() {
        let data = read_local_data(&load("LocalData.sav")).expect("local data");
        let main = layer(&data, "MainMap");
        assert_eq!((main.width, main.height), (1024, 1024));
        assert_eq!(main.alpha.len(), 1024 * 1024);
        let tree = layer(&data, "Tree");
        assert_eq!((tree.width, tree.height), (512, 512));
        // Co-op host has barely explored: ~2.27% of MainMap revealed.
        let pct = main.revealed_pct();
        assert!(
            (pct - 2.27).abs() < 0.15,
            "MainMap revealed_pct {pct} not ~2.27"
        );
    }

    #[test]
    fn dedicated_client_localdata_reveal() {
        let data = read_local_data(&load("dedicated-client-LocalData.sav")).expect("local data");
        let main = layer(&data, "MainMap");
        assert_eq!((main.width, main.height), (1024, 1024));
        let pct = main.revealed_pct();
        assert!(
            (pct - 20.96).abs() < 0.15,
            "MainMap revealed_pct {pct} not ~20.96"
        );
        // This client save carries player-placed markers.
        assert!(!data.markers.is_empty(), "expected custom markers");
    }

    #[test]
    fn coop_player_record_known_values() {
        let rec = parse_player_map_state(&load("coop-Player-host.sav")).expect("player");
        assert_eq!(rec.fast_travel_unlocked.len(), 9, "fast-travel count");
        assert_eq!(rec.effigies_found.len(), 5, "effigies found");
        assert_eq!(rec.effigy_possess_num, 2, "relic possess num");
        // Position recovered from LastTransform.
        assert!(rec.x.is_some() && rec.y.is_some(), "player position");
    }

    #[test]
    fn coop_player_towers_defeated_grass() {
        // Ground truth: the co-op host reached/cleared the grass-region tower (Rayne Syndicate).
        // The player save has NO dedicated tower-defeat flag (verified: RecordData has no
        // TowerBossDefeatFlag, NormalBossDefeatFlag holds field bosses only, and the decompressed
        // Level.sav contains zero tower/boss/gym defeat strings). The only per-player tower signal is
        // FindAreaFlagMap's `Tower_<Region>` keys, so `towers_defeated` surfaces exactly those.
        let rec = parse_player_map_state(&load("coop-Player-host.sav")).expect("player");
        assert_eq!(
            rec.towers_defeated,
            vec!["Tower_Grass".to_string()],
            "host towers_defeated should be exactly [Tower_Grass]"
        );
        // Every tower key is a strict subset of areas_found (same underlying FindAreaFlagMap).
        for k in &rec.towers_defeated {
            assert!(k.starts_with("Tower_"), "tower key {k} not Tower_-prefixed");
            assert!(rec.areas_found.contains(k), "tower key {k} missing from areas_found");
        }
    }
}
