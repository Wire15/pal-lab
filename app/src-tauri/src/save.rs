//! Frontend-facing save summary + the `load_save` command.
//!
//! `load_save` reads a real Palworld save directory via `pal_save` and maps its
//! [`pal_save::SaveData`] into a [`SaveSummary`]. `SaveSummary.pals` is
//! `Vec<pal_data::OwnedPal>` serialized with its default serde derive, so the
//! JSON shape matches `crates/pal-data/src/types.rs` exactly.

use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use parking_lot::Mutex;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use pal_data::types::{Guid, OwnedPal};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// A player entry, keyed by a display-formatted GUID string.
#[derive(Debug, Clone, Serialize)]
pub struct PlayerRef {
    pub uid: String,
    pub name: String,
}

/// A guild-owned base camp, mapped to its worker pal-container and the guild's
/// member players. GUIDs are lowercase 32-char hex strings, matching
/// [`PlayerRef::uid`] and the hex form of [`pal_data::types::OwnedPal`]'s
/// `container_id`, so the UI can join bases to pals and player tabs directly.
#[derive(Debug, Clone, Serialize)]
pub struct BaseRef {
    pub container_id: String,
    pub guild_id: String,
    pub guild_name: String,
    pub member_uids: Vec<String>,
}

/// Everything the Save Inspector view needs from one loaded world.
#[derive(Debug, Clone, Serialize)]
pub struct SaveSummary {
    pub world_name: String,
    pub players: Vec<PlayerRef>,
    pub pals: Vec<OwnedPal>,
    /// Guild-owned base camps mapped to worker containers + member players.
    pub bases: Vec<BaseRef>,
    /// Non-fatal parser warnings (skipped entities, unreadable sub-saves).
    pub warnings: Vec<String>,
}

/// Format a GUID as the lowercase 32-char hex string the UI expects.
pub(crate) fn guid_str(g: &Guid) -> String {
    g.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

/// Map a parsed [`pal_save::SaveData`] into the frontend summary shape.
fn to_summary(save: pal_save::SaveData) -> SaveSummary {
    SaveSummary {
        world_name: save.world_name.unwrap_or_else(|| "Unknown World".into()),
        players: save
            .players
            .iter()
            .map(|p| PlayerRef {
                uid: guid_str(&p.uid),
                name: p.name.clone(),
            })
            .collect(),
        bases: save
            .bases
            .iter()
            .map(|b| BaseRef {
                container_id: guid_str(&b.container_id),
                guild_id: guid_str(&b.guild_id),
                guild_name: b.guild_name.clone(),
                member_uids: b.member_uids.iter().map(guid_str).collect(),
            })
            .collect(),
        pals: save.pals,
        warnings: save.warnings,
    }
}

/// Load a save from `save_dir` and summarize it for the UI. Read-only.
#[tauri::command]
pub fn load_save(save_dir: String) -> Result<SaveSummary, String> {
    if save_dir.trim().is_empty() {
        return Err("No save folder selected.".into());
    }
    let save = pal_save::read_save_dir(Path::new(&save_dir)).map_err(|e| e.to_string())?;
    Ok(to_summary(save))
}

/// Debounce window: coalesce a burst of save writes into one reload. Palworld
/// rewrites `Level.sav` and per-player sub-saves in quick succession, so we wait
/// for the writes to settle before telling the UI to re-read.
const DEBOUNCE: Duration = Duration::from_millis(2000);

/// Managed handle to the live filesystem watcher, or `None` when not watching.
///
/// Dropping the [`RecommendedWatcher`] stops watching AND drops the event
/// sender it owns, so the debounce thread's channel disconnects and the thread
/// exits. Replacing the value on a repeat `watch_save` therefore leaks neither
/// a watcher nor a thread.
#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

/// Payload for the `save-changed` event emitted after a debounced write burst.
#[derive(Clone, Serialize)]
struct SaveChanged {
    save_dir: String,
}

/// Build a watcher over a save dir's `Level.sav` (+ `Players/`) that calls
/// `on_change` once per settled write burst (debounced by `debounce`).
///
/// Factored out of [`watch_save`] so tests can drive it with a plain callback
/// instead of a live `AppHandle`. The returned watcher owns the whole pipeline;
/// dropping it stops the watch and ends the debounce thread.
fn spawn_watcher<F>(
    base: &Path,
    debounce: Duration,
    on_change: F,
) -> notify::Result<RecommendedWatcher>
where
    F: Fn() + Send + 'static,
{
    let (tx, rx) = channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(
                ev.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            ) {
                // A closed receiver just means the watcher is being torn down.
                let _ = tx.send(());
            }
        }
    })?;

    let level = base.join("Level.sav");
    let players = base.join("Players");
    let mut watched_any = false;
    if level.exists() {
        watcher.watch(&level, RecursiveMode::NonRecursive)?;
        watched_any = true;
    }
    if players.is_dir() {
        watcher.watch(&players, RecursiveMode::Recursive)?;
        watched_any = true;
    }
    // Neither exists yet (fresh dir / mid-write): fall back to the dir itself so
    // the first `Level.sav` create still fires.
    if !watched_any {
        watcher.watch(base, RecursiveMode::NonRecursive)?;
    }

    // Debounce thread: after the first event, keep resetting a `debounce` window
    // until writes stop, then fire once. Exits when the channel disconnects
    // (watcher dropped).
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(debounce) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            on_change();
        }
    });

    Ok(watcher)
}

