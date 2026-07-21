// Small hook for the Palbox view's shared, persisted control state: the active
// player tab, the grid/list mode, and the sort/search/filter query. The last
// player and mode are remembered across sessions (PALBOX-PLAN decision 1).
// Selection and paging stay in the view since they depend on the flattened,
// filtered pal order.

import { useCallback, useState } from "react";
import { DEFAULT_QUERY, type PalboxQuery } from "./selectors";

export type PalboxMode = "grid" | "list";

const PLAYER_KEY = "pal-calc.palbox.player";
const MODE_KEY = "pal-calc.palbox.mode";

/** A useState whose value is mirrored to localStorage, tolerant of no storage. */
function usePersistedState<T extends string>(
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // ignore quota / privacy-mode failures; state still updates in-memory
      }
    },
    [key],
  );
  return [value, set];
}

export interface PalboxControls {
  /** Persisted last-selected player uid ("" until one is chosen). */
  storedPlayer: string;
  setStoredPlayer: (uid: string) => void;
  mode: PalboxMode;
  setMode: (mode: PalboxMode) => void;
  query: PalboxQuery;
  patchQuery: (patch: Partial<PalboxQuery>) => void;
}

export function usePalboxState(): PalboxControls {
  const [storedPlayer, setStoredPlayer] = usePersistedState<string>(PLAYER_KEY, "");
  const [mode, setMode] = usePersistedState<PalboxMode>(MODE_KEY, "grid");
  const [query, setQuery] = useState<PalboxQuery>(DEFAULT_QUERY);
  const patchQuery = useCallback(
    (patch: Partial<PalboxQuery>) => setQuery((q) => ({ ...q, ...patch })),
    [],
  );
  return { storedPlayer, setStoredPlayer, mode, setMode, query, patchQuery };
}
