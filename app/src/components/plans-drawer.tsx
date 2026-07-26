// The PLANS drawer: a right-slide panel listing saved breeding plans, with
// load / rename / delete / compare-two per row plus an import-code field. The
// saved-plan localStorage layer (contract `pal-lab.savedPlans`, cap 50, LRU
// evict oldest-unnamed-first) lives here since the drawer owns the saved-plan
// model; the Solver imports `saveNewPlan`/`defaultPlanName` for its header CTA.
//
// COMPARE ships as a stat comparison (not dual graphs): total time, steps, wild
// count, and overall breeding odds side by side, the better value per row tinted
// `good`, plus each plan's per-step odds chain. No "winner" is declared — the
// user judges (a lower time may not be worth worse odds).

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BreedingPlan,
  PlanNode,
  SolveRequest,
  SolveResponse,
} from "../lib/types";
import { formatDuration, probBand } from "../lib/ui";
import { PalIcon } from "./primitives";
import { decodePlanCode, type DecodedPlanCode } from "./plan-export";

const STORAGE_KEY = "pal-lab.savedPlans";
const CAP = 50;

/** A persisted breeding plan (frozen contract shape). */
export interface SavedPlan {
  id: string;
  name: string;
  /** Epoch-ms the plan was saved. */
  created: number;
  saveDir: string;
  request: SolveRequest;
  response: SolveResponse;
  activePlan: number;
}

/** Default plan name: "<Target> - <steps> steps - <time>". */
export function defaultPlanName(targetName: string, plan: BreedingPlan): string {
  return `${targetName} - ${plan.total_steps} steps - ${formatDuration(
    plan.total_time_secs,
  )}`;
}

function readAll(): SavedPlan[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as SavedPlan[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: SavedPlan[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage full / disabled — saving is best-effort */
  }
}

/** All saved plans, most-recently-saved first. */
export function listSavedPlans(): SavedPlan[] {
  return readAll().sort((a, b) => b.created - a.created);
}

/** The representative plan of a saved entry (its stored active tab). */
export function savedActivePlan(p: SavedPlan): BreedingPlan | null {
  return p.response.plans[p.activePlan] ?? p.response.plans[0] ?? null;
}

/** Whether a saved plan still carries its auto-generated default name (used as
 *  the "unnamed" signal for LRU eviction, since the frozen shape has no flag). */
function isDefaultName(p: SavedPlan): boolean {
  const plan = savedActivePlan(p);
  return !!plan && p.name === defaultPlanName(p.request.target_species, plan);
}

/** Index to evict when at cap: the oldest default-named plan, else the oldest. */
function pickEvict(list: SavedPlan[]): number {
  let unnamedIdx = -1;
  let unnamedCreated = Infinity;
  let oldestIdx = 0;
  let oldestCreated = Infinity;
  list.forEach((p, i) => {
    if (p.created < oldestCreated) {
      oldestCreated = p.created;
      oldestIdx = i;
    }
    if (isDefaultName(p) && p.created < unnamedCreated) {
      unnamedCreated = p.created;
      unnamedIdx = i;
    }
  });
  return unnamedIdx >= 0 ? unnamedIdx : oldestIdx;
}

/** Persist a new saved plan, enforcing the cap-50 LRU policy. Returns it. */
export function saveNewPlan(input: {
  name: string;
  saveDir: string;
  request: SolveRequest;
  response: SolveResponse;
  activePlan: number;
}): SavedPlan {
  const list = readAll();
  const entry: SavedPlan = {
    id: crypto.randomUUID(),
    created: Date.now(),
    ...input,
  };
  list.push(entry);
  while (list.length > CAP) list.splice(pickEvict(list), 1);
  writeAll(list);
  return entry;
}

/** Rename a saved plan in place. */
export function renameSavedPlan(id: string, name: string): void {
  const list = readAll();
  const hit = list.find((p) => p.id === id);
  if (hit) {
    hit.name = name.trim() || hit.name;
    writeAll(list);
  }
}

/** Delete a saved plan. */
export function deleteSavedPlan(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id));
}