/// Start (or replace) a debounced filesystem watch on `save_dir`. On each
/// settled write burst it emits the `save-changed` event with `{ save_dir }` so
/// the frontend can silently reload. Repeat calls replace the previous watcher
/// cleanly (no leak).
#[tauri::command]
pub fn watch_save(
    save_dir: String,
    app: AppHandle,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let dir = save_dir.trim();
    if dir.is_empty() {
        return Err("No save folder to watch.".into());
    }
    let emit_dir = dir.to_string();
    let watcher = spawn_watcher(Path::new(dir), DEBOUNCE, move || {
        let _ = app.emit(
            "save-changed",
            SaveChanged {
                save_dir: emit_dir.clone(),
            },
        );
    })
    .map_err(|e| e.to_string())?;

    // Assigning drops the old watcher first (stops it, ends its thread).
    *state.0.lock() = Some(watcher);
    Ok(())
}

/// Stop watching the current save, if any. Idempotent.
#[tauri::command]
pub fn unwatch_save(state: State<'_, WatcherState>) -> Result<(), String> {
    *state.0.lock() = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn testdata_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58")
    }

    #[test]
    fn maps_real_save_into_summary() {
        let save = pal_save::read_save_dir(testdata_dir()).expect("read save dir");
        let summary = to_summary(save);

        assert_eq!(summary.world_name.is_empty(), false, "world name empty");
        assert_eq!(summary.players.len(), 4, "expected 4 players");
        assert!(
            summary.pals.len() > 1500,
            "expected a large roster, got {}",
            summary.pals.len()
        );

        // Every player uid is a 32-char lowercase hex string.
        for p in &summary.players {
            assert_eq!(p.uid.len(), 32, "uid not 32 hex chars: {}", p.uid);
            assert!(
                p.uid.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "uid not lowercase hex: {}",
                p.uid
            );
            assert!(!p.name.is_empty(), "player name empty");
        }

        // Dimensional storage really merged (the classification gap this closes).
        let dimensional = summary
            .pals
            .iter()
            .filter(|p| {
                matches!(
                    p.container_kind,
                    pal_data::types::ContainerKind::DimensionalPalStorage
                )
            })
            .count();
        assert!(dimensional > 0, "no dimensional-storage pals in summary");
    }

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Unique scratch dir under the OS temp root (no `tempfile` dep needed).
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "pal-calc-watch-{}-{}-{}",
            tag,
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn touch(path: &Path, contents: &str) {
        std::fs::write(path, contents).expect("write file");
    }

    /// A rapid burst of writes coalesces into exactly one `on_change`, and a
    /// later write fires a second — proving the 2s (here shortened) debounce.
    #[test]
    fn debounce_coalesces_burst() {
        let dir = scratch_dir("debounce");
        let level = dir.join("Level.sav");
        touch(&level, "0");

        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let debounce = Duration::from_millis(400);
        let _watcher = spawn_watcher(&dir, debounce, move || {
            h.fetch_add(1, Ordering::SeqCst);
        })
        .expect("spawn watcher");
        std::thread::sleep(Duration::from_millis(250)); // let the watch arm.

        // Burst: five writes well inside one debounce window.
        for i in 0..5 {
            touch(&level, &format!("burst-{i}"));
            std::thread::sleep(Duration::from_millis(30));
        }
        std::thread::sleep(Duration::from_millis(900)); // window elapses + fire.
        assert_eq!(hits.load(Ordering::SeqCst), 1, "burst should coalesce to one");

        // A separate write later fires again.
        touch(&level, "second");
        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(hits.load(Ordering::SeqCst), 2, "later write should re-fire");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Dropping a watcher (as a repeat `watch_save`/`unwatch_save` does) stops
    /// it: no further callbacks fire, and a fresh watcher over the same dir
    /// works — i.e. replacing leaks neither watcher nor thread.
    #[test]
    fn dropping_watcher_stops_it() {
        let dir = scratch_dir("replace");
        let level = dir.join("Level.sav");
        touch(&level, "0");
        let debounce = Duration::from_millis(300);

        // Watcher A, then dropped (simulating replacement).
        let a_hits = Arc::new(AtomicUsize::new(0));
        {
            let h = a_hits.clone();
            let _a = spawn_watcher(&dir, debounce, move || {
                h.fetch_add(1, Ordering::SeqCst);
            })
            .expect("spawn A");
            std::thread::sleep(Duration::from_millis(250));
        } // `_a` dropped here.
        std::thread::sleep(Duration::from_millis(100));

        // Writes after the drop must not reach A.
        touch(&level, "after-drop");
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(a_hits.load(Ordering::SeqCst), 0, "dropped watcher still firing");

        // Watcher B over the same dir still works.
        let b_hits = Arc::new(AtomicUsize::new(0));
        let h = b_hits.clone();
        let _b = spawn_watcher(&dir, debounce, move || {
            h.fetch_add(1, Ordering::SeqCst);
        })
        .expect("spawn B");
        std::thread::sleep(Duration::from_millis(250));
        touch(&level, "for-b");
        std::thread::sleep(Duration::from_millis(700));
        assert!(b_hits.load(Ordering::SeqCst) >= 1, "replacement watcher never fired");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
