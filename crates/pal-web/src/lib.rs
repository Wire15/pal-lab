//! wasm-bindgen bridge exposing the Pal Lab Tauri command surface to a browser
//! Web Worker.
//!
//! The desktop app talks to a Rust backend through Tauri IPC; the browser build
//! runs the identical `pal-*` crates compiled to wasm inside a Worker and talks
//! to them through this bridge. Every export mirrors a native command 1:1 — same
//! command strings, same camelCase invoke arg keys, same JSON return shapes — so
//! the TypeScript layer needs no per-command shims.
//!
//! # Surface
//! * [`init_pack`] — force-decode the embedded [`pal_data::GameData`] pack.
//! * [`load_save_bundle`] — parse + cache a save from in-memory file buffers.
//! * [`dispatch`] — run any command against the cached save / pack.
//! * [`set_progress`] — install the `solve-progress` JS callback.
//! * [`cancel_solve_token`] — trip the cancel flag for a solve token.
//!
//! Single-threaded caveat: `solve`/`solve_queue` run synchronously in the Worker
//! (no thread offload); cancellation is best-effort between chunk boundaries and
//! the solver's built-in search deadline is the hard stop. `watch_save`,
//! `unwatch_save`, and `check_update` have no faithful browser analogue and
//! return a descriptive error.

mod mapstate;
mod paldex;
mod save;
mod solver;
mod wgs;
mod updater;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// ------------------------------------------------------------------ *
// Cached save + cancellation state (thread-local: the Worker is single-thread).
// ------------------------------------------------------------------ */

/// A parsed + cached save, plus the raw (still-compressed) file buffers the
/// on-demand commands (`get_world_options`, `get_map_state`) decode lazily —
/// mirroring the native commands that re-read those files from the save dir.
struct LoadedSave {
    save: pal_save::SaveData,
    /// Raw `Level.sav` (nicknames + base points for `get_map_state`).
    level_raw: Vec<u8>,
    /// Raw regular per-player saves (`_dps.sav` excluded) for `get_map_state`.
    player_raw: Vec<(String, Vec<u8>)>,
    /// Raw client `LocalData.sav` (fog + markers), if the bundle carried one.
    localdata_raw: Option<Vec<u8>>,
    /// Raw `WorldOption.sav` (egg hatch time), if the bundle carried one.
    worldoption_raw: Option<Vec<u8>>,
}

thread_local! {
    static SAVE: RefCell<Option<LoadedSave>> = const { RefCell::new(None) };
    static CANCEL_FLAGS: RefCell<HashMap<u64, Arc<AtomicBool>>> =
        RefCell::new(HashMap::new());
}

/// Register a fresh cancel flag under `token`, returning it for the solve to
/// poll (via the [`solver`] monitor).
fn register_cancel(token: u64) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    CANCEL_FLAGS.with(|m| m.borrow_mut().insert(token, flag.clone()));
    flag
}

/// Trip the cancel flag for `token`, if one is registered. Best-effort in a
/// single-threaded Worker (only observed between chunk boundaries if the engine
/// yields; the search deadline is the hard stop).
fn set_cancel(token: u64) {
    CANCEL_FLAGS.with(|m| {
        if let Some(f) = m.borrow().get(&token) {
            f.store(true, Ordering::Relaxed);
        }
    });
}

/// Drop a token's cancel flag once its solve has finished.
fn clear_cancel(token: u64) {
    CANCEL_FLAGS.with(|m| {
        m.borrow_mut().remove(&token);
    });
}

/// Force-decode the embedded game-data pack. Idempotent (`GameData::get` is a
/// `LazyLock`); safe to call before every command.
fn init_pack_inner() {
    let _ = pal_data::GameData::get();
}

// ------------------------------------------------------------------ *
// wasm-bindgen exports.
// ------------------------------------------------------------------ */

/// Load (and idempotently decode) the embedded game-data pack.
#[wasm_bindgen]
pub fn init_pack() {
    init_pack_inner();
}

