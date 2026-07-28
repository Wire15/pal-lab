// Per-egg factor breakdown for a bred plan step (`PlanNode.odds`). The solver
// reports the acceptance odds as a product of independent factors; this turns
// that into labelled display rows so the UI can explain the single % chip
// instead of hiding the reasoning. Pure + display-agnostic so it is unit-
// testable and shared by the plan list view and the node detail panel.

import type { StepOdds } from "./types";

/** One labelled breakdown row: mono label + preformatted percent value. */
export interface OddsRow {
  label: string;
  value: string;
}

/** Format a 0-1 probability as a whole-percent string. */
function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/**
 * Factor rows for a step's `odds`, in the pinned order:
 *   Passives, Move, IVs, Gender.
 * `Move` appears only when a required move threads THIS step (`move_pass`
 * present); `IVs` only when the IV factor actually bites (`ivs < 1`, i.e. it is
 * not a no-op); `Gender` only when the child gender is constrained here
 * (`gender` present). `Passives` is always shown for a bred step.
 */
export function buildOddsRows(odds: StepOdds): OddsRow[] {
  const rows: OddsRow[] = [{ label: "Passives", value: pct(odds.passives) }];
  if (odds.move_pass != null) rows.push({ label: "Move", value: pct(odds.move_pass) });
  if (odds.ivs < 1) rows.push({ label: "IVs", value: pct(odds.ivs) });
  if (odds.gender != null) rows.push({ label: "Gender", value: pct(odds.gender) });
  return rows;
}

/** The trailing "→ ~N eggs" summary line for a step's expected-egg count. */
export function eggsSummary(expectedEggs: number): string {
  return `\u2192 ~${Math.max(1, Math.round(expectedEggs))} eggs`;
}
