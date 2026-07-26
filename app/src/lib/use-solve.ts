// Shared solve lifecycle for the Solver and IV Lab views. Both fire the same
// `solve` backend command and render the same PlanGraph/PlanNodePanel; only the
// briefing (and thus which SolveRequest fields ride along) differs. This hook
// owns everything the two views had duplicated:
//   - the species list + `nameToId` lookup (from `list_species`)
//   - the plans / activePlan / node-selection lifecycle (+ resets)
//   - save-switch invalidation, so save B never renders save A's plans
//   - the global Escape handler that closes the node inspector
//   - request assembly: it injects the shared `setup`/`cake` from
//     `useBreedingSetup`, so the caller only supplies the per-view field set
//   - the `fastestIdx` marker
//
// Per-view field sets are preserved by the caller passing a partial spec: the
// Solver sends `{ include_wild, catching }`, the IV Lab `{ ivs, iv_model }`.
// Neither view should send fields it doesn't own (the Solver never sends IV
// fields), so the hook merges verbatim — `{ ...spec, setup, cake }`.

import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke, isFixtureMode, devListenProgress } from "./tauri";
import type {
  BreedingPlan,
  NamedEntry,
  NoPathReason,
  QueueResponse,
  SolveProgressEvent,
  SolveRequest,
  SolveResponse,
} from "./types";
import { useAppState, useBreedingSetup } from "../state";
import type { PlanNodeSelection } from "../components/plan-node-panel";

/** A caller-supplied solve spec: everything except the shared `setup`/`cake`,
 * which the hook injects from `useBreedingSetup`. The Solver passes
 * `include_wild`/`catching`; the IV Lab passes `ivs`/`iv_model`. */
export type SolveSpec = Omit<SolveRequest, "setup" | "cake">;

/** A selected plan-graph node (id + panel payload), or none. */
export interface NodeSelection {
  nodeId: string;
  data: PlanNodeSelection;
}

/** Inverse of `hexGuid` (components/palbox/selectors): a lowercase 32-char
 * player-uid hex -> the 16-byte array serde shape the backend expects for
 * `SolveRequest.player_uid`. */
