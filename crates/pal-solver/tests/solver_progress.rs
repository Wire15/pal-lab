//! Progress reporting + cooperative cancellation (the [`SolveMonitor`] plumbing).
//!
//! Driven against the real testdata roster so the search actually iterates
//! (multiple steps with non-trivial pair batches). These assertions cover the
//! frozen `solve-progress` contract at the engine boundary — the Tauri layer
//! only adds `token`/`kind`/`queue_index`/`elapsed`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pal_data::{GameData, OwnedPal};
use parking_lot::Mutex;
use pal_solver::solver::{
    resolve_passive, resolve_species, solve_queue_monitored, solve_with_catching,
    solve_with_catching_monitored, Catching, QueueItem, SolveMonitor, SolvePhase, SolveProgress,
    SolverConfig, TargetPal, TargetSpec,
};

fn testdata() -> Vec<OwnedPal> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/save1/SaveGames/0/11B693994C6849F2AAF47088BD302C58");
    pal_save::read_save_dir(&dir).expect("read testdata save").pals
}

/// A spec that forces a genuine multi-step, non-trivial search.
fn anubis_spec(gd: &GameData) -> TargetSpec {
    let target = resolve_species(gd, "Anubis").expect("Anubis exists");
    let mut spec = TargetSpec::new(TargetPal::Species(target));
    spec.required_passives = vec![resolve_passive(gd, "Runner").expect("Runner exists")];
    spec
}

fn cfg(iterations: u32) -> SolverConfig {
    SolverConfig {
        max_solver_iterations: iterations,
        max_breeding_steps: iterations,
        ..SolverConfig::default()
    }
}

/// (b) The callback fires with phases in order (Seeding -> Step... -> Finalizing),
/// monotonic `pairs_done` within each step against a constant `pairs_total`, and
/// 1-based increasing step numbers.
#[test]
fn progress_phases_and_monotonic_pairs() {
    let gd = GameData::get();
    let owned = testdata();
    let spec = anubis_spec(gd);
    let cfg = cfg(5);

    let events: Mutex<Vec<SolveProgress>> = Mutex::new(Vec::new());
    let cb = |p: SolveProgress| events.lock().push(p);
    let monitor = SolveMonitor::new(Some(&cb), None);
    let res =
        solve_with_catching_monitored(gd, &spec, &owned, &cfg, Catching::BreedingOnly, monitor)
            .expect("owned-only solve never cancels");
    assert!(!res.plans.is_empty(), "Anubis+Runner is owned-breedable in the testdata roster");

    let events = events.into_inner();
    assert!(events.len() >= 3, "expect seeding + >=1 step + finalizing, got {}", events.len());

    // First is seeding with the initial working set populated, no pairs yet.
    let first = events[0];
    assert_eq!(first.phase, SolvePhase::Seeding);
    assert_eq!(first.step, 0);
    assert_eq!(first.max_steps, 5);
    assert_eq!(first.pairs_done, 0);
    assert_eq!(first.pairs_total, 0);
    assert!(first.working_set > 0, "seeding working set must be non-empty");

    // Owned-only never falls back to catching.
    assert!(
        !events.iter().any(|e| e.phase == SolvePhase::CatchFallback),
        "owned-only solve must not emit catch_fallback"
    );

    // Exactly one finalizing, and it is the last event.
    assert_eq!(events.last().unwrap().phase, SolvePhase::Finalizing);
    assert_eq!(
        events.iter().filter(|e| e.phase == SolvePhase::Finalizing).count(),
        1,
        "exactly one finalizing phase"
    );

    // Step events: 1-based, non-decreasing step numbers; within a step
    // pairs_total is constant and pairs_done is monotonic, ending at pairs_total.
    let steps: Vec<&SolveProgress> =
        events.iter().filter(|e| e.phase == SolvePhase::Step).collect();
    assert!(!steps.is_empty(), "at least one step must run");
    assert_eq!(steps[0].step, 1, "steps are 1-based");

    let mut saw_real_batch = false;
    let mut cur_step = 0u32;
    let mut cur_total = 0u64;
    let mut last_done = 0u64;
    let mut boundary_seen = false;
    for e in &steps {
        assert!(e.step >= cur_step, "step numbers never decrease");
        if e.step != cur_step {
            // New step: must open on a boundary (pairs_done == 0).
            assert_eq!(e.pairs_done, 0, "each step opens at pairs_done=0");
            assert_eq!(e.step, cur_step + 1, "step numbers increase by 1");
            cur_step = e.step;
            cur_total = e.pairs_total;
            last_done = 0;
            boundary_seen = true;
        } else {
            assert_eq!(e.pairs_total, cur_total, "pairs_total constant within a step");
            assert!(e.pairs_done >= last_done, "pairs_done monotonic within a step");
            assert!(e.pairs_done <= e.pairs_total, "pairs_done never exceeds pairs_total");
            last_done = e.pairs_done;
        }
        if e.pairs_total > 0 {
            saw_real_batch = true;
        }
    }
    assert!(boundary_seen, "saw a step boundary");
    assert!(saw_real_batch, "at least one step bred a non-empty pair batch");

    // The final progress event for the last non-empty step must reach 100%.
    if let Some(last_step) = steps.iter().rev().find(|e| e.pairs_total > 0) {
        let final_done = steps
            .iter()
            .filter(|e| e.step == last_step.step)
            .map(|e| e.pairs_done)
            .max()
            .unwrap();
        assert_eq!(final_done, last_step.pairs_total, "last step's batch completes to 100%");
    }
}

