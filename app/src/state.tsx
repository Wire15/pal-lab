// Cross-view app state. Round 2 lifted three things out of the individual
// views; this iteration lifts the *save itself* so it loads exactly once and
// every view renders from one cached summary instead of refetching on mount:
//   - `saveDir`      the loaded save folder ("" until a save loads)
//   - `saveSummary`  the parsed roster + players + warnings, cached
//   - `roster`       per-species owned tally, DERIVED from `saveSummary`
//   - `view`         the active nav view (so the dex can jump to the Solver)
//   - `solveTarget`  a pending species *name* the Solver pre-fills once
//   - `dexTarget`    a pending species *id* the Pal-dex opens once
//   - `dexInstance`  the owned-instance hex guid to enrich that dex page with
// The last-used folder is persisted to localStorage and used to prefill the
// startup modal, but the app never auto-loads a save on boot.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { invoke } from "./lib/tauri";
import type { RosterCounts, SaveSummary } from "./lib/types";

export type View = "save" | "solver" | "paldex";

/** localStorage key for the last successfully loaded save folder. */
const SAVE_DIR_KEY = "pal-calc.saveDir";

function readLastSaveDir(): string {
  try {
    return localStorage.getItem(SAVE_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

export interface AppState {
  /** Currently-loaded save folder; empty until a save loads. */
  saveDir: string;
  /** Parsed summary of the loaded save, or null when none is loaded. */
  saveSummary: SaveSummary | null;
  /** True while `loadSave` is in flight. */
  saveLoading: boolean;
  /** Last load error message, or null. */
  saveError: string | null;
  /** Per-species owned tally derived from `saveSummary` (null when no save). */
  roster: RosterCounts | null;
  /** Last-used folder for prefilling the load modal (may not be loaded). */
  lastSaveDir: string;
  /** Load a save folder once and cache it. No-op on an empty path. */
  loadSave: (dir: string) => Promise<void>;
  /** Unload the current save; views fall back to their empty states. */
  clearSave: () => void;
  /** Active nav view. */
  view: View;
  setView: (view: View) => void;
  /** Species name the Solver should pre-fill on its next render, or null. */
  solveTarget: string | null;
  /** Jump to the Solver with `speciesName` pre-filled as the target. */
  requestSolve: (speciesName: string) => void;
  /** Solver clears the pending target once it has consumed it. */
  clearSolveTarget: () => void;
  /** Species id the Pal-dex should open on its next render, or null. */
  dexTarget: string | null;
  /**
   * Owned-instance hex guid (per `hexGuid`) the opened dex page should enrich
   * with save data, or null for a plain species view. Rides alongside
   * `dexTarget` and is consumed/cleared together.
   */
  dexInstance: string | null;
  /**
   * Jump to the Pal-dex with `speciesId` opened in the detail view. Pass an
   * owned-instance hex guid to render that instance's your-pal section.
   */
  requestDex: (speciesId: string, instanceId?: string) => void;
  /** Pal-dex clears the pending target + instance once it has consumed them. */
  clearDexTarget: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [saveDir, setSaveDir] = useState("");
  const [saveSummary, setSaveSummary] = useState<SaveSummary | null>(null);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSaveDir, setLastSaveDir] = useState<string>(readLastSaveDir);
  const [view, setView] = useState<View>("save");
  const [solveTarget, setSolveTarget] = useState<string | null>(null);
  const [dexTarget, setDexTarget] = useState<string | null>(null);
  const [dexInstance, setDexInstance] = useState<string | null>(null);

  const loadSave = useCallback(async (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed) return;
    setSaveLoading(true);
    setSaveError(null);
    try {
      const summary = await invoke<SaveSummary>("load_save", {
        saveDir: trimmed,
      });
      setSaveSummary(summary);
      setSaveDir(trimmed);
      setLastSaveDir(trimmed);
      try {
        localStorage.setItem(SAVE_DIR_KEY, trimmed);
      } catch {
        // Ignore storage failures (private mode, quota) — non-fatal.
      }
    } catch (e) {
      setSaveError(String(e));
      setSaveSummary(null);
      setSaveDir("");
    } finally {
      setSaveLoading(false);
    }
  }, []);

  const clearSave = useCallback(() => {
    setSaveSummary(null);
    setSaveDir("");
    setSaveError(null);
  }, []);

  // Owned tally per species, mirroring the backend `roster_counts` command but
  // computed from the single cached summary so the dex never fetches again.
  const roster = useMemo<RosterCounts | null>(() => {
    if (!saveSummary) return null;
    const out: RosterCounts = {};
    for (const pal of saveSummary.pals) {
      const e = (out[pal.character_id] ??= {
        male: 0,
        female: 0,
        best_ivs: { hp: 0, atk: 0, def: 0 },
      });
      if (pal.gender === "Male") e.male += 1;
      else if (pal.gender === "Female") e.female += 1;
      e.best_ivs.hp = Math.max(e.best_ivs.hp, pal.ivs.hp);
      e.best_ivs.atk = Math.max(e.best_ivs.atk, pal.ivs.attack);
      e.best_ivs.def = Math.max(e.best_ivs.def, pal.ivs.defense);
    }
    return out;
  }, [saveSummary]);

  const requestSolve = useCallback((speciesName: string) => {
    setSolveTarget(speciesName);
    setView("solver");
  }, []);
  const clearSolveTarget = useCallback(() => setSolveTarget(null), []);

  const requestDex = useCallback((speciesId: string, instanceId?: string) => {
    setDexTarget(speciesId);
    setDexInstance(instanceId ?? null);
    setView("paldex");
  }, []);
  const clearDexTarget = useCallback(() => {
    setDexTarget(null);
    setDexInstance(null);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      saveDir,
      saveSummary,
      saveLoading,
      saveError,
      roster,
      lastSaveDir,
      loadSave,
      clearSave,
      view,
      setView,
      solveTarget,
      requestSolve,
      clearSolveTarget,
      dexTarget,
      dexInstance,
      requestDex,
      clearDexTarget,
    }),
    [
      saveDir,
      saveSummary,
      saveLoading,
      saveError,
      roster,
      lastSaveDir,
      loadSave,
      clearSave,
      view,
      solveTarget,
      requestSolve,
      clearSolveTarget,
      dexTarget,
      dexInstance,
      requestDex,
      clearDexTarget,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Access the shared app state. Throws outside the provider. */
export function useAppState(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
