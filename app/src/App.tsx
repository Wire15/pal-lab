import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import SaveInspector from "./views/SaveInspector";
import Solver from "./views/Solver";
import Paldex from "./views/Paldex";
import IvLab from "./views/IvLab";
import { AppStateProvider, useAppState } from "./state";
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

/**
 * Startup / switch-save dialog. Prefilled from the last-used folder, loads the
 * save through the shared app state (which caches it), and closes once the save
 * lands. "Skip for now" dismisses it — the app is fully usable without a save.
 */
function SaveModal({ onClose }: { onClose: () => void }) {
  const { lastSaveDir, loadSave, saveLoading, saveError } = useAppState();
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

function Shell() {
  const { view, setView, saveSummary } = useAppState();
  const [modalOpen, setModalOpen] = useState(() => saveSummary === null);

  // Close the startup modal automatically once a save has loaded.
  useEffect(() => {
    if (saveSummary) setModalOpen(false);
  }, [saveSummary]);

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
          <div className="mt-2.5 flex items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-good" />
            Offline &middot; v0.1
          </div>
        </div>
      </nav>

      <main className="flex-1 overflow-hidden">
        {view === "save" && <SaveInspector />}
        {view === "solver" && <Solver />}
        {view === "ivlab" && <IvLab />}
        {view === "paldex" && <Paldex />}
      </main>
      {modalOpen && <SaveModal onClose={() => setModalOpen(false)} />}
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
