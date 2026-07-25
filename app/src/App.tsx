import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import SaveInspector from "./views/SaveInspector";
import Solver from "./views/Solver";
import Paldex from "./views/Paldex";
import IvLab from "./views/IvLab";
import MapView from "./views/map/MapView";
import { AppStateProvider, useAppState } from "./state";
import { hexGuid } from "./components/palbox/selectors";
import ErrorBoundary from "./components/error-boundary";
import AboutButton from "./components/about-panel";
import type { View } from "./state";

/** Inline nav glyphs: crate (roster), lineage fork (solver), grid (dex). */
function NavIcon({ view }: { view: View }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (view === "save")
    return (
      <svg {...common}>
        <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
        <path d="M3 7l9 4 9-4M12 11v10" />
      </svg>
    );
  if (view === "solver")
    return (
      <svg {...common}>
        <circle cx="6" cy="19" r="2.4" />
        <circle cx="18" cy="19" r="2.4" />
        <circle cx="12" cy="5" r="2.4" />
        <path d="M6 16.5v-2a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v2M12 7.4v4" />
      </svg>
    );
  if (view === "ivlab")
    return (
      <svg {...common}>
        <line x1="4" y1="7" x2="20" y2="7" />
        <circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
        <line x1="4" y1="17" x2="20" y2="17" />
        <circle cx="8" cy="17" r="2" fill="currentColor" stroke="none" />
      </svg>
    );
  if (view === "worldmap")
    return (
      <svg {...common}>
        <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
        <path d="M9 4v14M15 6v14" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
    </svg>
  );
}

const NAV: { id: View; label: string; hint: string }[] = [
  { id: "save", label: "Save Inspector", hint: "Roster" },
  { id: "solver", label: "Solver", hint: "Breeding plans" },
  { id: "ivlab", label: "IV Lab", hint: "Stat breeding" },
  { id: "paldex", label: "Pal-dex", hint: "Reference" },
  { id: "worldmap", label: "World Map", hint: "Explore" },
];

/** Two-arrow swap glyph for the "switch save" affordance. */
function SwapIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />
    </svg>
  );
}

/** Folder glyph for the empty "load save" button. */
function FolderIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

