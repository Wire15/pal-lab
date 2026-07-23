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
import { invoke } from "./tauri";
import type {
  BreedingPlan,
  NamedEntry,
  QueueResponse,
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

export interface UseSolve {
  /** Full species list from `list_species` (drives the datalist). */
  speciesList: NamedEntry[];
  /** Species name -> internal id, for plan-tree/catch lookups. */
  nameToId: Map<string, string>;
  /** Ranked plans from the last solve, or null before the first solve. */
  plans: BreedingPlan[] | null;
  /** Whether a `breeding_only` solve fell back to catch-assisted plans. */
  fallbackUsed: boolean;
  /** Whether the last single solve's `pinned_parents` constraint held. `false`
   *  (with empty `plans`) means pinning eliminated every otherwise-valid plan;
   *  defaults `true` (no pins, or a pinned plan survived). */
  pinsSatisfied: boolean;
  /** Last solve error string, or null. */
  error: string | null;
  /** True while a solve is in flight. */
  solving: boolean;
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
  /** Run a solve for `spec`; the hook injects the shared setup/cake. */
  solve: (spec: SolveSpec) => Promise<void>;
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
}

export function useSolve(): UseSolve {
  const { saveDir } = useAppState();
  const { setup, cake } = useBreedingSetup();

  const [speciesList, setSpeciesList] = useState<NamedEntry[]>([]);
  const [plans, setPlans] = useState<BreedingPlan[] | null>(null);
  const [fallbackUsed, setFallbackUsed] = useState(false);
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
  // A rehydrate wants to land on the saved active-plan index, but setting `plans`
  // fires the reset-to-0 effect below. This ref carries the desired index across
  // that render so the restored tab survives; null means "default to 0".
  const pendingActivePlan = useRef<number | null>(null);

  useEffect(() => {
    invoke<NamedEntry[]>("list_species").then(setSpeciesList).catch(() => {});
  }, []);

  // Switching saves invalidates a solve: last save's plans, owned tags and
  // donor kin no longer apply, so clear the whole result before save B renders.
  useEffect(() => {
    setPlans(null);
    setActivePlan(0);
    setSelection(null);
    setError(null);
    setFallbackUsed(false);
    setLastRequest(null);
    setRestoredFrom(null);
    setPinsSatisfied(true);
    setQueueResult(null);
    setQueueError(null);
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

  async function solve(spec: SolveSpec) {
    setSolving(true);
    setError(null);
    setPlans(null);
    setFallbackUsed(false);
    setRestoredFrom(null);
    setPinsSatisfied(true);
    // A single solve exits the queue view (they share the one results pane).
    setQueueResult(null);
    setQueueError(null);
    try {
      // `setup`/`cake` ride the shared BREEDING SETUP store (contract #3); the
      // caller owns everything else, so per-view field sets stay intact.
      const full: SolveRequest = { ...spec, setup, cake };
      setLastRequest(full);
      const resp = await invoke<SolveResponse>("solve", { saveDir, spec: full });
      setPlans(resp.plans);
      setFallbackUsed(resp.fallback_used);
      // Serde-defaults to `true` for responses predating the pin field.
      setPinsSatisfied(resp.pins_satisfied ?? true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSolving(false);
    }
  }

  // Solve a whole queue in one backend call: each item is solved in order, its
  // best plan's bred pals seeding the next item's owned pool (contract's
  // `solve_queue`). The shared setup/cake inject here, at solve time — the
  // caller's stored specs stay setup-free so a re-solve always uses the live
  // setup. Deliberately leaves the single-solve state (plans/activePlan/…)
  // untouched; `queueResult` alone flips the Solver to its queue view.
  async function solveQueue(items: SolveSpec[]) {
    setQueueSolving(true);
    setQueueError(null);
    setQueueResult(null);
    try {
      const full: SolveRequest[] = items.map((it) => ({ ...it, setup, cake }));
      const resp = await invoke<QueueResponse>("solve_queue", {
        saveDir,
        items: full,
        stopOnFailure: false,
      });
      setQueueResult(resp);
    } catch (e) {
      setQueueError(String(e));
    } finally {
      setQueueSolving(false);
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

  return {
    speciesList,
    nameToId,
    plans,
    fallbackUsed,
    pinsSatisfied,
    error,
    solving,
    activePlan,
    setActivePlan,
    selection,
    setSelection,
    fastestIdx,
    lastRequest,
    restoredFrom,
    rehydrate,
    solve,
    queueResult,
    queueSolving,
    queueError,
    solveQueue,
    clearQueue,
  };
}
