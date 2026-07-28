// The Solver's "EXTRA PASSIVES" tolerance control, mapped to
// `SolveRequest.max_irrelevant` — how many off-target passives the solver may
// let ride on intermediate parents. A stricter cap yields a cleaner final pal
// but usually costs more eggs; "Any" (4) never adds cleanup-only steps.
//
// The stored preference is either "auto" (track the current query's context) or
// an explicit "set" value that sticks for the session and persists. `resolve`
// turns a preference + the current required-passive count into the value the
// request builder sends. Contextual default: no required passives -> "Any" (4)
// so the solver never inserts pointless laundering steps; any required passive
// -> "≤ 1" (1) so lines stay clean by default.

/** The four `max_irrelevant` values the control exposes. `4` = "effectively
 *  any" (the solver clamps its tolerance to 0..=4). */
export type ExtraPassivesValue = 0 | 1 | 2 | 4;

/** Persisted preference: untouched by the user (tracks context) or an explicit
 *  pick that sticks for the session. Shape stored verbatim in localStorage. */
export type ExtraPassivesPref =
  | { mode: "auto" }
  | { mode: "set"; value: ExtraPassivesValue };

/** localStorage key for the persisted preference. */
const STORAGE_KEY = "pal-lab.extraPassives";

/** Segmented-control options, loosest-first — the pinned UI labels. */
export const EXTRA_PASSIVES_OPTIONS: {
  value: ExtraPassivesValue;
  label: string;
}[] = [
  { value: 4, label: "Any" },
  { value: 2, label: "\u2264 2" },
  { value: 1, label: "\u2264 1" },
  { value: 0, label: "None" },
];

/** Contextual default: no required passives -> "Any" (4); any required passive
 *  -> "≤ 1" (1). */
export function contextualExtraPassives(requiredCount: number): ExtraPassivesValue {
  return requiredCount === 0 ? 4 : 1;
}

/** Resolve a preference against the current query to the `max_irrelevant` the
 *  request builder sends: an explicit choice wins; "auto" tracks the context. */
export function resolveExtraPassives(
  pref: ExtraPassivesPref,
  requiredCount: number,
): ExtraPassivesValue {
  return pref.mode === "set" ? pref.value : contextualExtraPassives(requiredCount);
}

/** True for a valid `max_irrelevant` control value (0/1/2/4). Exported so the
 *  Solver form can reflect a loaded request's tolerance in the control. */
export function isExtraPassivesValue(v: unknown): v is ExtraPassivesValue {
  return v === 0 || v === 1 || v === 2 || v === 4;
}

/** Read the persisted preference; defaults to auto on absent/corrupt storage. */
export function readExtraPassives(): ExtraPassivesPref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: "auto" };
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "mode" in parsed &&
      parsed.mode === "set" &&
      "value" in parsed &&
      isExtraPassivesValue(parsed.value)
    ) {
      return { mode: "set", value: parsed.value };
    }
    return { mode: "auto" };
  } catch {
    return { mode: "auto" };
  }
}

/** Persist the preference (best-effort; the control is a convenience). */
export function writeExtraPassives(pref: ExtraPassivesPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Storage full / unavailable — not load-bearing.
  }
}