/** Compact relative-time label ("just now", "3h ago", "2w ago"). */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** Breed-step probabilities of a plan tree, root-first (the odds chain). */
function breedProbs(root: PlanNode): number[] {
  const out: number[] = [];
  (function walk(n: PlanNode) {
    if (n.source === "Bred") out.push(n.probability);
    n.children.forEach(walk);
  })(root);
  return out;
}

/** Overall breeding odds: product of every breed step's probability. */
function overallOdds(root: PlanNode): number {
  return breedProbs(root).reduce((a, b) => a * b, 1);
}

// --- Inline glyphs -----------------------------------------------------------

function CloseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function PencilGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 6.5l3 3" />
    </svg>
  );
}
function TrashGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </svg>
  );
}
function WarnGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

// --- Compare panel -----------------------------------------------------------

/** Per-row comparison: the better cell (per `lowerBetter`) is tinted `good`. */
function StatRow({
  label,
  a,
  b,
  aBetter,
  bBetter,
}: {
  label: string;
  a: string;
  b: string;
  aBetter: boolean;
  bBetter: boolean;
}) {
  const cell = (better: boolean) =>
    `text-right font-mono text-[12px] tabular-nums ${
      better ? "text-good" : "text-ink"
    }`;
  return (
    <>
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      <span className={cell(aBetter)}>{a}</span>
      <span className={cell(bBetter)}>{b}</span>
    </>
  );
}

/** Per-step odds chain: one pill per breed step, colored by `probBand`. */
function OddsChain({ root }: { root: PlanNode }) {
  const probs = breedProbs(root);
  if (probs.length === 0)
    return <span className="text-[11px] text-ink-faint">no breed steps</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {probs.map((p, i) => {
        const band = probBand(p);
        return (
          <span
            key={i}
            className={`rounded-sm border px-1 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${band.text} ${band.ring}`}
          >
            {Math.round(p * 100)}%
          </span>
        );
      })}
    </div>
  );
}

function ComparePanel({
  a,
  b,
  onClear,
}: {
  a: SavedPlan;
  b: SavedPlan;
  onClear: () => void;
}) {
  const pa = savedActivePlan(a);
  const pb = savedActivePlan(b);
  if (!pa || !pb) return null;

  const oddsA = overallOdds(pa.root);
  const oddsB = overallOdds(pb.root);

  return (
    <div className="border-b border-line bg-abyss/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber">
          Compare
        </span>
        <button
          type="button"
          onClick={onClear}
          className="font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-dim"
        >
          Clear
        </button>
      </div>
      <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-x-3 gap-y-2">
        {/* Header row: plan names. */}
        <span />
        <span className="truncate text-right text-[11px] font-medium text-ink-dim" title={a.name}>
          {a.name}
        </span>
        <span className="truncate text-right text-[11px] font-medium text-ink-dim" title={b.name}>
          {b.name}
        </span>

        <StatRow
          label="Time"
          a={formatDuration(pa.total_time_secs)}
          b={formatDuration(pb.total_time_secs)}
          aBetter={pa.total_time_secs < pb.total_time_secs}
          bBetter={pb.total_time_secs < pa.total_time_secs}
        />
        <StatRow
          label="Steps"
          a={String(pa.total_steps)}
          b={String(pb.total_steps)}
          aBetter={pa.total_steps < pb.total_steps}
          bBetter={pb.total_steps < pa.total_steps}
        />
        <StatRow
          label="Wild"
          a={String(pa.total_wild_pals)}
          b={String(pb.total_wild_pals)}
          aBetter={pa.total_wild_pals < pb.total_wild_pals}
          bBetter={pb.total_wild_pals < pa.total_wild_pals}
        />
        <StatRow
          label="Overall"
          a={`${(oddsA * 100).toFixed(oddsA < 0.1 ? 1 : 0)}%`}
          b={`${(oddsB * 100).toFixed(oddsB < 0.1 ? 1 : 0)}%`}
          aBetter={oddsA > oddsB}
          bBetter={oddsB > oddsA}
        />
      </div>
      {/* Per-step odds chains (below the numeric grid). */}
      <div className="mt-3 flex flex-col gap-2">
        <div>
          <div className="mb-1 truncate text-[10px] text-ink-faint">{a.name}</div>
          <OddsChain root={pa.root} />
        </div>
        <div>
          <div className="mb-1 truncate text-[10px] text-ink-faint">{b.name}</div>
          <OddsChain root={pb.root} />
        </div>
      </div>
      <p className="mt-2.5 text-[10.5px] leading-relaxed text-ink-faint">
        Lower time/steps/wild and higher overall odds are tinted green per row.
        No winner is picked &mdash; a faster plan may carry worse odds.
      </p>
    </div>
  );
}

