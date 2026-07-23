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

import { useEffect, useMemo, useState } from "react";
import { invoke } from "./tauri";
import type {
  BreedingPlan,
  NamedEntry,
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

export interface UseSolve {
  /** Full species list from `list_species` (drives the datalist). */
  speciesList: NamedEntry[];
  /** Species name -> internal id, for plan-tree/catch lookups. */
  nameToId: Map<string, string>;
  /** Ranked plans from the last solve, or null before the first solve. */
  plans: BreedingPlan[] | null;
  /** Whether a `breeding_only` solve fell back to catch-assisted plans. */
  fallbackUsed: boolean;
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
  /** Run a solve for `spec`; the hook injects the shared setup/cake. */
  solve: (spec: SolveSpec) => Promise<void>;
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
  }, [saveDir]);

  // A fresh result resets to the first plan; switching plans (or a new result)
  // clears any node selection, since node ids are per-plan-render path ids.
  useEffect(() => {
    setActivePlan(0);
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
    try {
      // `setup`/`cake` ride the shared BREEDING SETUP store (contract #3); the
      // caller owns everything else, so per-view field sets stay intact.
      const full: SolveRequest = { ...spec, setup, cake };
      const resp = await invoke<SolveResponse>("solve", { saveDir, spec: full });
      setPlans(resp.plans);
      setFallbackUsed(resp.fallback_used);
    } catch (e) {
      setError(String(e));
    } finally {
      setSolving(false);
    }
  }

  return {
    speciesList,
    nameToId,
    plans,
    fallbackUsed,
    error,
    solving,
    activePlan,
    setActivePlan,
    selection,
    setSelection,
    fastestIdx,
    solve,
  };
}