/// Parse a save from in-memory file buffers and cache it as the current save.
///
/// `paths` are folder-relative (e.g. `"Level.sav"`, `"Players/ABC.sav"`,
/// `"LocalData.sav"`), tolerant of any leading directory prefix; `buffers` are
/// the matching raw (still-compressed) file bytes. Returns the same
/// `SaveSummary` JSON as the native `load_save`.
#[wasm_bindgen]
pub fn load_save_bundle(
    paths: Vec<String>,
    buffers: Vec<js_sys::Uint8Array>,
) -> Result<String, String> {
    let buffers: Vec<Vec<u8>> = buffers.iter().map(|b| b.to_vec()).collect();
    load_bundle_core(paths, buffers)
}

/// Parse a dropped WGS (Xbox / Game Pass) container store into a JSON manifest.
///
/// `paths`/`buffers` are the `containers.index` + every `container.<seq>` file
/// (store-root-relative) with their bytes. `present_paths` is every
/// store-relative path in the store — the manifest core probes each blob's
/// existence through it (no blob bytes needed) so worlds keep their Level/player
/// blobs. Returns the [`wgs::WgsManifestDto`] JSON (worlds + skip-warnings); the
/// web layer then reads each chosen world's blob files by `blob_path`, keys them
/// by `target_path`, and feeds the standard [`load_save_bundle`] path.
#[wasm_bindgen]
pub fn wgs_manifest(
    paths: Vec<String>,
    buffers: Vec<js_sys::Uint8Array>,
    present_paths: Vec<String>,
) -> Result<String, String> {
    let buffers: Vec<Vec<u8>> = buffers.iter().map(|b| b.to_vec()).collect();
    wgs::manifest_core(paths, buffers, present_paths)
}

/// Decompress a `LevelMeta.sav` blob and return its world display name, or
/// `None` when absent/corrupt/unnamed. Used to label the WGS world picker.
#[wasm_bindgen]
pub fn wgs_world_name(level_meta_sav: &[u8]) -> Option<String> {
    wgs::world_name_core(level_meta_sav)
}

/// Run a command against the cached save / pack. `args_json` is the JSON object
/// of camelCase invoke args (as the frontend sends). Returns the command result
/// as JSON, or a descriptive error string.
#[wasm_bindgen]
pub fn dispatch(cmd: String, args_json: String) -> Result<String, String> {
    init_pack_inner();
    match cmd.as_str() {
        // --- pure pack commands (no save needed) ---
        "list_species" => json(&solver::list_species()),
        "list_passives" => json(&solver::list_passives()),
        "list_breeding_boosts" => json(&solver::list_breeding_boosts()),
        "list_lab_research" => json(&solver::list_lab_research()),
        "list_active_skills" => json(&solver::list_active_skills()),
        "paldex_species" => json(&paldex::paldex_species()),
        "data_pack_info" => json(&updater::data_pack_info()),
        "paldex_species_detail" => {
            let a: IdArgs = parse(&args_json)?;
            json(&paldex::paldex_species_detail(a.id)?)
        }
        "breeding_child" => {
            let a: BreedingChildArgs = parse(&args_json)?;
            json(&paldex::breeding_child(a.parent_a, a.parent_b, a.gender_a, a.gender_b)?)
        }
        "breeding_parents" => {
            let a: ChildArgs = parse(&args_json)?;
            json(&paldex::breeding_parents(a.child)?)
        }
        "reverse_breeding" => {
            let a: SpeciesArgs = parse(&args_json)?;
            json(&paldex::reverse_breeding(a.species)?)
        }
        "dex_reachability" => {
            let a: DexArgs = parse(&args_json)?;
            json(&paldex::dex_reachability(a.owned_species)?)
        }
        // --- save-backed commands (resolve to the cached bundle) ---
        "load_save" => with_save(|l| json(&save::to_summary(&l.save))),
        "roster_counts" => with_save(|l| json(&paldex::roster_counts(&l.save))),
        "get_world_options" => {
            with_save(|l| json(&solver::get_world_options(l.worldoption_raw.as_deref())?))
        }
        "get_map_state" => with_save(|l| {
            json(&mapstate::get_map_state(&l.level_raw, &l.player_raw, l.localdata_raw.as_deref()))
        }),
        "solve" => dispatch_solve(&args_json),
        "solve_queue" => dispatch_solve_queue(&args_json),
        "cancel_solve" => {
            let a: TokenArgs = parse(&args_json)?;
            set_cancel(a.token);
            Ok("null".to_string())
        }
        // --- no faithful browser analogue ---
        "watch_save" => Err("watch_save is not supported on web".into()),
        "unwatch_save" => Err("unwatch_save is not supported on web".into()),
        "check_update" => Err("check_update is not supported on web".into()),
        other => Err(format!("unknown command: {other}")),
    }
}

