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
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "./lib/tauri";
import type {
  BreedingSetup,
  CakeToken,
  RosterCounts,
  SaveSummary,
} from "./lib/types";
import { hexGuid } from "./components/palbox/selectors";

export type View = "save" | "solver" | "paldex" | "ivlab" | "worldmap";

/** localStorage key for the last successfully loaded save folder. */
const SAVE_DIR_KEY = "pal-calc.saveDir";

function readLastSaveDir(): string {
  try {
    return localStorage.getItem(SAVE_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Map a raw backend load error to friendly, actionable copy. Xbox / Game Pass
 * saves use the CNK chunked-compression format the reader can't decode yet; the
 * backend tags that variant with a stable "CNK" token, so detect it and explain
 * the Steam-conversion path instead of surfacing a raw parse error. Everything
 * else passes through unchanged. */
function friendlySaveError(raw: string): string {
  if (raw.includes("CNK")) {
    return "This looks like an Xbox / Game Pass save (CNK format), which Pal Calc can't read yet \u2014 convert it to a Steam save with a tool like palworld-save-pal, or point at a Steam / dedicated-server save.";
  }
  return raw;
}

/** localStorage key for the recent-saves profile list (contract #Profiles). */
const RECENT_SAVES_KEY = "pal-calc.recentSaves";
/** Max recent-save rows kept, most-recent first. */
const MAX_RECENTS = 8;

/** A previously-loaded save, surfaced as a rich row in the load modal. */
export interface RecentSave {
  /** The folder path as the user entered/picked it (shown as mono subtext). */
  dir: string;
  /** World name from the summary at last load. */
  worldName: string;
  /** Player count at last load. */
  players: number;
  /** Pal count at last load. */
  pals: number;
  /** Epoch ms of the last successful load (rendered as relative time). */
  lastLoaded: number;
}

/** Canonical dedup key for a save dir: forward-slash, no trailing slash,
 * lowercased — so `C:\Foo\` and `c:/foo` collapse to one recent (contract #4). */
function canonDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function readRecentSaves(): RecentSave[] {
  try {
    const raw = localStorage.getItem(RECENT_SAVES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r.dir === "string")
      .map((r) => ({
        dir: String(r.dir),
        worldName: String(r.worldName ?? "Unknown World"),
        players: Number(r.players) || 0,
        pals: Number(r.pals) || 0,
        lastLoaded: Number(r.lastLoaded) || 0,
      }))
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** localStorage key for the per-save player scope map. A JSON object of
 * `canonDir -> scope` (a lowercase 32-char player uid hex, or `"all"`), so each
 * world remembers who you play it as. Keyed by the same {@link canonDir} canon
 * as the recent-saves list. */
const PLAYER_SCOPE_KEY = "pal-calc.playerScope";

/** The persisted `canonDir -> scope` map (empty on any parse failure). */
function readPlayerScopes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PLAYER_SCOPE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist `scope` for `dir` under its canonical key (merged into the map). */
function writeScopeForDir(dir: string, scope: string): void {
  try {
    const map = readPlayerScopes();
    map[canonDir(dir)] = scope;
    localStorage.setItem(PLAYER_SCOPE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures (private mode, quota) — non-fatal.
  }
}

/** localStorage keys for the persisted breeding-setup store (§ useBreedingSetup).
 * The composed farm/incubation/egg fractions + world egg-hatch hours, and the
 * selected cake, survive reloads and view switches so the Solver and IV Lab
 * share one setup. */
const BREEDING_SETUP_KEY = "pal-calc.breedingSetup";
const CAKE_KEY = "pal-calc.cake";

/** Neutral vanilla farm setup: no boosts, vanilla 72h hatch. */
const DEFAULT_SETUP: BreedingSetup = {
  farm_speed_bonus: 0,
  incubation_reduction: 0,
  extra_egg_chance: 0,
  egg_hatch_hours: 72,
};

function readBreedingSetup(): BreedingSetup {
  try {
    const raw = localStorage.getItem(BREEDING_SETUP_KEY);
    if (!raw) return DEFAULT_SETUP;
    const p = JSON.parse(raw) as Partial<BreedingSetup>;
    return {
      farm_speed_bonus: Number(p.farm_speed_bonus) || 0,
      incubation_reduction: Number(p.incubation_reduction) || 0,
      extra_egg_chance: Number(p.extra_egg_chance) || 0,
      egg_hatch_hours: Number(p.egg_hatch_hours) || 72,
    };
  } catch {
    return DEFAULT_SETUP;
  }
}

function readCake(): CakeToken {
  try {
    const raw = localStorage.getItem(CAKE_KEY);
    const valid: CakeToken[] = [
      "normal",
      "mushroom",
      "vegetable",
      "deluxe_vegetable",
      "special",
    ];
    return valid.includes(raw as CakeToken) ? (raw as CakeToken) : "normal";
  } catch {
    return "normal";
  }
}

export interface AppState {
  /** Currently-loaded save folder; empty until a save loads. */
  saveDir: string;
  /** Parsed summary of the loaded save, or null when none is loaded. */
  saveSummary: SaveSummary | null;
  /** True while `loadSave` is in flight. */
  saveLoading: boolean;
  /** True only during the one-shot boot auto-load of a persisted save. Gates the
   * startup modal so it never flashes while the auto-load is in flight. */
  booting: boolean;
  /** Last load error message, or null. */
  saveError: string | null;
  /** Per-species owned tally derived from `saveSummary` (null when no save). */
  roster: RosterCounts | null;
  /**
   * Active player scope: a lowercase 32-char player uid hex, or `"all"` for
   * every player. Filters the owned pool app-wide — the solve request (via
   * use-solve), the IV Lab donors, and the Pal-dex owned counts (via the scoped
   * `roster` above). Persisted per save dir under {@link canonDir}; defaults to
   * `"all"` (behavior identical to no scoping).
   */
  playerScope: string;
  /** Set the active player scope and persist it for the current save dir. */
  setPlayerScope: (scope: string) => void;
  /** Whether the "who plays this world?" scope prompt is open. Auto-opens once
   * after loading a multi-player save with no persisted scope; the sidebar
   * scope pill reopens it on demand. */
  scopePromptOpen: boolean;
  setScopePromptOpen: (open: boolean) => void;
  /** Last-used folder for prefilling the load modal (may not be loaded). */
  lastSaveDir: string;
  /** Load a save folder once and cache it. No-op on an empty path. */
  loadSave: (dir: string) => Promise<void>;
  /** Unload the current save; views fall back to their empty states. */
  clearSave: () => void;
  /** Recently-loaded saves (newest first, max 8) for the load-modal profiles. */
  recentSaves: RecentSave[];
  /** Silently re-read the current save in place (watcher-driven). Preserves
   * `saveDir`, so solver plans/selection survive. No-op with no save loaded. */
  reloadSave: () => Promise<void>;
  /** Transient status pill message (e.g. "Save reloaded"), or null. The `nonce`
   * re-triggers the auto-dismiss on identical repeat messages. */
  toast: { text: string; nonce: number } | null;
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
  /** Species id the World Map should open with its spawn overlay active on the
   * next render, or null. Set by the Pal-dex "Show on map" cross-link. */
  mapSpawnTarget: string | null;
  /** Jump to the World Map and activate `speciesId`'s spawn overlay. */
  requestMapSpawn: (speciesId: string) => void;
  /** The World Map clears the pending spawn target once it has consumed it. */
  clearMapSpawnTarget: () => void;
  /** Shared breeding-farm setup: composed farm/incubation/egg fractions + world
   * egg-hatch hours. Consumed by the Solver (rides the solve request) and the IV
   * Lab. Persisted. */
  setup: BreedingSetup;
  /** Shared breeding-cake selection (`normal` = none). Persisted. */
  cake: CakeToken;
  /** Replace the whole breeding setup (the BREEDING SETUP panel composes it). */
  setSetup: (setup: BreedingSetup) => void;
  /** Set the selected breeding cake. */
  setCake: (cake: CakeToken) => void;
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
  const [mapSpawnTarget, setMapSpawnTarget] = useState<string | null>(null);
  const [playerScope, setPlayerScopeState] = useState<string>("all");
  const [scopePromptOpen, setScopePromptOpen] = useState(false);
  const [setup, setSetupState] = useState<BreedingSetup>(readBreedingSetup);
  const [cake, setCakeState] = useState<CakeToken>(readCake);
  const [recentSaves, setRecentSaves] = useState<RecentSave[]>(readRecentSaves);
  // Boot auto-load: try the persisted save once on startup. `booting` starts
  // true when a folder is persisted so the startup modal is suppressed until the
  // auto-load resolves; `bootedRef` guards against StrictMode's double-invoke.
  const [booting, setBooting] = useState<boolean>(() => readLastSaveDir() !== "");
  const bootedRef = useRef(false);
  const [toast, setToast] = useState<{ text: string; nonce: number } | null>(
    null,
  );
  // Latest saveDir for the save-changed listener, which subscribes once and
  // must not re-bind on every load (a stale closure would reload the wrong dir).
  const saveDirRef = useRef(saveDir);
  saveDirRef.current = saveDir;

  const setSetup = useCallback((next: BreedingSetup) => {
    setSetupState(next);
    try {
      localStorage.setItem(BREEDING_SETUP_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage failures (private mode, quota) — non-fatal.
    }
  }, []);

  const setCake = useCallback((next: CakeToken) => {
    setCakeState(next);
    try {
      localStorage.setItem(CAKE_KEY, next);
    } catch {
      // Ignore storage failures (private mode, quota) — non-fatal.
    }
  }, []);

  // Set the active scope and persist it for the current save dir. The current
  // dir rides `saveDirRef` (not `saveDir`) so this callback stays stable and
  // the scope pill/modal never capture a stale dir.
  const setPlayerScope = useCallback((scope: string) => {
    setPlayerScopeState(scope);
    const dir = saveDirRef.current;
    if (dir) writeScopeForDir(dir, scope);
  }, []);

  // Record a successful load in the recents list: newest first, deduped by
  // canonical dir, capped at MAX_RECENTS. Persisted so profiles survive reloads.
  const pushRecent = useCallback((dir: string, summary: SaveSummary) => {
    setRecentSaves((prev) => {
      const key = canonDir(dir);
      const entry: RecentSave = {
        dir,
        worldName: summary.world_name,
        players: summary.players.length,
        pals: summary.pals.length,
        lastLoaded: Date.now(),
      };
      const next = [
        entry,
        ...prev.filter((r) => canonDir(r.dir) !== key),
      ].slice(0, MAX_RECENTS);
      try {
        localStorage.setItem(RECENT_SAVES_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage failures (private mode, quota) — non-fatal.
      }
      return next;
    });
  }, []);

  const showToast = useCallback((text: string) => {
    // `nonce` makes an identical repeat message ("Save reloaded" twice) a new
    // value, so the auto-dismiss effect re-arms each time.
    setToast({ text, nonce: Date.now() });
  }, []);

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
      pushRecent(trimmed, summary);
      // Resolve the persisted scope for this world. First load of a
      // multi-player world with no stored choice auto-opens the prompt; single-
      // player worlds (and any world with a stored scope) never prompt and just
      // apply the remembered value (default "all").
      const persisted = readPlayerScopes()[canonDir(trimmed)] ?? null;
      setPlayerScopeState(persisted ?? "all");
      setScopePromptOpen(persisted === null && summary.players.length > 1);
      try {
        localStorage.setItem(SAVE_DIR_KEY, trimmed);
      } catch {
        // Ignore storage failures (private mode, quota) — non-fatal.
      }
      // Auto-arm the live watcher so external saves trigger a silent reload.
      // No-op in plain-browser dev (no such command) — swallow the error.
      invoke("watch_save", { saveDir: trimmed }).catch(() => {});
    } catch (e) {
      setSaveError(friendlySaveError(String(e)));
      setSaveSummary(null);
      setSaveDir("");
    } finally {
      setSaveLoading(false);
    }
  }, [pushRecent]);

  // Silent re-read of the *current* save (fired by the `save-changed` watcher
  // event). It never touches `saveDir` or `saveLoading`, so solver plans and
  // node selection — keyed off `saveDir` in useSolve — survive the reload.
  const reloadSave = useCallback(async () => {
    const dir = saveDirRef.current;
    if (!dir) return;
    try {
      const summary = await invoke<SaveSummary>("load_save", { saveDir: dir });
      setSaveSummary(summary);
      pushRecent(dir, summary);
      showToast("Save reloaded");
    } catch {
      // A transient read (mid-write) failure keeps the last-good summary.
    }
  }, [pushRecent, showToast]);

  const clearSave = useCallback(() => {
    setSaveSummary(null);
    setSaveDir("");
    setSaveError(null);
    setPlayerScopeState("all");
    setScopePromptOpen(false);
    invoke("unwatch_save").catch(() => {});
  }, []);

  // Auto-dismiss the transient toast after 3s (re-arms per `nonce`).
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Subscribe once to the backend `save-changed` event -> silent reload. In the
  // Tauri webview this is the real IPC event bus; in plain-browser dev we listen
  // for a window event of the same name, so a reload can be simulated with
  //   window.dispatchEvent(new Event("save-changed"))
  useEffect(() => {
    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (isTauri) {
      let unlisten: (() => void) | undefined;
      let cancelled = false;
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen("save-changed", () => {
          reloadSave();
        }).then((un) => {
          if (cancelled) un();
          else unlisten = un;
        });
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    }
    const handler = () => {
      reloadSave();
    };
    window.addEventListener("save-changed", handler);
    return () => window.removeEventListener("save-changed", handler);
  }, [reloadSave]);

  // Boot auto-load (once): if a save folder is persisted, silently re-open it
  // instead of showing the startup modal. Any failure (moved/deleted dir, Xbox
  // CNK save, corrupt file) falls through to `saveError` + the modal via Shell —
  // never a crash. Fresh installs (no persisted dir) skip straight to done.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const dir = readLastSaveDir();
    if (!dir) {
      setBooting(false);
      return;
    }
    loadSave(dir).finally(() => setBooting(false));
  }, [loadSave]);

  // Last-resort net for uncaught async failures (watcher reload rejects, event
  // decode, stray promise rejections): surface a non-blocking toast so a
  // background error never silently white-screens or is lost. Synchronous render
  // errors are caught by the view ErrorBoundary, not here.
  useEffect(() => {
    const onError = () =>
      showToast("Something went wrong \u2014 the app kept running.");
    const onRejection = () =>
      showToast("A background task failed \u2014 the app kept running.");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [showToast]);

  // Owned tally per species, mirroring the backend `roster_counts` command but
  // computed from the single cached summary so the dex never fetches again.
  // Player-scoped: under a scope only that player's pals count (null-owner /
  // guild-stock pals are excluded, matching the backend `scope_owned` filter),
  // so the Pal-dex owned counts shrink with the active scope.
  const roster = useMemo<RosterCounts | null>(() => {
    if (!saveSummary) return null;
    const out: RosterCounts = {};
    for (const pal of saveSummary.pals) {
      if (playerScope !== "all") {
        const owner = pal.owner_player_uid ? hexGuid(pal.owner_player_uid) : null;
        if (owner !== playerScope) continue;
      }
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
  }, [saveSummary, playerScope]);

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

  const requestMapSpawn = useCallback((speciesId: string) => {
    setMapSpawnTarget(speciesId);
    setView("worldmap");
  }, []);
  const clearMapSpawnTarget = useCallback(() => setMapSpawnTarget(null), []);

  const value = useMemo<AppState>(
    () => ({
      saveDir,
      saveSummary,
      saveLoading,
      booting,
      saveError,
      roster,
      playerScope,
      setPlayerScope,
      scopePromptOpen,
      setScopePromptOpen,
      lastSaveDir,
      loadSave,
      clearSave,
      recentSaves,
      reloadSave,
      toast,
      view,
      setView,
      solveTarget,
      requestSolve,
      clearSolveTarget,
      dexTarget,
      dexInstance,
      requestDex,
      clearDexTarget,
      mapSpawnTarget,
      requestMapSpawn,
      clearMapSpawnTarget,
      setup,
      cake,
      setSetup,
      setCake,
    }),
    [
      saveDir,
      saveSummary,
      saveLoading,
      booting,
      saveError,
      roster,
      playerScope,
      setPlayerScope,
      scopePromptOpen,
      setScopePromptOpen,
      lastSaveDir,
      loadSave,
      clearSave,
      recentSaves,
      reloadSave,
      toast,
      view,
      solveTarget,
      requestSolve,
      clearSolveTarget,
      dexTarget,
      dexInstance,
      requestDex,
      clearDexTarget,
      mapSpawnTarget,
      requestMapSpawn,
      clearMapSpawnTarget,
      setup,
      cake,
      setSetup,
      setCake,
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

/** The shared breeding-setup slice of {@link AppState}: the composed farm setup
 * fractions + egg-hatch hours and the selected cake, with their setters. The
 * Solver's BREEDING SETUP panel writes it; the Solver request and the IV Lab
 * read it. Same provider instance, so it stays in sync across views. */
export interface BreedingSetupState {
  setup: BreedingSetup;
  cake: CakeToken;
  setSetup: (setup: BreedingSetup) => void;
  setCake: (cake: CakeToken) => void;
}

export function useBreedingSetup(): BreedingSetupState {
  const { setup, cake, setSetup, setCake } = useAppState();
  return { setup, cake, setSetup, setCake };
}