// --- Drawer ------------------------------------------------------------------

export interface PlansDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The live save folder, to flag saved plans solved against a different save. */
  currentSaveDir: string;
  /** Species name -> internal id, for target icons. */
  nameToId: Map<string, string>;
  /** Load (rehydrate) a saved plan into the Solver view. */
  onLoad: (saved: SavedPlan) => void;
  /** Import a decoded plan code (Solver re-solves it via the live path). */
  onImport: (decoded: DecodedPlanCode) => void;
}

export function PlansDrawer({
  open,
  onClose,
  currentSaveDir,
  nameToId,
  onLoad,
  onImport,
}: PlansDrawerProps) {
  const [plans, setPlans] = useState<SavedPlan[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [importCode, setImportCode] = useState("");
  const [importErr, setImportErr] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const reload = () => setPlans(listSavedPlans());

  // Re-read storage each time the drawer opens (a save from the header may have
  // landed while it was closed); drop stale compare selections.
  useEffect(() => {
    if (open) {
      reload();
      setCompareIds([]);
      setRenamingId(null);
      setImportErr(null);
    }
  }, [open]);

  // Escape closes the drawer (when not mid-rename).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !renamingId) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, renamingId, onClose]);

  useEffect(() => {
    if (renamingId) renameRef.current?.select();
  }, [renamingId]);

  const compared = useMemo(
    () => compareIds.map((id) => plans.find((p) => p.id === id)).filter(Boolean) as SavedPlan[],
    [compareIds, plans],
  );

  function toggleCompare(id: string) {
    setCompareIds((ids) => {
      if (ids.includes(id)) return ids.filter((x) => x !== id);
      if (ids.length >= 2) return [ids[1], id]; // keep newest two
      return [...ids, id];
    });
  }

  function startRename(p: SavedPlan) {
    setRenamingId(p.id);
    setDraft(p.name);
  }
  function commitRename() {
    if (renamingId) {
      renameSavedPlan(renamingId, draft);
      setRenamingId(null);
      reload();
    }
  }
  function remove(id: string) {
    deleteSavedPlan(id);
    setCompareIds((ids) => ids.filter((x) => x !== id));
    reload();
  }

  function doImport() {
    try {
      const decoded = decodePlanCode(importCode);
      setImportErr(null);
      setImportCode("");
      onImport(decoded);
      onClose();
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e));
    }
  }

  const actionBtn =
    "flex h-7 w-7 items-center justify-center rounded-md border border-line bg-raised text-ink-faint transition-colors hover:bg-hover hover:text-ink";

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
        aria-label="Saved breeding plans"
        aria-hidden={!open}
        className={`fixed right-0 top-0 z-50 flex h-full w-[400px] max-w-full flex-col border-l border-line bg-panel transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line bg-raised px-4 py-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-amber">
              Plans
            </div>
            <h2 className="font-display text-base font-bold tracking-wide text-ink">
              Saved plans
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close plans drawer"
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            <CloseGlyph />
          </button>
        </div>

        {/* Import code */}
        <div className="border-b border-line px-4 py-3">
          <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Import plan code
          </label>
          <div className="flex gap-2">
            <input
              value={importCode}
              onChange={(e) => {
                setImportCode(e.currentTarget.value);
                setImportErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") doImport();
              }}
              placeholder={"Paste a plan code\u2026"}
              className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-2.5 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/60 focus:outline-none"
            />
            <button
              type="button"
              onClick={doImport}
              disabled={!importCode.trim()}
              className="shrink-0 rounded-md bg-raised border border-line px-3 py-1.5 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Import
            </button>
          </div>
          {importErr && <p className="mt-1.5 text-[11px] text-bad">{importErr}</p>}
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            Imported codes re-solve against your current save &mdash; the tree
            reflects the pals you own now.
          </p>
        </div>

        {/* Compare panel */}
        {compared.length === 2 && (
          <ComparePanel
            a={compared[0]}
            b={compared[1]}
            onClear={() => setCompareIds([])}
          />
        )}

        {/* List */}
        <div className="min-h-0 flex-1 overflow-auto">
          {plans.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <div className="font-display text-sm text-ink-dim">
                No saved plans yet
              </div>
              <p className="text-[12px] leading-relaxed text-ink-faint">
                Solve a breeding path, then hit <span className="text-ink-dim">Save plan</span>{" "}
                to keep it here for later or to compare options.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {plans.map((p) => {
                const plan = savedActivePlan(p);
                const targetId = nameToId.get(p.request.target_species) ?? null;
                const mismatch =
                  currentSaveDir.trim() !== "" && p.saveDir !== currentSaveDir;
                const selected = compareIds.includes(p.id);
                const compareDisabled = compareIds.length >= 2 && !selected;
                return (
                  <li
                    key={p.id}
                    className={`flex items-start gap-3 border-b border-line-soft px-4 py-3 transition-colors ${
                      selected ? "bg-amber/[0.05]" : "hover:bg-hover/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={compareDisabled}
                      onChange={() => toggleCompare(p.id)}
                      aria-label={`Compare ${p.name}`}
                      className="mt-1 h-3.5 w-3.5 shrink-0 accent-amber disabled:opacity-30"
                    />
                    <PalIcon
                      id={targetId}
                      name={p.request.target_species}
                      size={34}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      {renamingId === p.id ? (
                        <input
                          ref={renameRef}
                          value={draft}
                          onChange={(e) => setDraft(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={commitRename}
                          className="w-full rounded-md border border-amber/60 bg-abyss px-1.5 py-0.5 text-[13px] text-ink focus:outline-none"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-ink" title={p.name}>
                            {p.name}
                          </span>
                          {mismatch && (
                            <span
                              className="shrink-0 text-warn"
                              title="Saved against a different save folder"
                            >
                              <WarnGlyph />
                            </span>
                          )}
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
                                <span className="text-el-leaf">{plan.total_wild_pals}</span> wild
                              </span>
                            )}
                          </>
                        )}
                        <span className="text-ink-faint">{relTime(p.created)}</span>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onLoad(p)}
                          className="rounded-md bg-amber/10 border border-amber/40 px-2.5 py-1 text-[11px] font-medium text-amber transition-colors hover:bg-amber/20"
                        >
                          Load
                        </button>
                        <button
                          type="button"
                          onClick={() => startRename(p)}
                          aria-label="Rename plan"
                          title="Rename"
                          className={actionBtn}
                        >
                          <PencilGlyph />
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(p.id)}
                          aria-label="Delete plan"
                          title="Delete"
                          className={`${actionBtn} hover:border-bad/40 hover:text-bad`}
                        >
                          <TrashGlyph />
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