/// Install the JS callback that receives `solve-progress` payloads (same shape
/// as the native Tauri event) as JSON strings.
#[wasm_bindgen]
pub fn set_progress(cb: js_sys::Function) {
    solver::set_progress_cb(cb);
}

/// Trip the cancel flag for a solve `token` (best-effort; see [`set_cancel`]).
#[wasm_bindgen]
pub fn cancel_solve_token(token: f64) {
    set_cancel(token as u64);
}

// ------------------------------------------------------------------ *
// Command helpers.
// ------------------------------------------------------------------ */

/// Serialize a command result to JSON, mapping serde errors to a string.
fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// Parse a command's camelCase arg object from JSON.
fn parse<T: DeserializeOwned>(args_json: &str) -> Result<T, String> {
    serde_json::from_str(args_json).map_err(|e| e.to_string())
}

/// Run a closure against the cached save, erroring when none is loaded.
fn with_save<F>(f: F) -> Result<String, String>
where
    F: FnOnce(&LoadedSave) -> Result<String, String>,
{
    SAVE.with(|s| match s.borrow().as_ref() {
        Some(l) => f(l),
        None => Err("no save loaded".into()),
    })
}

fn dispatch_solve(args_json: &str) -> Result<String, String> {
    let args: SolveArgs = parse(args_json)?;
    let _ = &args.save_dir; // save-dir is resolved to the cached bundle, not read
    let token = args.spec.progress_token;
    let cancel = token.map(register_cancel);
    solver::begin_progress(token.is_some(), token.unwrap_or(0), "single", None);
    let result = SAVE.with(|s| {
        let s = s.borrow();
        let l = s.as_ref().ok_or_else(|| "no save loaded".to_string())?;
        solver::run(&l.save.pals, args.spec, cancel.as_deref())
    });
    solver::end_progress();
    if let Some(t) = token {
        clear_cancel(t);
    }
    json(&result?)
}

fn dispatch_solve_queue(args_json: &str) -> Result<String, String> {
    let args: SolveQueueArgs = parse(args_json)?;
    let _ = &args.save_dir; // save-dir is resolved to the cached bundle, not read
    let token = args.items.iter().find_map(|r| r.progress_token);
    let queue_len = args.items.len() as u32;
    let cancel = token.map(register_cancel);
    solver::begin_progress(token.is_some(), token.unwrap_or(0), "queue", Some(queue_len));
    let result = SAVE.with(|s| {
        let s = s.borrow();
        let l = s.as_ref().ok_or_else(|| "no save loaded".to_string())?;
        solver::run_queue(&l.save.pals, args.items, args.stop_on_failure, cancel.as_deref())
    });
    solver::end_progress();
    if let Some(t) = token {
        clear_cancel(t);
    }
    json(&result?)
}

// ------------------------------------------------------------------ *
// Argument DTOs. Top-level command params carry Tauri's camelCase invoke keys;
// nested `spec`/`items` are `SolveRequest`s deserialized from their own (native)
// snake_case field names, exactly as the frontend sends them.
// ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
struct ChildArgs {
    child: String,
}

