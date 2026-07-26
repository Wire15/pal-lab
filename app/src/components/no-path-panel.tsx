// The centered "no path found" empty state, shared by the Solver and IV Lab
// results panes. Both render the same structured no-path DIAGNOSIS list (one
// actionable line per `NoPathReason`) when the last solve returned zero plans
// with a diagnosis, falling back to a plain view-specific line for legacy
// responses that predate the diagnosis field. The diagnosis-to-copy mapping
// lives here so the two views never drift.

import type { ReactNode } from "react";
import type { NoPathReason } from "../lib/types";

/** One actionable line of no-path copy per structured diagnosis reason. Terse,
 *  mono voice; the panel lists one row per reason. */
function diagnosisCopy(reason: NoPathReason, maxSteps: number): string {
  switch (reason.kind) {
    case "missing_passive_carrier":
      return `No pal you own carries ${reason.passive_name}. Wild pals can't introduce required passives — catch a ${reason.passive_name} carrier and re-solve.`;
    case "target_species_unreachable":
      return reason.min_steps == null
        ? `Target isn't producible by breeding from your pals — no recipe chain reaches it. It may only be catchable.`
        : `Target isn't reachable from your pals. Breedable in ${reason.min_steps} steps from species you don't own — add a source pal or include pals you don't own.`;
    case "step_cap_too_low":
      return `Reachable in ${reason.needed} steps but cap is ${reason.cap} — raise Max steps to ${reason.needed}.`;
    case "gender_bottleneck":
      return `Every ${reason.species_name} you own shares one gender, so no pair can breed — add an opposite-gender ${reason.species_name} or include pals you don't own.`;
    case "exhausted_search":
      return `No viable pairing in your pool reaches the target within ${maxSteps} steps. Try raising Max steps, relaxing passives, or including pals you don't own.`;
  }
}

/** Centered empty state for a zero-plan solve: a headline, then either the
 *  structured diagnosis list (when present) or the caller's legacy fallback
 *  copy (for responses predating the diagnosis field). */
export function NoPathPanel({
  diagnosis,
  maxSteps,
  title,
  fallback,
}: {
  diagnosis: NoPathReason[];
  maxSteps: number;
  title: string;
  fallback: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <div className="font-display text-lg text-ink-dim">{title}</div>
      {diagnosis.length > 0 ? (
        <ul className="flex max-w-md flex-col gap-2 text-left">
          {diagnosis.map((reason, i) => (
            <li
              key={i}
              className="rounded-md border border-line bg-abyss/40 px-3 py-2 text-sm text-ink-faint"
            >
              {diagnosisCopy(reason, maxSteps)}
            </li>
          ))}
        </ul>
      ) : (
        fallback
      )}
    </div>
  );
}
