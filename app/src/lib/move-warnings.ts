// Client-side, ADVISORY warnings for the Solver's "Required moves" picker. These
// are non-blocking hints only — the solver's server-side normalization (contract:
// unknown id => request error; learnset-of-target moves => auto-satisfied
// levelup_moves; the rest breeding-required, at most one threaded, the remainder
// via Skill Fruit) is the authority, and NoPathReason::MissingMoveCarrier is the
// definitive no-path message. We surface the two mistakes a user can catch before
// solving: picking a move that can neither be bred nor taught, and picking more
// than one non-learnset move (only one threads through a breeding line).
//
// The inherit RATE (~50%/egg) is community-measured, not code-verified; whether a
// move is inheritable at all (`can_inherit`) and whether a Skill Fruit exists
// (`has_skill_fruit`) come from the pack.

import type { ActiveSkills } from "./types";

/** One advisory warning about the current move selection. `text` is the exact
 *  shipped copy; `moves` are the display names it refers to, for a lead-in. */
export interface MoveWarning {
  kind: "unteachable" | "too-many";
  text: string;
  moves: string[];
}

/** Is this a breeding-required move? (not in the target's learnset, and known to
 *  the active-skills map — unknown ids are left to the server to reject). */
function isBreedingRequired(id: string, activeMap: ActiveSkills, learnset: Set<string>): boolean {
  return !learnset.has(id) && activeMap[id] !== undefined;
}

/**
 * Advisory warnings for a set of selected required-move ids.
 * - `unteachable`: a non-learnset move that is neither inheritable nor fruitable
 *   (one warning per such move) — the solver will report no path.
 * - `too-many`: more than one non-learnset move that IS breedable/fruitable —
 *   only one threads through a breeding line, the extras need Skill Fruits.
 * Learnset moves are auto-satisfied (levelable) and never warned about.
 */
export function classifyMoveWarnings(
  moves: string[],
  activeMap: ActiveSkills,
  learnset: Set<string>,
): MoveWarning[] {
  const warnings: MoveWarning[] = [];

  const unteachable = moves.filter((id) => {
    if (!isBreedingRequired(id, activeMap, learnset)) return false;
    const sk = activeMap[id];
    return !sk.can_inherit && !sk.has_skill_fruit;
  });
  for (const id of unteachable) {
    warnings.push({
      kind: "unteachable",
      text: "can\u2019t be bred or taught \u2014 the solver will report no path",
      moves: [activeMap[id]?.name ?? id],
    });
  }

  const threadable = moves.filter((id) => {
    if (!isBreedingRequired(id, activeMap, learnset)) return false;
    const sk = activeMap[id];
    return sk.can_inherit || sk.has_skill_fruit;
  });
  if (threadable.length > 1) {
    warnings.push({
      kind: "too-many",
      text: "only one move can pass down per breeding line \u2014 extras need Skill Fruits",
      moves: threadable.map((id) => activeMap[id]?.name ?? id),
    });
  }

  return warnings;
}
