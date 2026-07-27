//! Web mirror of `app/src-tauri/src/mapstate.rs`: the save-side half of the MAP
//! feature, built from the cached save bundle instead of a directory.
//!
//! Combines the same three sources as native — client `LocalData.sav` (fog +
//! custom markers), each player `.sav` (position + `RecordData` unlock flags),
//! and `Level.sav` (nicknames + base-camp points) — into one [`MapState`]. Two
//! native behaviors have no browser analogue and are dropped: the
//! `%LOCALAPPDATA%` fog-discovery fallback (the bundle's `LocalData.sav` is the
//! only source) and the `_dps.sav` filtering by directory listing (the caller
//! passes only the regular player saves). Everything degrades gracefully: a
//! missing/unreadable source yields the empty/`null` shape, never an error.

use std::collections::HashMap;

use base64::Engine as _;
use pal_save::{CustomMarker, FogLayer, LocalData};
use serde::Serialize;

use crate::save::guid_str;

/// One world-map fog layer, ready for the frontend. `revealed_png_base64` is a
/// base64 8-bit grayscale PNG (255 = revealed, 0 = fogged).
#[derive(Debug, Clone, Serialize)]
pub struct FogLayerDto {
    pub map: String,
    pub width: usize,
    pub height: usize,
    pub revealed_png_base64: String,
    pub revealed_pct: f64,
}

/// A player-placed custom marker.
#[derive(Debug, Clone, Serialize)]
pub struct MarkerDto {
    pub x: f64,
    pub y: f64,
    pub icon_type: i32,
}

/// Per-player map state. `uid` is the lowercase 32-char hex GUID; `x`/`y` are
/// world coords, `null` when the position could not be recovered.
#[derive(Debug, Clone, Serialize)]
pub struct MapPlayerState {
    pub uid: String,
    pub nickname: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub fast_travel_unlocked: Vec<String>,
    pub effigies_found: Vec<String>,
    pub effigy_possess_num: i32,
    pub bosses_defeated: Vec<String>,
    pub areas_found: Vec<String>,
    pub towers_defeated: Vec<String>,
}

/// One player base-camp map point: world `x`/`y` of a base camp anchor.
#[derive(Debug, Clone, Serialize)]
pub struct BaseDto {
    pub x: f64,
    pub y: f64,
}

/// The full map state for one world.
#[derive(Debug, Clone, Serialize)]
pub struct MapState {
    /// `None` when no client `LocalData.sav` was in the bundle (no fog).
    pub fog: Option<Vec<FogLayerDto>>,
    /// Bundle-relative source the fog/markers were read from, or `None`.
    pub local_source: Option<String>,
    pub markers: Vec<MarkerDto>,
    pub players: Vec<MapPlayerState>,
    /// One point per player base camp, decoded lazily from `Level.sav`
    /// `MapObjectSaveData`. `null` when no `Level.sav` was readable or the world
    /// has no base camps.
    pub bases: Option<Vec<BaseDto>>,
}

/// Decompress a raw `.sav` byte buffer to its GVAS blob.
fn decompress(raw: &[u8]) -> Option<Vec<u8>> {
    pal_save::compress::decompress_sav(raw).ok()
}

/// Build the map state from the cached bundle bytes. `level_raw` is the raw
/// (compressed) `Level.sav`; `player_saves` the regular per-player saves
/// (label + raw bytes, `_dps.sav` already excluded by the caller);
/// `localdata_raw` the optional client `LocalData.sav` bytes.
pub fn get_map_state(
    level_raw: &[u8],
    player_saves: &[(String, Vec<u8>)],
    localdata_raw: Option<&[u8]>,
) -> MapState {
    // Decompress Level.sav once; nicknames + base camps share the blob. A
    // missing/unreadable Level.sav degrades gracefully.
    let level_blob = decompress(level_raw);
    let nicknames: HashMap<String, String> = level_blob
        .as_deref()
        .and_then(|b| pal_save::read_level_sav_from_blob(b).ok())
        .map(|s| {
            s.players
                .iter()
                .map(|p| (guid_str(&p.uid), p.name.clone()))
                .collect()
        })
        .unwrap_or_default();

    let players = read_players(player_saves, &nicknames);

    let bases = level_blob.as_deref().and_then(|blob| {
        let pts = pal_save::read_base_points(blob).ok()?;
        if pts.is_empty() {
            return None;
        }
        Some(pts.into_iter().map(|b| BaseDto { x: b.x, y: b.y }).collect())
    });

    let (fog, markers, local_source) = match localdata_raw.and_then(load_local) {
        Some(ld) => (
            Some(build_fog(ld.layers)),
            build_markers(ld.markers),
            Some("LocalData.sav".to_string()),
        ),
        None => (None, Vec::new(), None),
    };

    MapState {
        fog,
        local_source,
        markers,
        players,
        bases,
    }
}

/// Parse every provided player save, joining nicknames. Unreadable saves are
/// skipped (fail-soft), mirroring native `read_players`.
fn read_players(
    player_saves: &[(String, Vec<u8>)],
    nicknames: &HashMap<String, String>,
) -> Vec<MapPlayerState> {
    let mut players = Vec::new();
    for (_label, raw) in player_saves {
        let Some(rec) = decompress(raw).and_then(|b| pal_save::parse_player_map_state(&b).ok())
        else {
            continue;
        };
        let uid = guid_str(&rec.uid);
        let nickname = nicknames.get(&uid).cloned().filter(|n| !n.is_empty());
        players.push(MapPlayerState {
            uid,
            nickname,
            x: rec.x,
            y: rec.y,
            fast_travel_unlocked: rec.fast_travel_unlocked,
            effigies_found: rec.effigies_found,
            effigy_possess_num: rec.effigy_possess_num,
            bosses_defeated: rec.bosses_defeated,
            areas_found: rec.areas_found,
            towers_defeated: rec.towers_defeated,
        });
    }
    players
}

/// Decode a raw `LocalData.sav` buffer, or `None` if unreadable.
fn load_local(raw: &[u8]) -> Option<LocalData> {
    decompress(raw).and_then(|b| pal_save::read_local_data(&b).ok())
}

/// Encode each fog layer's revealed mask as a base64 grayscale PNG.
fn build_fog(layers: Vec<FogLayer>) -> Vec<FogLayerDto> {
    layers
        .into_iter()
        .filter_map(|l| {
            let revealed_pct = l.revealed_pct();
            // 255 = revealed (alpha != 0xFF), 0 = fogged.
            let gray: Vec<u8> = l.alpha.iter().map(|&a| if a == 0xFF { 0 } else { 255 }).collect();
            let png = encode_gray_png(l.width as u32, l.height as u32, &gray).ok()?;
            Some(FogLayerDto {
                map: l.map_id,
                width: l.width,
                height: l.height,
                revealed_png_base64: base64::engine::general_purpose::STANDARD.encode(&png),
                revealed_pct,
            })
        })
        .collect()
}

fn build_markers(markers: Vec<CustomMarker>) -> Vec<MarkerDto> {
    markers
        .into_iter()
        .map(|m| MarkerDto {
            x: m.x,
            y: m.y,
            icon_type: m.icon_type,
        })
        .collect()
}

/// Encode a `width` x `height` 8-bit grayscale buffer as a PNG byte stream.
fn encode_gray_png(width: u32, height: u32, gray: &[u8]) -> Result<Vec<u8>, png::EncodingError> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(gray)?;
    }
    Ok(out)
}