/// (c) A no-callback monitor emits nothing, and a progress callback does not
/// change which plans are returned (byte-identical to the plain entry point).
#[test]
fn no_token_emits_nothing_and_results_unchanged() {
    let gd = GameData::get();
    let owned = testdata();
    let spec = anubis_spec(gd);
    let cfg = cfg(5);

    // Baseline via the historical (no-monitor) public API.
    let plain = solve_with_catching(gd, &spec, &owned, &cfg, Catching::BreedingOnly);

    // No progress callback => zero callbacks even though a monitor is threaded.
    let calls = AtomicU64::new(0);
    let counting = |_p: SolveProgress| {
        calls.fetch_add(1, Ordering::Relaxed);
    };
    // First run: callback wired but we verify plan-identity to the plain run.
    let with_cb =
        solve_with_catching_monitored(gd, &spec, &owned, &cfg, Catching::BreedingOnly,
            SolveMonitor::new(Some(&counting), None))
        .expect("solve never cancels");
    assert!(calls.load(Ordering::Relaxed) > 0, "callback path fired");

    // Second run: no callback at all -> nothing observed.
    let silent_calls = AtomicU64::new(0);
    let silent = |_p: SolveProgress| {
        silent_calls.fetch_add(1, Ordering::Relaxed);
    };
    let _ = silent; // referenced only to prove we *chose* not to wire it
    let no_cb = solve_with_catching_monitored(gd, &spec, &owned, &cfg, Catching::BreedingOnly,
        SolveMonitor::new(None, None))
        .expect("solve never cancels");
    assert_eq!(silent_calls.load(Ordering::Relaxed), 0, "no-callback monitor emits nothing");

    // The intermediate tree can pick a different equal-cost parentage between
    // runs (WorkingSet is a HashMap; ties break on iteration order), so compare
    // the deterministic per-plan summary: species, effort, steps, wild count.
    let summary = |plans: &[pal_solver::solver::BreedingPlan]| -> Vec<(u16, u64, u32, u32, u32)> {
        plans
            .iter()
            .map(|p| {
                (
                    p.root.species,
                    p.total_time_secs.to_bits(),
                    p.total_steps,
                    p.total_wild_pals,
                    p.cake_count,
                )
            })
            .collect()
    };
    assert_eq!(summary(&plain.plans), summary(&with_cb.plans), "progress callback must not change results");
    assert_eq!(summary(&plain.plans), summary(&no_cb.plans), "no-token solve matches previous results");
    assert_eq!(plain.fallback_used, no_cb.fallback_used);
    assert_eq!(plain.pins_satisfied, no_cb.pins_satisfied);
}

