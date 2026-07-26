// BREEDING QUEUE (Solver form tail) — a collapsible section that stacks several
// targets into one sequential solve. "Add current target to queue" snapshots
// the current full solve spec (target / passives / max-steps / source pool /
// catching / pins — exactly what a single solve would send, minus the shared
// setup/cake, which inject at queue-solve time). The queue persists to
// localStorage (`pal-lab.solverQueue`) and survives restarts; entries store
// the REQUEST only, so "Solve queue" always re-solves honestly against the live
// save rather than replaying a frozen result.

import { useState } from "react";
import type { SolveSpec } from "../lib/use-solve";
import { PalIcon } from "./primitives";

/** localStorage key for the persisted solver queue. */
const STORAGE_KEY = "pal-lab.solverQueue";

/** One queued target: a stable id (React key + reorder handle) plus the frozen
 *  solve spec it will be solved with. Setup/cake are deliberately absent — they
 *  ride the live BREEDING SETUP store at solve time. */
export interface QueueEntry {
  id: string;
  spec: SolveSpec;
}

/** Read the persisted queue (empty on absent/corrupt storage). */
export function readQueue(): QueueEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueueEntry[]) : [];
  } catch {
    return [];
  }
}

/** Persist the queue. */
export function writeQueue(entries: QueueEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full / unavailable: the queue is a convenience, not load-bearing.
  }
}

/** A ▲/▼ reorder button (disabled at the list edge). */
function MoveButton({
  dir,
  disabled,
  onClick,
}: {
  dir: "up" | "down";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "up" ? "Move up" : "Move down"}
      className="rounded-sm px-1 text-[11px] leading-none text-ink-faint transition-colors enabled:hover:bg-hover enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
    >
      {dir === "up" ? "\u25b2" : "\u25bc"}
    </button>
  );
}

export interface QueuePanelProps {
  entries: QueueEntry[];
  /** Species name -> internal id, for target-row icons. */
  nameToId: Map<string, string>;
  /** Whether "Add current target" is valid (save loaded + target set). */
  canAdd: boolean;
  onAdd: () => void;
  onRemove: (id: string) => void;
  /** Reorder an entry one slot (`-1` up, `+1` down). */
  onMove: (id: string, dir: -1 | 1) => void;
  onSolve: () => void;
  solving: boolean;
}

export function QueuePanel({
  entries,
  nameToId,
  canAdd,
  onAdd,
  onRemove,
  onMove,
  onSolve,
  solving,
}: QueuePanelProps) {
  const [open, setOpen] = useState(entries.length > 0);

  return (
    <div className="flex flex-col gap-2 border-t border-line-soft pt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 text-left"
      >
        <svg
          className={`shrink-0 text-ink-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">
          Breeding queue
        </span>
        {entries.length > 0 && (
          <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-dim">
            {entries.length}
          </span>
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onAdd}
            disabled={!canAdd}
            className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] font-medium text-ink-dim transition-colors enabled:hover:bg-hover enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            + Add current target to queue
          </button>

          {entries.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-ink-faint">
              Queue several targets to solve them in order &mdash; each one&rsquo;s
              plan assumes the earlier targets were bred first.
            </p>
          ) : (
            <>
              <ol className="flex flex-col gap-1">
                {entries.map((e, i) => {
                  const pins = e.spec.pinned_parents?.length ?? 0;
                  const passives = e.spec.required_passives?.length ?? 0;
                  return (
                    <li
                      key={e.id}
                      className="flex items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5"
                    >
                      <span className="w-4 shrink-0 text-center font-mono text-[11px] tabular-nums text-ink-faint">
                        {i + 1}
                      </span>
                      <PalIcon
                        id={nameToId.get(e.spec.target_species) ?? null}
                        name={e.spec.target_species}
                        size={22}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[12px] font-medium text-ink">
                          {e.spec.target_species}
                        </span>
                        <div className="flex flex-wrap items-center gap-1 font-mono text-[10px] text-ink-faint">
                          {passives > 0 && (
                            <span className="rounded-sm bg-raised px-1 py-0.5 tabular-nums">
                              {passives}p
                            </span>
                          )}
                          {pins > 0 && (
                            <span className="rounded-sm bg-amber/10 px-1 py-0.5 tabular-nums text-amber/90">
                              {pins} pin{pins > 1 ? "s" : ""}
                            </span>
                          )}
                          <span className="rounded-sm bg-raised px-1 py-0.5 tabular-nums">
                            {e.spec.max_steps ?? 5} steps
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col">
                        <MoveButton
                          dir="up"
                          disabled={i === 0}
                          onClick={() => onMove(e.id, -1)}
                        />
                        <MoveButton
                          dir="down"
                          disabled={i === entries.length - 1}
                          onClick={() => onMove(e.id, 1)}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => onRemove(e.id)}
                        aria-label="Remove"
                        className="shrink-0 rounded-sm px-1 leading-none text-ink-faint transition-colors hover:bg-hover hover:text-bad"
                      >
                        &times;
                      </button>
                    </li>
                  );
                })}
              </ol>

              <button
                type="button"
                onClick={onSolve}
                disabled={solving || entries.length === 0}
                className="rounded-md bg-amber px-4 py-2 text-[13px] font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
              >
                {solving ? "Solving queue\u2026" : `Solve queue (${entries.length})`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