/** Compact relative age for a recent-save row ("just now", "2h ago", "3d ago"). */
function relativeTime(epoch: number): string {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor((Date.now() - epoch) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Startup / switch-save dialog. Prefilled from the last-used folder, loads the
 * save through the shared app state (which caches it), and closes once the save
 * lands. "Skip for now" dismisses it — the app is fully usable without a save.
 */
function SaveModal({ onClose }: { onClose: () => void }) {
  const { lastSaveDir, loadSave, saveLoading, saveError, recentSaves } =
    useAppState();
  const [path, setPath] = useState(lastSaveDir);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function browse() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") setPath(picked);
    } catch {
      // No dialog plugin outside the Tauri webview (plain-browser dev) — ignore.
    }
  }

  const canLoad = !saveLoading && path.trim() !== "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-modal-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            Palworld save
          </div>
          <h2
            id="save-modal-title"
            className="mt-0.5 font-display text-lg font-bold tracking-wide text-ink"
          >
            Load your Palworld save
          </h2>
        </div>

        {recentSaves.length > 0 && (
          <div className="border-b border-line px-5 py-4">
            <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Recent saves
            </div>
            <ul className="flex flex-col gap-1.5">
              {recentSaves.map((r) => (
                <li key={r.dir}>
                  <button
                    onClick={() => loadSave(r.dir)}
                    disabled={saveLoading}
                    className="group flex w-full flex-col gap-0.5 rounded-md border border-line bg-raised/50 px-3 py-2 text-left transition-colors hover:border-amber/40 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[13px] font-medium text-ink group-hover:text-ink">
                        {r.worldName}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                        {relativeTime(r.lastLoaded)}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      <span className="text-ink-dim">{r.players}</span>{" "}
                      {r.players === 1 ? "player" : "players"}
                      <span className="mx-1 text-line">&middot;</span>
                      <span className="text-amber">{r.pals}</span> pals
                    </div>
                    <div
                      className="truncate font-mono text-[10px] text-ink-faint/80"
                      title={r.dir}
                    >
                      {r.dir}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Save folder
            </span>
            <div className="flex gap-2">
              <input
                autoFocus
                className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/60"
                placeholder={"\u2026/Saved/SaveGames/<id>/<world>"}
                value={path}
                onChange={(e) => setPath(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canLoad) {
                    e.preventDefault();
                    loadSave(path);
                  }
                }}
              />
              <button
                className="rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                onClick={browse}
              >
                Browse
              </button>
            </div>
          </label>
          <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">
            Point at the world folder that contains{" "}
            <span className="font-mono text-ink-dim">Level.sav</span>. Nothing is
            written &mdash; the save is read only.
          </p>
          {saveError && (
            <div className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-bad">
              {saveError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1.5 text-[13px] font-medium text-ink-faint transition-colors hover:text-ink-dim"
          >
            Skip for now
          </button>
          <button
            onClick={() => loadSave(path)}
            disabled={!canLoad}
            className="rounded-md bg-amber px-4 py-1.5 text-[13px] font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveLoading ? "Loading\u2026" : "Load save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Player-scope dialog. Asks "who plays this world?" — one row per player (name,
 * short uid hex, owned-pal count) plus an "All players" option. Picking sets the
 * scope (persisted per save dir) and closes. Auto-opened once for a fresh
 * multi-player world; also reachable from the sidebar scope pill.
 */
function ScopeModal({ onClose }: { onClose: () => void }) {
  const { saveSummary, playerScope, setPlayerScope } = useAppState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Owned-pal count per player uid (null-owner / guild-stock pals excluded, as
  // the scope filter itself excludes them).
  const ownedByUid = new Map<string, number>();
  for (const pal of saveSummary?.pals ?? []) {
    if (!pal.owner_player_uid) continue;
    const hex = hexGuid(pal.owner_player_uid);
    ownedByUid.set(hex, (ownedByUid.get(hex) ?? 0) + 1);
  }

  function pick(scope: string) {
    setPlayerScope(scope);
    onClose();
  }

  const players = saveSummary?.players ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scope-modal-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            Player scope
          </div>
          <h2
            id="scope-modal-title"
            className="mt-0.5 font-display text-lg font-bold tracking-wide text-ink"
          >
            Who plays this world?
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
            Scopes the solver, donors and Pal-dex counts to one player's pals.
            Change it any time from the scope pill.
          </p>
        </div>

        <ul className="flex flex-col gap-1.5 px-5 py-4">
          {players.map((p) => {
            const active = playerScope === p.uid;
            return (
              <li key={p.uid}>
                <button
                  onClick={() => pick(p.uid)}
                  className={`group flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                    active
                      ? "border-amber/50 bg-amber/10"
                      : "border-line bg-raised/50 hover:border-amber/40 hover:bg-hover"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-ink">
                      {p.name || "Unnamed player"}
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      {p.uid.slice(0, 8)}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                    <span className="text-amber">{ownedByUid.get(p.uid) ?? 0}</span>{" "}
                    pals
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              onClick={() => pick("all")}
              className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                playerScope === "all"
                  ? "border-amber/50 bg-amber/10"
                  : "border-line bg-raised/50 hover:border-amber/40 hover:bg-hover"
              }`}
            >
              <span className="text-[13px] font-medium text-ink">All players</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                <span className="text-amber">{saveSummary?.pals.length ?? 0}</span>{" "}
                pals
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}

function Shell() {
  const {
    view,
    setView,
    saveSummary,
    booting,
    toast,
    playerScope,
    scopePromptOpen,
    setScopePromptOpen,
  } = useAppState();
  const [modalOpen, setModalOpen] = useState(false);
  // Human-readable label for the active scope pill: the player's name, or "All".
  const scopeLabel =
    playerScope === "all"
      ? "All"
      : saveSummary?.players.find((p) => p.uid === playerScope)?.name ||
        playerScope.slice(0, 8);

  // Close the startup modal automatically once a save has loaded.
  useEffect(() => {
    if (saveSummary) setModalOpen(false);
  }, [saveSummary]);

  // Boot resolved with no save (fresh install, "Skip for now", or a failed
  // auto-load whose error rides `saveError`) — open the startup modal. These
  // deps change only once per boot, so dismissing the modal never re-triggers it.
  useEffect(() => {
    if (!booting && !saveSummary) setModalOpen(true);
  }, [booting, saveSummary]);

  return (
    <div className="flex h-full bg-abyss text-ink">
      <nav className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        {/* Wordmark */}
        <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-amber/15 ring-1 ring-amber/40">
            <span className="font-display text-lg font-bold leading-none text-amber">
              P
            </span>
          </span>
          <div className="leading-tight">
            <div className="font-display text-[15px] font-bold tracking-[0.14em] text-ink">
              PAL&middot;CALC
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
              Breeding lab
            </div>
          </div>
        </div>

        <div className="mx-4 mb-3 h-px bg-line-soft" />

        <ul className="flex flex-col gap-0.5 px-2.5">
          {NAV.map((item) => {
            const active = view === item.id;
            return (
              <li key={item.id}>
                <button
                  onClick={() => setView(item.id)}
                  aria-current={active ? "page" : undefined}
                  className={`group relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                    active
                      ? "bg-raised text-ink"
                      : "text-ink-dim hover:bg-hover/60 hover:text-ink"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-amber transition-opacity ${
                      active ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <span className={active ? "text-amber" : "text-ink-faint group-hover:text-ink-dim"}>
                    <NavIcon view={item.id} />
                  </span>
                  <span className="flex flex-col">
                    <span className="text-[13px] font-medium leading-tight">{item.label}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      {item.hint}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-auto px-3 pb-4 pt-3">
          {saveSummary ? (
            <div className="rounded-md border border-line bg-raised/50 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div
                    className="truncate text-[13px] font-medium text-ink"
                    title={saveSummary.world_name}
                  >
                    {saveSummary.world_name}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                    <span className="text-ink-dim">
                      {saveSummary.players.length}
                    </span>{" "}
                    {saveSummary.players.length === 1 ? "player" : "players"}
                    <span className="mx-1 text-line">&middot;</span>
                    <span className="text-amber">{saveSummary.pals.length}</span>{" "}
                    pals
                  </div>
                </div>
                <button
                  onClick={() => setModalOpen(true)}
                  title="Switch save"
                  aria-label="Switch save"
                  className="shrink-0 rounded-md border border-line bg-raised p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                >
                  <SwapIcon />
                </button>
              </div>
              {saveSummary.players.length > 1 && (
                <button
                  onClick={() => setScopePromptOpen(true)}
                  title="Change player scope"
                  className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-line bg-abyss/60 px-2.5 py-1.5 font-mono text-[10px] tracking-wider text-ink-faint transition-colors hover:border-amber/40 hover:text-ink"
                >
                  <span className="uppercase text-ink-faint">Scope:</span>
                  <span className="truncate text-amber">{scopeLabel}</span>
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={() => setModalOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-[13px] font-medium text-ink-dim transition-colors hover:border-amber/40 hover:bg-hover hover:text-ink"
            >
              <FolderIcon />
              Load save
            </button>
          )}
          <AboutButton />
        </div>
      </nav>

      <main className="flex-1 overflow-hidden">
        <ErrorBoundary key={view} onReset={() => setView("save")}>
          {view === "save" && <SaveInspector />}
          {view === "solver" && <Solver />}
          {view === "ivlab" && <IvLab />}
          {view === "paldex" && <Paldex />}
          {view === "worldmap" && <MapView />}
        </ErrorBoundary>
      </main>
      {modalOpen && <SaveModal onClose={() => setModalOpen(false)} />}
      {scopePromptOpen && (
        <ScopeModal onClose={() => setScopePromptOpen(false)} />
      )}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-md border border-amber/40 bg-raised px-3.5 py-2 text-[12px] font-medium text-ink"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber" />
          {toast.text}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}
