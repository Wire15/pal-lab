// Minimal cross-view app state. Round 2 lifts three things out of the
// individual views so the Pal-dex can reuse them:
//   - `saveDir`   the loaded save folder, shared by Roster / Solver / Pal-dex
//   - `view`      the active nav view (so the dex can jump to the Solver)
//   - `solveTarget` a pending species name the Solver pre-fills once, on arrival
// Everything else stays local to each view. This is deliberately small — a
// single context, no reducer, no store.

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type View = "save" | "solver" | "paldex";

export interface AppState {
  /** Save folder shared across views; empty until a save is loaded. */
  saveDir: string;
  setSaveDir: (dir: string) => void;
  /** Active nav view. */
  view: View;
  setView: (view: View) => void;
  /** Species name the Solver should pre-fill on its next render, or null. */
  solveTarget: string | null;
  /** Jump to the Solver with `speciesName` pre-filled as the target. */
  requestSolve: (speciesName: string) => void;
  /** Solver clears the pending target once it has consumed it. */
  clearSolveTarget: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [saveDir, setSaveDir] = useState("");
  const [view, setView] = useState<View>("save");
  const [solveTarget, setSolveTarget] = useState<string | null>(null);

  const requestSolve = useCallback((speciesName: string) => {
    setSolveTarget(speciesName);
    setView("solver");
  }, []);
  const clearSolveTarget = useCallback(() => setSolveTarget(null), []);

  const value = useMemo<AppState>(
    () => ({
      saveDir,
      setSaveDir,
      view,
      setView,
      solveTarget,
      requestSolve,
      clearSolveTarget,
    }),
    [saveDir, view, solveTarget, requestSolve, clearSolveTarget],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Access the shared app state. Throws outside the provider. */
export function useAppState(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
