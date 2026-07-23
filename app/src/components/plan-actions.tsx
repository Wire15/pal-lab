// PLAN ACTIONS — the shared single-solve results-header cluster for the Solver
// and the IV Lab: Save plan (with its inline naming bar), PNG export, Copy code,
// and the PLANS drawer, plus the "loaded from a saved plan" staleness banner.
// Both views drive the SAME view-agnostic saved-plan store (plans-drawer) and
// plan-export codec over the SAME toolbar; only the briefing form a loaded /
// imported request is applied back into differs (the `applyRequestToForm`
// callback). Extracted verbatim from Solver.tsx so the two views can't drift.
//
// The hook returns three placement slots because the pieces live in three spots
// of a results pane: `headerButtons` in the plan-tabs row's right slot,
// `banners` (staleness + naming bar) above the plan results, and `drawer`
// mounted once at the section end. `closeNaming` lets a view RESET dismiss the
// naming bar so the next solve starts clean.

import { useRef, useState, type ReactNode } from "react";
import type { BreedingPlan, SolveRequest } from "../lib/types";
import type { RestoredInfo, RestoredPlan, SolveSpec } from "../lib/use-solve";
import {
  downloadBlob,
  encodePlanCode,
  planPngFilename,
  renderPlanPng,
  type DecodedPlanCode,
} from "./plan-export";
import {
  PlansDrawer,
  defaultPlanName,
  saveNewPlan,
  type SavedPlan,
} from "./plans-drawer";

export interface UsePlanActionsInput {
  /** Ranked plans of the current result (null before the first solve). */
  plans: BreedingPlan[] | null;
  /** Whether the current result fell back to catch-assisted plans (saved with it). */
  fallbackUsed: boolean;
  /** Active plan tab index — the plan Save / PNG / Copy act on. */
  activePlan: number;
  /** Full request of the current result (save / export / copy encode it). */
  lastRequest: SolveRequest | null;
  /** Species name -> internal id, for the drawer's target icons + PNG render. */
  nameToId: Map<string, string>;
  /** Live save folder (saved plans are tagged with it). */
  saveDir: string;
  /** Saved-plan meta when the current result was restored (drives staleness banner). */
  restoredFrom: RestoredInfo | null;
  /** Restore a saved plan's result — from the shared {@link useSolve}. */
  rehydrate: (saved: RestoredPlan) => void;
  /** Re-solve a request live (import-code path); the hook re-injects setup/cake. */
  solve: (spec: SolveSpec) => Promise<void>;
  /** Apply a loaded / imported request back onto the view's own briefing form. */
  applyRequestToForm: (r: SolveRequest) => void;
}

export interface PlanActions {
  /** Right-aligned toolbar buttons (Save / PNG / Copy / Plans + the flash note). */
  headerButtons: ReactNode;
  /** Staleness banner + inline naming bar, rendered above the plan results. */
  banners: ReactNode;
  /** The PLANS drawer (mount once at the results-section end). */
  drawer: ReactNode;
  /** Close the naming bar — call from a view RESET so a re-solve starts clean. */
  closeNaming: () => void;
}

export function usePlanActions({
  plans,
  fallbackUsed,
  activePlan,
  lastRequest,
  nameToId,
  saveDir,
  restoredFrom,
  rehydrate,
  solve,
  applyRequestToForm,
}: UsePlanActionsInput): PlanActions {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // The active plan drives the single-solve toolbar actions (Save / PNG / Copy).
  const activePlanObj = plans && plans.length > 0 ? plans[activePlan] : null;

  // Transient header confirmation ("Plan saved", "PNG exported", ...).
  const flashTimer = useRef<number | null>(null);
  function showFlash(msg: string) {
    setFlash(msg);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2200);
  }

  // Load a saved plan: restore the form + rehydrate the result (staleness-flagged).
  function loadSaved(saved: SavedPlan) {
    applyRequestToForm(saved.request);
    rehydrate(saved);
    setDrawerOpen(false);
  }

  // Import a plan code: replay the request live so the tree is honest against
  // the current save (the hook injects the live setup/cake over the decoded ones).
  function importPlanCode(decoded: DecodedPlanCode) {
    applyRequestToForm(decoded.request);
    solve(decoded.request);
  }

  function beginSave() {
    if (!activePlanObj) return;
    setNameDraft(defaultPlanName(activePlanObj.root.species_name, activePlanObj));
    setNaming(true);
  }
  function commitSave() {
    if (!activePlanObj || !lastRequest || !plans) return;
    saveNewPlan({
      name:
        nameDraft.trim() ||
        defaultPlanName(activePlanObj.root.species_name, activePlanObj),
      saveDir,
      request: lastRequest,
      response: { plans, fallback_used: fallbackUsed },
      activePlan,
    });
    setNaming(false);
    showFlash("Plan saved");
  }

  async function exportPng() {
    if (!activePlanObj) return;
    setExporting(true);
    try {
      const blob = await renderPlanPng(activePlanObj, nameToId, {
        targetName: activePlanObj.root.species_name,
      });
      downloadBlob(blob, planPngFilename(activePlanObj.root.species_name));
      showFlash("PNG exported");
    } catch (e) {
      showFlash(`Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setExporting(false);
    }
  }

  async function copyCode() {
    if (!lastRequest) return;
    try {
      await navigator.clipboard.writeText(
        encodePlanCode(lastRequest, activePlan),
      );
      showFlash("Plan code copied");
    } catch {
      showFlash("Clipboard blocked");
    }
  }

  const headerButtons = (
    <>
      {flash && (
        <span className="font-mono text-[11px] text-good">{flash}</span>
      )}
      <button
        type="button"
        onClick={beginSave}
        disabled={!activePlanObj || !lastRequest}
        className="rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        Save plan
      </button>
      <button
        type="button"
        onClick={exportPng}
        disabled={!activePlanObj || exporting}
        className="rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {exporting ? "PNG\u2026" : "PNG"}
      </button>
      <button
        type="button"
        onClick={copyCode}
        disabled={!lastRequest}
        className="rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        Copy code
      </button>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1 text-[12px] font-medium text-amber transition-colors hover:bg-amber/20"
      >
        Plans
      </button>
    </>
  );

  const banners = (
    <>
      {restoredFrom && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber/30 bg-amber/[0.07] px-4 py-2">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-amber">
            Saved {new Date(restoredFrom.created).toLocaleDateString()}
          </span>
          <span className="text-[12px] leading-relaxed text-ink-dim">
            Loaded from &ldquo;{restoredFrom.name}&rdquo; &mdash; your roster
            may have changed since. Re-solve for a fresh plan.
          </span>
        </div>
      )}
      {naming && activePlanObj && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-raised px-4 py-2">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Name this plan
          </span>
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSave();
              if (e.key === "Escape") setNaming(false);
            }}
            className="min-w-0 flex-1 rounded-md border border-amber/60 bg-abyss px-2.5 py-1 text-[13px] text-ink focus:outline-none"
          />
          <button
            type="button"
            onClick={commitSave}
            className="rounded-md bg-amber px-3 py-1 text-[12px] font-semibold text-abyss transition-colors hover:bg-amber-bright"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setNaming(false)}
            className="rounded-md border border-line bg-raised px-3 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );

  const drawer = (
    <PlansDrawer
      open={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      currentSaveDir={saveDir}
      nameToId={nameToId}
      onLoad={loadSaved}
      onImport={importPlanCode}
    />
  );

  return { headerButtons, banners, drawer, closeNaming: () => setNaming(false) };
}