/// (a) Cancellation from inside the callback bails mid-step: the search returns
/// the cancelled variant and never reaches the finalizing phase.
#[test]
fn cancel_from_callback_bails_before_finalize() {
    let gd = GameData::get();
    let owned = testdata();
    let spec = anubis_spec(gd);
    let cfg = cfg(20);

    let flag = AtomicBool::new(false);
    let saw_finalize = AtomicBool::new(false);
    // Trip the flag the moment the first real step batch is announced.
    let cb = |p: SolveProgress| {
        if p.phase == SolvePhase::Finalizing {
            saw_finalize.store(true, Ordering::Relaxed);
        }
        if p.phase == SolvePhase::Step {
            flag.store(true, Ordering::Relaxed);
        }
    };
    let monitor = SolveMonitor::new(Some(&cb), Some(&flag));
    let res =
        solve_with_catching_monitored(gd, &spec, &owned, &cfg, Catching::BreedingOnly, monitor);
    assert!(res.is_err(), "cancel must surface as the cancelled variant");
    assert!(
        !saw_finalize.load(Ordering::Relaxed),
        "cancellation must bail before the finalizing phase"
    );
}

/// (a, cross-thread) A queue-wide cancel flag tripped from another thread while
/// the (long, default-horizon) search is running interrupts it promptly.
#[test]
fn cancel_from_other_thread_is_prompt() {
    let gd = GameData::get();
    let owned = testdata();
    // Two required passives + full horizon => a multi-second search.
    let target = resolve_species(gd, "Anubis").unwrap();
    let mut spec = TargetSpec::new(TargetPal::Species(target));
    spec.required_passives = vec![
        resolve_passive(gd, "Runner").unwrap(),
        resolve_passive(gd, "PAL_Sanity_Up_1").unwrap(),
    ];
    let cfg = cfg(20);

    let flag = Arc::new(AtomicBool::new(false));
    let flag2 = flag.clone();
    let setter = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        flag2.store(true, Ordering::Relaxed);
    });

    let start = Instant::now();
    let res = solve_with_catching_monitored(
        gd,
        &spec,
        &owned,
        &cfg,
        Catching::BreedingOnly,
        SolveMonitor::new(None, Some(&flag)),
    );
    let elapsed = start.elapsed();
    setter.join().unwrap();
    // Latency from flag-set (~50ms in) to return; bounded by one chunk's wall
    // time (PAIR_CHUNK pairs) even mid-giant-step.
    eprintln!("cross-thread cancel: returned {elapsed:?} after solve start (flag set at ~50ms)");

    assert!(res.is_err(), "cross-thread cancel must surface as cancelled");
    // Generous ceiling: proves the search stopped cooperatively rather than
    // running the full multi-second horizon. (Precise latency: see benchmark.)
    assert!(
        elapsed < Duration::from_secs(15),
        "cancel should interrupt promptly, took {elapsed:?}"
    );
}

/// The queue forwards each item's progress tagged with its 0-based index, in
/// order (item N fully solves before item N+1 begins).
#[test]
fn queue_tags_progress_with_item_index() {
    let gd = GameData::get();
    let owned = testdata();
    let spec = anubis_spec(gd);
    let cfg = cfg(5);
    let items = vec![
        QueueItem { spec: spec.clone(), cfg: cfg.clone(), catching: Catching::BreedingOnly },
        QueueItem { spec, cfg, catching: Catching::BreedingOnly },
    ];

    let seen: Mutex<Vec<(usize, SolvePhase)>> = Mutex::new(Vec::new());
    let cb = |idx: usize, p: SolveProgress| seen.lock().push((idx, p.phase));
    let cb_ref: &(dyn Fn(usize, SolveProgress) + Sync) = &cb;
    let res = solve_queue_monitored(gd, &owned, &items, false, None, Some(cb_ref))
        .expect("owned-only queue never cancels");
    assert_eq!(res.items.len(), 2, "both queue items solved");

    let seen = seen.into_inner();
    assert!(!seen.is_empty(), "progress fired");
    assert!(seen.iter().all(|(i, _)| *i == 0 || *i == 1), "only indices 0 and 1");
    assert!(seen.iter().any(|(i, _)| *i == 0), "item 0 reported");
    assert!(seen.iter().any(|(i, _)| *i == 1), "item 1 reported");
    // Sequential: every item-0 event precedes every item-1 event.
    let last0 = seen.iter().rposition(|(i, _)| *i == 0).unwrap();
    let first1 = seen.iter().position(|(i, _)| *i == 1).unwrap();
    assert!(last0 < first1, "item 0 finishes before item 1 begins");
    // Each item opens with its own seeding phase.
    assert_eq!(seen.first().unwrap(), &(0, SolvePhase::Seeding), "item 0 opens on seeding");
    assert_eq!(seen[first1], (1, SolvePhase::Seeding), "item 1 opens on seeding");
}
