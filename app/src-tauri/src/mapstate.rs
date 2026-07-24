//! `get_map_state` command: the save-side half of the MAP feature.
//!
//! Combines three sources into one [`MapState`]:
//!  - the client `LocalData.sav` -> world-map fog (per layer, as an 8-bit
//!    grayscale PNG where 255 = revealed, 0 = fogged) + player custom markers,
//!  - each player `.sav` -> last-known world position + `RecordData` unlock
//!    flags (fast-travel, effigies, defeated bosses, discovered areas),
//!  - `Level.sav` -> player nicknames (joined to the player saves by uid).
//!
//! Read-only. `save_dir` is the folder that holds `Level.sav` + `Players/`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use pal_save::{CustomMarker, FogLayer, LocalData};
use serde::Serialize;

use crate::save::guid_str;

/// One world-map fog layer, ready for the frontend. `revealed_png_base64` is a
/// base64 8-bit grayscale PNG (255 = revealed, 0 = fogged), same dimensions as
/// the source mask.
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

/// Per-player map state. `uid` is the lowercase 32-char hex GUID (matching
/// [`crate::save::PlayerRef::uid`]); `x`/`y` are world coords, `null` when the
/// position could not be recovered. Flag lists hold only `true`/found keys.
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

/// One player base-camp map point (R2): world `x`/`y` of a base camp anchor
/// (the Pal Box position, else the base's building centroid).
#[derive(Debug, Clone, Serialize)]
pub struct BaseDto {
    pub x: f64,
    pub y: f64,
}

/// The full map state for one world.
#[derive(Debug, Clone, Serialize)]
pub struct MapState {
    /// `None` when no client `LocalData.sav` was found (graceful — no fog).
    pub fog: Option<Vec<FogLayerDto>>,
    /// Absolute path the fog/markers were read from, or `None`.
    pub local_source: Option<String>,
    pub markers: Vec<MarkerDto>,
    pub players: Vec<MapPlayerState>,
    /// One point per player base camp (R2), decoded lazily from
    /// `Level.sav` `MapObjectSaveData`. `null` when no `Level.sav` was
    /// readable or the world has no base camps.
    pub bases: Option<Vec<BaseDto>>,
}

/// Read the map state for `save_dir`. Read-only. Never errors on a missing
/// client `LocalData.sav` (fog is `null` instead); returns `Err` only when the
/// save directory itself cannot be read.
#[tauri::command]
pub fn get_map_state(save_dir: String) -> Result<MapState, String> {
    let dir = Path::new(&save_dir);

    // Decompress Level.sav once; nicknames + base camps share the blob.
    // A missing or unreadable Level.sav degrades gracefully (no nicknames /
    // null bases) rather than failing the whole command.
    let level_blob = decompress(&dir.join("Level.sav")).ok();
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

    let players = read_players(dir, &nicknames);

    // R2: one point per player base camp, decoded lazily from
    // `MapObjectSaveData` (NOT the shared summary hot path). `None` when the
    // level is unreadable or has no base camps.
    let bases = level_blob.as_deref().and_then(|blob| {
        let pts = pal_save::read_base_points(blob).ok()?;
        if pts.is_empty() {
            return None;
        }
        Some(pts.into_iter().map(|b| BaseDto { x: b.x, y: b.y }).collect())
    });

    let (local, local_source) = discover_local_data(dir);
    let (fog, markers) = match local {
        Some(ld) => (Some(build_fog(ld.layers)), build_markers(ld.markers)),
        None => (None, Vec::new()),
    };

    Ok(MapState {
        fog,
        local_source,
        markers,
        players,
        bases,
    })
}

/// Parse every non-`_dps` player save in `<dir>/Players`, joining nicknames.
fn read_players(dir: &Path, nicknames: &HashMap<String, String>) -> Vec<MapPlayerState> {
    let mut players = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir.join("Players")) else {
        return players;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("sav") {
            continue;
        }
        if path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|n| n.ends_with("_dps.sav"))
        {
            continue;
        }
        let Ok(rec) = decompress(&path).and_then(|b| {
            pal_save::parse_player_map_state(&b).map_err(|e| e.to_string())
        }) else {
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

/// Locate + read the client `LocalData.sav` for this world.
///
/// Order (contract C2): `<save_dir>/LocalData.sav` (co-op layout) ->
/// `%LOCALAPPDATA%/Pal/Saved/SaveGames/<steamid>/<basename(save_dir)>/LocalData.sav`
/// (client keeps per-world fog locally even for dedicated worlds, keyed by the
/// save-dir folder name) -> `None` (no fog).
fn discover_local_data(save_dir: &Path) -> (Option<LocalData>, Option<String>) {
    let direct = save_dir.join("LocalData.sav");
    if let Some(ld) = load_local(&direct) {
        return (Some(ld), Some(direct.display().to_string()));
    }
    if let (Some(world), Ok(local_app)) = (
        save_dir.file_name().and_then(|s| s.to_str()),
        std::env::var("LOCALAPPDATA"),
    ) {
        let root = PathBuf::from(local_app).join("Pal/Saved/SaveGames");
        if let Ok(users) = std::fs::read_dir(&root) {
            for user in users.flatten() {
                let cand = user.path().join(world).join("LocalData.sav");
                if let Some(ld) = load_local(&cand) {
                    return (Some(ld), Some(cand.display().to_string()));
                }
            }
        }
    }
    (None, None)
}

/// Read + decode a `LocalData.sav` at `path`, or `None` if absent/unreadable.
fn load_local(path: &Path) -> Option<LocalData> {
    if !path.is_file() {
        return None;
    }
    decompress(path)
        .and_then(|b| pal_save::read_local_data(&b).map_err(|e| e.to_string()))
        .ok()
}

fn decompress(path: &Path) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    pal_save::compress::decompress_sav(&raw).map_err(|e| e.to_string())
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