#[derive(Deserialize)]
struct SpeciesArgs {
    species: String,
}

#[derive(Deserialize)]
struct TokenArgs {
    token: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DexArgs {
    owned_species: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BreedingChildArgs {
    parent_a: String,
    parent_b: String,
    gender_a: Option<String>,
    gender_b: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolveArgs {
    #[allow(dead_code)]
    save_dir: String,
    spec: solver::SolveRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolveQueueArgs {
    #[allow(dead_code)]
    save_dir: String,
    items: Vec<solver::SolveRequest>,
    stop_on_failure: bool,
}

// ------------------------------------------------------------------ *
// Bundle routing: classify folder-relative save paths by filename, tolerant of
// any leading directory prefix, then parse via `pal_save::read_save_from_parts`.
// ------------------------------------------------------------------ */

/// The role of one bundle file, determined by its filename (basename).
#[derive(Debug, PartialEq, Eq)]
enum PartRole {
    Level,
    Meta,
    WorldOption,
    LocalData,
    Player,
    DpsPlayer,
    Ignored,
}

/// Classify a folder-relative (possibly prefixed) save path by its basename and
/// whether it lives under a `Players/` segment.
fn classify_part(path: &str) -> PartRole {
    let segs: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let Some(base) = segs.last().copied() else {
        return PartRole::Ignored;
    };
    match base {
        "Level.sav" => PartRole::Level,
        "LevelMeta.sav" => PartRole::Meta,
        "WorldOption.sav" => PartRole::WorldOption,
        "LocalData.sav" => PartRole::LocalData,
        _ if base.ends_with(".sav")
            && segs[..segs.len() - 1].iter().any(|s| s.eq_ignore_ascii_case("Players")) =>
        {
            if base.ends_with("_dps.sav") {
                PartRole::DpsPlayer
            } else {
                PartRole::Player
            }
        }
        _ => PartRole::Ignored,
    }
}

/// A routed bundle: raw file bytes grouped by role. `level` is required.
#[derive(Debug)]
struct RoutedBundle {
    level: Vec<u8>,
    meta: Option<Vec<u8>>,
    worldoption: Option<Vec<u8>>,
    localdata: Option<Vec<u8>>,
    players: Vec<(String, Vec<u8>)>,
    dps: Vec<(String, Vec<u8>)>,
}

/// Group `(path, bytes)` pairs by [`classify_part`]. Errors on a length mismatch
/// or a missing `Level.sav`.
fn route_bundle(paths: Vec<String>, buffers: Vec<Vec<u8>>) -> Result<RoutedBundle, String> {
    if paths.len() != buffers.len() {
        return Err(format!(
            "bundle mismatch: {} paths but {} buffers",
            paths.len(),
            buffers.len()
        ));
    }
    let mut level = None;
    let mut meta = None;
    let mut worldoption = None;
    let mut localdata = None;
    let mut players = Vec::new();
    let mut dps = Vec::new();
    for (path, bytes) in paths.into_iter().zip(buffers) {
        match classify_part(&path) {
            PartRole::Level => level.get_or_insert(bytes),
            PartRole::Meta => meta.get_or_insert(bytes),
            PartRole::WorldOption => worldoption.get_or_insert(bytes),
            PartRole::LocalData => localdata.get_or_insert(bytes),
            PartRole::Player => {
                players.push((path, bytes));
                continue;
            }
            PartRole::DpsPlayer => {
                dps.push((path, bytes));
                continue;
            }
            PartRole::Ignored => continue,
        };
    }
    let level = level.ok_or_else(|| "bundle missing Level.sav".to_string())?;
    Ok(RoutedBundle { level, meta, worldoption, localdata, players, dps })
}

/// The buffer-oriented core of [`load_save_bundle`], separated so native tests
/// can drive it without constructing `js_sys::Uint8Array`s.
fn load_bundle_core(paths: Vec<String>, buffers: Vec<Vec<u8>>) -> Result<String, String> {
    init_pack_inner();
    let routed = route_bundle(paths, buffers)?;
    let save = pal_save::read_save_from_parts(
        &routed.level,
        routed.meta.as_deref(),
        &routed.players,
        &routed.dps,
    )
    .map_err(|e| e.to_string())?;
    let summary_json = json(&save::to_summary(&save))?;
    let loaded = LoadedSave {
        save,
        level_raw: routed.level,
        player_raw: routed.players,
        localdata_raw: routed.localdata,
        worldoption_raw: routed.worldoption,
    };
    SAVE.with(|s| *s.borrow_mut() = Some(loaded));
    Ok(summary_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn save_dir() -> PathBuf {
        PathBuf::from(format!(
            "{}/../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58",
            env!("CARGO_MANIFEST_DIR")
        ))
    }

    /// Read the real testdata save into folder-relative `(paths, buffers)` the
    /// way the frontend collects a bundle (files nested under a prefix).
    fn read_bundle(dir: &Path) -> (Vec<String>, Vec<Vec<u8>>) {
        let mut paths = Vec::new();
        let mut buffers = Vec::new();
        for name in ["Level.sav", "LevelMeta.sav", "WorldOption.sav", "LocalData.sav"] {
            let p = dir.join(name);
            if let Ok(bytes) = std::fs::read(&p) {
                paths.push(name.to_string());
                buffers.push(bytes);
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir.join("Players")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("sav") {
                    continue;
                }
                let name = path.file_name().unwrap().to_str().unwrap();
                paths.push(format!("Players/{name}"));
                buffers.push(std::fs::read(&path).unwrap());
            }
        }
        (paths, buffers)
    }

    #[test]
    fn classify_part_normalizes_any_prefix_depth() {
        // Level.sav found at any nesting depth (browser may hand a prefixed path).
        assert_eq!(classify_part("Level.sav"), PartRole::Level);
        assert_eq!(classify_part("SaveGames/0/ABC123/Level.sav"), PartRole::Level);
        assert_eq!(classify_part("some\\windows\\path\\Level.sav"), PartRole::Level);
        assert_eq!(classify_part("x/y/LevelMeta.sav"), PartRole::Meta);
        assert_eq!(classify_part("a/WorldOption.sav"), PartRole::WorldOption);
        assert_eq!(classify_part("a/LocalData.sav"), PartRole::LocalData);
        // Player vs dps distinction, under a prefixed Players/ segment.
        assert_eq!(classify_part("0/HASH/Players/ABCDEF.sav"), PartRole::Player);
        assert_eq!(classify_part("Players/ABCDEF_dps.sav"), PartRole::DpsPlayer);
        // A stray .sav not under Players/ (and not a known root file) is ignored.
        assert_eq!(classify_part("random.sav"), PartRole::Ignored);
        assert_eq!(classify_part("notes.txt"), PartRole::Ignored);
    }

    #[test]
    fn route_bundle_finds_level_under_prefix_and_requires_it() {
        let routed = route_bundle(
            vec!["deep/nested/Level.sav".into(), "deep/nested/Players/p_dps.sav".into()],
            vec![vec![1, 2, 3], vec![4, 5, 6]],
        )
        .expect("Level.sav found under prefix");
        assert_eq!(routed.level, vec![1, 2, 3]);
        assert_eq!(routed.dps.len(), 1);
        assert!(routed.players.is_empty());

        let err = route_bundle(vec!["Players/p.sav".into()], vec![vec![0]]).unwrap_err();
        assert!(err.contains("missing Level.sav"), "got: {err}");

        let err = route_bundle(vec!["Level.sav".into()], vec![]).unwrap_err();
        assert!(err.contains("bundle mismatch"), "got: {err}");
    }

    #[test]
    fn dispatch_paldex_species_detail_parses_id_key() {
        let species = solver::list_species();
        let id = species.first().expect("pack has species").id.clone();
        let out =
            dispatch("paldex_species_detail".into(), format!(r#"{{"id":"{id}"}}"#)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], serde_json::Value::String(id));
        // Missing id key => a deserialize error, not a silent wrong answer.
        assert!(dispatch("paldex_species_detail".into(), "{}".into()).is_err());
    }

    #[test]
    fn dispatch_breeding_child_parses_parent_a_b_keys() {
        let species = solver::list_species();
        let a = species[0].id.clone();
        let b = species[1].id.clone();
        let out = dispatch(
            "breeding_child".into(),
            format!(r#"{{"parentA":"{a}","parentB":"{b}"}}"#),
        )
        .unwrap();
        // Parses to a ChildResult ({ "child": ... }); child may be null.
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("child").is_some(), "expected a child field: {out}");
        // snake_case keys must NOT satisfy the camelCase contract.
        assert!(dispatch(
            "breeding_child".into(),
            format!(r#"{{"parent_a":"{a}","parent_b":"{b}"}}"#)
        )
        .is_err());
    }

    #[test]
    fn dispatch_dex_reachability_parses_owned_species_key() {
        let species = solver::list_species();
        let seed = species[0].id.clone();
        let out = dispatch(
            "dex_reachability".into(),
            format!(r#"{{"ownedSpecies":["{seed}"]}}"#),
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let list = v["species"].as_array().expect("species array");
        assert!(!list.is_empty());
        // The seed species is owned (steps == 0).
        let seeded = list
            .iter()
            .find(|e| e["internal_name"] == serde_json::Value::String(seed.clone()))
            .expect("seed present in dex");
        assert_eq!(seeded["owned"], serde_json::Value::Bool(true));
        assert_eq!(seeded["steps"], serde_json::json!(0));
    }

    #[test]
    fn dispatch_watch_save_reports_unsupported_on_web() {
        let err = dispatch("watch_save".into(), "{}".into()).unwrap_err();
        assert!(err.contains("not supported on web"), "got: {err}");
        let err = dispatch("unwatch_save".into(), "{}".into()).unwrap_err();
        assert!(err.contains("not supported on web"), "got: {err}");
        let err = dispatch("check_update".into(), r#"{"currentVersion":"1.0.0"}"#.into())
            .unwrap_err();
        assert!(err.contains("not supported on web"), "got: {err}");
    }

    #[test]
    fn load_bundle_then_roster_counts_round_trip() {
        let dir = save_dir();
        if !dir.join("Level.sav").exists() {
            // Gitignored testdata absent in this checkout; skip rather than fail.
            eprintln!("testdata save1 absent; skipping round-trip");
            return;
        }
        let (paths, buffers) = read_bundle(&dir);
        let summary_json = load_bundle_core(paths, buffers).expect("bundle parses");
        let summary: serde_json::Value = serde_json::from_str(&summary_json).unwrap();
        // The known co-op fixture invariant: 1669 pals classified from the bytes.
        assert_eq!(summary["pals"].as_array().unwrap().len(), 1669);

        // roster_counts over the cached save, dispatched by command string.
        let roster_json = dispatch("roster_counts".into(), "{}".into()).unwrap();
        let roster: HashMap<String, serde_json::Value> =
            serde_json::from_str(&roster_json).unwrap();
        assert!(!roster.is_empty(), "roster must not be empty");
        let gendered: u64 = roster
            .values()
            .map(|c| c["male"].as_u64().unwrap() + c["female"].as_u64().unwrap())
            .sum();
        // Most of the 1669 pals are gendered; be generous but non-trivial.
        assert!(gendered > 1000, "gendered tally too low: {gendered}");

        // load_save via dispatch re-summarizes the cached bundle identically.
        let redispatched = dispatch("load_save".into(), r#"{"saveDir":"ignored"}"#.into()).unwrap();
        assert_eq!(redispatched, summary_json);
    }
}