function hexToGuid(hex: string): number[] {
  const out = new Array<number>(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Saved-plan metadata surfaced after a rehydrate, driving the "roster may have
 *  changed" staleness banner. Null while the result came from a live solve. */
export interface RestoredInfo {
  name: string;
  /** Epoch-ms the plan was saved (rendered as the banner's SAVED date). */
  created: number;
  /** Save folder the plan was solved against (may differ from the live save). */
  saveDir: string;
}

/** Everything `rehydrate` needs: the frozen request/response the plan was solved
 *  with, the active plan index to restore, plus the {@link RestoredInfo} meta. */
export interface RestoredPlan extends RestoredInfo {
  request: SolveRequest;
  response: SolveResponse;
  activePlan: number;
}

/** What a live {@link UseSolve.solve} returns on completion: the exact frozen
 *  request (shared setup/cake/player_uid baked in) and the response. Null when
 *  the solve errored or was cancelled. Lets the caller snapshot the session /
 *  push a history entry without re-deriving the request. */
export interface SolveOutcome {
  request: SolveRequest;
  response: SolveResponse;
}

export interface UseSolve {
  /** Full species list from `list_species` (drives the datalist). */
  speciesList: NamedEntry[];
  /** Species name -> internal id, for plan-tree/catch lookups. */
  nameToId: Map<string, string>;
  /** Ranked plans from the last solve, or null before the first solve. */
  plans: BreedingPlan[] | null;
  /** Whether a `breeding_only` solve fell back to catch-assisted plans. */
  fallbackUsed: boolean;
  /** Structured no-path reasons from the last single solve (priority order).
   *  Empty unless the solve returned zero plans. */
  diagnosis: NoPathReason[];
  /** Whether the last single solve's `pinned_parents` constraint held. `false`
   *  (with empty `plans`) means pinning eliminated every otherwise-valid plan;
   *  defaults `true` (no pins, or a pinned plan survived). */
  pinsSatisfied: boolean;
  /** Last solve error string, or null. */
  error: string | null;
  /** True while a solve is in flight. */
  solving: boolean;
  /** Latest `solve-progress` event for the in-flight solve/queue (filtered to
   *  the current generation's token), or null when idle. Drives the panel. */
  progress: SolveProgressEvent | null;
  /** True when the last solve/queue was aborted via {@link cancel} (backend
   *  resolved `Err("cancelled")`); cleared when the next solve starts. */
  cancelled: boolean;
  /** Cancel the in-flight solve/queue by its token; a no-op when idle. The
   *  pending solve then resolves via the cancelled path (no error). */
  cancel: () => void;
  /** Index of the active plan tab. */
  activePlan: number;
  setActivePlan: (i: number) => void;
  /** The selected plan-graph node (inspector), or null. */
  selection: NodeSelection | null;
  setSelection: (s: NodeSelection | null) => void;
  /** Index of the fastest plan (by total time) when >1 plan, else -1. */
  fastestIdx: number;
  /** The full SolveRequest of the last solve/rehydrate (shared setup/cake baked
   *  in), or null before the first result — the exact shape save/export encode. */
  lastRequest: SolveRequest | null;
  /** Saved-plan meta when the current result was restored from a saved plan
   *  (not a live solve); null for live results. Drives the staleness banner. */
  restoredFrom: RestoredInfo | null;
  /** Restore a saved plan's plans/activePlan into the view exactly as a live
   *  solve would, flagging the source so the header shows the staleness banner. */
  rehydrate: (saved: RestoredPlan) => void;
  /** Restore a persisted solve session (navigation / solve-history restore) into
   *  the view WITHOUT the staleness banner — same-session/same-save replay, not a
   *  stale saved plan. Clears `restoredFrom`. */
  restoreSession: (s: {
    request: SolveRequest;
    response: SolveResponse;
    activePlan: number;
  }) => void;
  /** Run a solve for `spec`; the hook injects the shared setup/cake. Resolves to
   *  the frozen request + response on completion, or null on error/cancel. */
  solve: (spec: SolveSpec) => Promise<SolveOutcome | null>;
  /** Queue-solve result (one entry per target, seeded left-to-right), or null
   *  when not in queue mode. Non-null flips the Solver to its queue view. */
  queueResult: QueueResponse | null;
  /** True while a `solve_queue` batch is in flight. */
  queueSolving: boolean;
  /** Last queue-solve error string, or null. */
  queueError: string | null;
  /** Solve a queue of specs sequentially (setup/cake injected per item at solve
   *  time). Leaves the single-solve state untouched. */
  solveQueue: (items: SolveSpec[]) => Promise<void>;
  /** Drop the queue result (back to the single-solve view). */
  clearQueue: () => void;
  /** Clear the whole result set (plans, queue result, restored/error meta) —
   *  the results half of the Solver's RESET. Form fields live in the view. */
  reset: () => void;
}

export function useSolve(): UseSolve {
  const { saveDir, playerScope } = useAppState();
  const { setup, cake } = useBreedingSetup();

  const [speciesList, setSpeciesList] = useState<NamedEntry[]>([]);
  const [plans, setPlans] = useState<BreedingPlan[] | null>(null);
  const [fallbackUsed, setFallbackUsed] = useState(false);
  const [diagnosis, setDiagnosis] = useState<NoPathReason[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [activePlan, setActivePlan] = useState(0);
  const [selection, setSelection] = useState<NodeSelection | null>(null);
  const [lastRequest, setLastRequest] = useState<SolveRequest | null>(null);
  const [restoredFrom, setRestoredFrom] = useState<RestoredInfo | null>(null);
  const [pinsSatisfied, setPinsSatisfied] = useState(true);
  const [queueResult, setQueueResult] = useState<QueueResponse | null>(null);
  const [queueSolving, setQueueSolving] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SolveProgressEvent | null>(null);
  const [cancelled, setCancelled] = useState(false);
  // Monotonic generation token per solve/queue. Rides the request as
  // `progress_token`, tags every emitted event, and is the cancel handle. The
  // ref holds the live generation so `cancel()` targets the current run only.
  const nextTokenRef = useRef(Date.now());
  const activeTokenRef = useRef<number | null>(null);
  // A rehydrate wants to land on the saved active-plan index, but setting `plans`
  // fires the reset-to-0 effect below. This ref carries the desired index across
  // that render so the restored tab survives; null means "default to 0".
  const pendingActivePlan = useRef<number | null>(null);

  useEffect(() => {
    invoke<NamedEntry[]>("list_species").then(setSpeciesList).catch(() => {});
  }, []);

  // Clear the whole result set (plans, queue, restored/error meta). Shared by
  // the save-switch invalidation below and the Solver's RESET affordance. Does
  // NOT touch the in-flight generation — a solve owns its own lifecycle.
  function resetResults() {
    setPlans(null);
    setActivePlan(0);
    setSelection(null);
    setError(null);
    setCancelled(false);
    setFallbackUsed(false);
    setDiagnosis([]);
    setLastRequest(null);
    setRestoredFrom(null);
    setPinsSatisfied(true);
    setQueueResult(null);
    setQueueError(null);
  }

  // Switching saves invalidates a solve: last save's plans, owned tags and
  // donor kin no longer apply, so clear the whole result before save B renders.
  useEffect(() => {
    resetResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveDir]);

  // A fresh result resets to the first plan; switching plans (or a new result)
  // clears any node selection, since node ids are per-plan-render path ids.
  useEffect(() => {
    setActivePlan(pendingActivePlan.current ?? 0);
    pendingActivePlan.current = null;
  }, [plans]);
  useEffect(() => {
    setSelection(null);
  }, [activePlan, plans]);

  // Escape clears the current node selection (closes the inspector panel).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelection(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nameToId = useMemo(
    () => new Map(speciesList.map((s) => [s.name, s.id])),
    [speciesList],
  );

  const fastestIdx = useMemo(
    () =>
      plans && plans.length > 1
        ? plans.reduce(
            (best, p, idx, arr) =>
              p.total_time_secs < arr[best].total_time_secs ? idx : best,
            0,
          )
        : -1,
    [plans],
  );

  /** Mint the next generation token for a solve/queue run. */
  function nextToken(): number {
    nextTokenRef.current += 1;
    return nextTokenRef.current;
  }

  /** True when a rejection is the backend's `Err("cancelled")` (or the dev
   *  simulator's `Error("cancelled")`) — the quiet return-to-idle path. */
  function isCancelled(e: unknown): boolean {
    return String(e instanceof Error ? e.message : e).includes("cancelled");
  }

  /** Subscribe to `solve-progress` for `token`, dropping stale-generation
   *  events. Real mode listens on the Tauri event; fixture mode taps the dev
   *  simulator. Returns an unlisten fn to call on settle. */
  async function subscribeProgress(
    token: number,
    onEvent: (e: SolveProgressEvent) => void,
  ): Promise<() => void> {
    if (isFixtureMode()) {
      return devListenProgress((p) => {
        const ev = p as unknown as SolveProgressEvent;
        if (ev.token === token) onEvent(ev);
      });
    }
    const unlisten: UnlistenFn = await listen<SolveProgressEvent>(
      "solve-progress",
      (e) => {
        if (e.payload.token === token) onEvent(e.payload);
      },
    );
    return unlisten;
  }

  /** Cancel the live solve/queue by its token; no-op when idle. */
  function cancel() {
    const token = activeTokenRef.current;
    if (token === null) return;
    invoke("cancel_solve", { token }).catch(() => {});
  }

  async function solve(spec: SolveSpec) {
    const token = nextToken();
    activeTokenRef.current = token;
    setSolving(true);
    setError(null);
    setCancelled(false);
    setProgress(null);
    setPlans(null);
    setFallbackUsed(false);
    setDiagnosis([]);
    setRestoredFrom(null);
    setPinsSatisfied(true);
    // A single solve exits the queue view (they share the one results pane).
    setQueueResult(null);
    setQueueError(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await subscribeProgress(token, setProgress);
      // `setup`/`cake` ride the shared BREEDING SETUP store (contract #3);
      // `player_uid` rides the app-wide player scope (contract: single injection
      // point) so the backend filters the owned pool before solving. The caller
      // owns everything else, so per-view field sets stay intact. The ephemeral
      // `progress_token` rides the wire request only — never `lastRequest`,
      // which save/export/plan-code encode.
      const full: SolveRequest = {
        ...spec,
        setup,
        cake,
        ...(playerScope !== "all" ? { player_uid: hexToGuid(playerScope) } : {}),
      };
      setLastRequest(full);
      const resp = await invoke<SolveResponse>("solve", {
        saveDir,
        spec: { ...full, progress_token: token },
      });
      setPlans(resp.plans);
      setFallbackUsed(resp.fallback_used);
      setDiagnosis(resp.diagnosis ?? []);
      // Serde-defaults to `true` for responses predating the pin field.
      setPinsSatisfied(resp.pins_satisfied ?? true);
      return { request: full, response: resp };
    } catch (e) {
      if (isCancelled(e)) setCancelled(true);
      else setError(String(e));
      return null;
    } finally {
      unlisten?.();
      setProgress(null);
      setSolving(false);
      if (activeTokenRef.current === token) activeTokenRef.current = null;
    }
  }

  // Solve a whole queue in one backend call: each item is solved in order, its
  // best plan's bred pals seeding the next item's owned pool (contract's
  // `solve_queue`). The shared setup/cake inject here, at solve time — the
  // caller's stored specs stay setup-free so a re-solve always uses the live
  // setup. Deliberately leaves the single-solve state (plans/activePlan/…)
  // untouched; `queueResult` alone flips the Solver to its queue view.
  async function solveQueue(items: SolveSpec[]) {
    const token = nextToken();
    activeTokenRef.current = token;
    setQueueSolving(true);
    setQueueError(null);
    setCancelled(false);
    setProgress(null);
    setQueueResult(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await subscribeProgress(token, setProgress);
      // Every item shares the one generation token; the backend tags each
      // event with its `queue_index`/`queue_len` so the panel can name targets.
      const full: SolveRequest[] = items.map((it) => ({
        ...it,
        setup,
        cake,
        ...(playerScope !== "all" ? { player_uid: hexToGuid(playerScope) } : {}),
      }));
      const resp = await invoke<QueueResponse>("solve_queue", {
        saveDir,
        items: full.map((f) => ({ ...f, progress_token: token })),
        stopOnFailure: false,
      });
      setQueueResult(resp);
    } catch (e) {
      if (isCancelled(e)) setCancelled(true);
      else setQueueError(String(e));
    } finally {
      unlisten?.();
      setProgress(null);
      setQueueSolving(false);
      if (activeTokenRef.current === token) activeTokenRef.current = null;
    }
  }

  function clearQueue() {
    setQueueResult(null);
    setQueueError(null);
  }

  // Restore a saved plan's result into the view exactly as a live solve would:
  // same plans/fallback/lastRequest wiring, but flagged `restoredFrom` so the
  // header can warn the saved tree may be stale against the live roster. The
  // saved active-plan index rides the ref so the reset-to-0 effect can't clobber it.
  function rehydrate(saved: RestoredPlan) {
    setError(null);
    setSolving(false);
    setSelection(null);
    setLastRequest(saved.request);
    setFallbackUsed(saved.response.fallback_used);
    setDiagnosis(saved.response.diagnosis ?? []);
    setPinsSatisfied(saved.response.pins_satisfied ?? true);
    // Loading a saved single plan leaves the queue view.
    setQueueResult(null);
    setQueueError(null);
    setRestoredFrom({
      name: saved.name,
      created: saved.created,
      saveDir: saved.saveDir,
    });
    pendingActivePlan.current = saved.activePlan;
    setPlans(saved.response.plans);
  }

  // Restore a persisted session (navigation return, or a SOLVE HISTORY entry)
  // into the view exactly as the live solve left it — but WITHOUT `restoredFrom`,
  // since this is the same session replayed, not a stale saved plan. The saved
  // active-plan index rides the ref so the reset-to-0 effect can't clobber it.
  function restoreSession(s: {
    request: SolveRequest;
    response: SolveResponse;
    activePlan: number;
  }) {
    setError(null);
    setSolving(false);
    setSelection(null);
    setLastRequest(s.request);
    setFallbackUsed(s.response.fallback_used);
    setDiagnosis(s.response.diagnosis ?? []);
    setPinsSatisfied(s.response.pins_satisfied ?? true);
    setQueueResult(null);
    setQueueError(null);
    setRestoredFrom(null);
    pendingActivePlan.current = s.activePlan;
    setPlans(s.response.plans);
  }

  return {
    speciesList,
    nameToId,
    plans,
    fallbackUsed,
    diagnosis,
    pinsSatisfied,
    error,
    solving,
    progress,
    cancelled,
    cancel,
    activePlan,
    setActivePlan,
    selection,
    setSelection,
    fastestIdx,
    lastRequest,
    restoredFrom,
    rehydrate,
    restoreSession,
    solve,
    queueResult,
    queueSolving,
    queueError,
    solveQueue,
    clearQueue,
    reset: resetResults,
  };
}
