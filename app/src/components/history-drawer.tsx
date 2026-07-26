// The SOLVE HISTORY drawer: a right-slide panel listing the last successful
// solves, so a solve survives an app restart and can be re-opened as the current
// session. Sibling to the PLANS drawer (plans-drawer.tsx) — same slide-panel
// shell, same localStorage-on-open pattern — but this list is auto-recorded on
// every successful solve (not an explicit Save), capped at 20, oldest evicted.
//
// The localStorage layer lives here since the drawer owns the history model;
// the Solver imports `pushHistoryEntry` for its post-solve record hook. Failed
// solves (zero plans) are never recorded (that policy lives in the caller).

import { useEffect, useState } from "react";
import type { SolveRequest, SolveResponse } from "../lib/types";
import { formatDuration } from "../lib/ui";
import { PalIcon } from "./primitives";

/** localStorage key for the persisted solve-history list. */
const STORAGE_KEY = "pal-lab.solveHistory";
/** Max history rows kept, most-recent first; older ones are evicted. */
const CAP = 20;

/** One recorded successful solve. `request`/`response` are the frozen shapes the
 *  solve returned (the same contract shapes SavedPlan uses), so restoring an
 *  entry replays the exact result view. The displayed request summary (target,
 *  passives, step cap, source pool, cake) is derived from `request` at render. */
export interface SolveHistoryEntry {
  id: string;
  /** Epoch-ms the solve completed. */
  timestamp: number;
  request: SolveRequest;
  response: SolveResponse;
  /** Active plan tab index when recorded. */
  activePlan: number;
}

function readAll(): SolveHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as SolveHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: SolveHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage full / disabled — history is best-effort */
  }
}

/** All history entries, most-recent first. */
export function listSolveHistory(): SolveHistoryEntry[] {
  return readAll().sort((a, b) => b.timestamp - a.timestamp);
}

/** Record a completed successful solve: prepend it, cap at 20 (evict oldest),
 *  persist. The caller guarantees the solve produced at least one plan. */
export function pushHistoryEntry(input: {
  request: SolveRequest;
  response: SolveResponse;
  activePlan: number;
  timestamp: number;
}): SolveHistoryEntry {
  const entry: SolveHistoryEntry = {
    id: crypto.randomUUID(),
    timestamp: input.timestamp,
    request: input.request,
    response: input.response,
    activePlan: input.activePlan,
  };
  const next = [entry, ...readAll()].slice(0, CAP);
  writeAll(next);
  return entry;
}

/** Drop the whole history list. */
export function clearSolveHistory(): void {
  writeAll([]);
}

/** Compact relative-time label ("just now", "3h ago", "2w ago"). */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}

function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M3 3l8 8M11 3l-8 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Species name -> id, for the target icon. */
  nameToId: Map<string, string>;
  /** Restore an entry as the current solve session. */
  onRestore: (entry: SolveHistoryEntry) => void;
}

export function HistoryDrawer({
  open,
  onClose,
  nameToId,
  onRestore,
}: HistoryDrawerProps) {
  const [entries, setEntries] = useState<SolveHistoryEntry[]>([]);

  const reload = () => setEntries(listSolveHistory());

  // Re-read storage each time the drawer opens (a solve may have landed while it
  // was closed).
  useEffect(() => {
    if (open) reload();
  }, [open]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function clearAll() {
    clearSolveHistory();
    reload();
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-abyss/60 transition-opacity duration-200 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Solve history"
        aria-hidden={!open}
        className={`fixed right-0 top-0 z-50 flex h-full w-[400px] max-w-full flex-col border-l border-line bg-panel transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line bg-raised px-4 py-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-amber">
              History
            </div>
            <h2 className="font-display text-base font-bold tracking-wide text-ink">
              Recent solves
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            {entries.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="rounded-md border border-line bg-raised px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:border-bad/50 hover:text-bad"
              >
                Clear all
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close history drawer"
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              <CloseGlyph />
            </button>
          </div>
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-auto">
          {entries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <div className="font-display text-sm text-ink-dim">
                No solves yet
              </div>
              <p className="text-[12px] leading-relaxed text-ink-faint">
                Every successful solve is recorded here so you can jump back to a
                previous plan.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {entries.map((e) => {
                const r = e.request;
                const targetId = nameToId.get(r.target_species) ?? null;
                const plan =
                  e.response.plans[e.activePlan] ?? e.response.plans[0] ?? null;
                const passives = r.required_passives ?? [];
                return (
                  <li
                    key={e.id}
                    className="flex items-start gap-3 border-b border-line-soft px-4 py-3 transition-colors hover:bg-hover/40"
                  >
                    <PalIcon
                      id={targetId}
                      name={r.target_species}
                      size={34}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="truncate text-[13px] font-medium text-ink"
                          title={r.target_species}
                        >
                          {r.target_species}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                          {relTime(e.timestamp)}
                        </span>
                      </div>
                      {passives.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {passives.map((p) => (
                            <span
                              key={p}
                              className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
                            >
                              {p}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px] text-ink-dim">
                        {plan && (
                          <>
                            <span className="text-amber">
                              {formatDuration(plan.total_time_secs)}
                            </span>
                            <span>
                              <span className="text-ink">{plan.total_steps}</span> steps
                            </span>
                            {plan.total_wild_pals > 0 && (
                              <span>
                                <span className="text-el-leaf">
                                  {plan.total_wild_pals}
                                </span>{" "}
                                wild
                              </span>
                            )}
                          </>
                        )}
                        <span className="text-ink-faint">
                          {(r.max_steps ?? 5)} step cap
                        </span>
                        <span className="text-ink-faint">
                          {r.include_wild ? "owned + wild" : "owned"}
                        </span>
                        {(r.cake ?? "normal") !== "normal" && (
                          <span className="text-ink-faint">{r.cake} cake</span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            onRestore(e);
                            onClose();
                          }}
                          className="rounded-md bg-amber/10 border border-amber/40 px-2.5 py-1 text-[11px] font-medium text-amber transition-colors hover:bg-amber/20"
                        >
                          Restore
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
