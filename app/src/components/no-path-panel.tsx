import { t, tr, useLocale } from "../i18n";
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
      if (reason.allowed_excluded)
        return t("No pal you own carries {0}, and the Surgery table's implantable-passives list excludes it. Add {1} to that list in Breeding setup (or catch a carrier), then re-solve.", [reason.passive_name, reason.passive_name]);
      return reason.surgery_off
        ? t("No pal you own carries {0}. Wild pals can't introduce required passives — catch a {1} carrier, or enable Surgery table in Breeding setup, then re-solve.", [reason.passive_name, reason.passive_name])
        : t("No pal you own carries {0}. Wild pals can't introduce required passives — catch a {1} carrier and re-solve.", [reason.passive_name, reason.passive_name]);
    case "missing_move_carrier":
      if (!reason.inheritable)
        return t("{0} is exclusive and can't be inherited or taught.", [reason.move_name]);
      return reason.fruit_off && reason.fruit_available
        ? t("No owned pal carries {0} equipped — enable Skill Fruits in Breeding setup or equip {1} on a parent.", [reason.move_name, reason.move_name])
        : t("No owned pal has {0} equipped — equip it on a potential parent and re-read your save.", [reason.move_name]);
    case "target_species_unreachable":
      return reason.min_steps == null
        ? t("Target isn't producible by breeding from your pals — no recipe chain reaches it. It may only be catchable.")
        : t("Target isn't reachable from your pals. Breedable in {0} steps from species you don't own — add a source pal or include pals you don't own.", [reason.min_steps]);
    case "step_cap_too_low":
      return t("Reachable in {0} steps but cap is {1} — raise Max steps to {2}.", [reason.needed, reason.cap, reason.needed]);
    case "gender_bottleneck":
      return t("Every {0} you own shares one gender, so no pair can breed — add an opposite-gender {1} or include pals you don't own.", [reason.species_name, reason.species_name]);
    case "exhausted_search":
      return t("No viable pairing in your pool reaches the target within {0} steps. Try raising Max steps, relaxing passives, or including pals you don't own.", [maxSteps]);
    case "search_budget_exhausted":
      return t("Search hit its {0}s budget before finishing — the target may still be reachable. Narrow the request (fewer passives, lower IV floors, fewer steps) and re-solve.", [reason.budget_secs]);
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
  useLocale();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <div className="font-display text-lg text-ink-dim">{tr(title)}</div>
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
