// IV Lab donor ranking. Given the owned pals relevant to a target line (same
// species + any owned pal that shows up in the returned plans), surface the best
// breeding parents: the top few per individual stat and the top few by IV sum.
// Pure so the ranking is trivial to reason about (and screenshot-stable).

import type { OwnedPal } from "../../lib/types";

export type StatKey = "hp" | "attack" | "defense";

/** The four donor buckets the panel renders, in display order. */
export type DonorBucket = StatKey | "sum";

export interface DonorGroup {
  /** Which score this group ranks by (a stat, or the IV sum). */
  key: DonorBucket;
  /** Section label ("Top HP", "Top overall", …). */
  label: string;
  /** Up to `limit` best donors for this bucket, strongest first. */
  pals: OwnedPal[];
}

/** IV sum across the three breedable talents. */
export function ivSum(p: OwnedPal): number {
  return p.ivs.hp + p.ivs.attack + p.ivs.defense;
}

const GROUPS: { key: DonorBucket; label: string; score: (p: OwnedPal) => number }[] = [
  { key: "hp", label: "Top HP", score: (p) => p.ivs.hp },
  { key: "attack", label: "Top ATK", score: (p) => p.ivs.attack },
  { key: "defense", label: "Top DEF", score: (p) => p.ivs.defense },
  { key: "sum", label: "Top overall", score: ivSum },
];

/**
 * Rank donor candidates into the four buckets, keeping the `limit` best of each.
 * Ties break by IV sum, then level (both descending) so the ordering is stable
 * and a well-rounded pal outranks a one-trick pal at equal lead stat.
 */
export function rankDonors(pals: OwnedPal[], limit = 3): DonorGroup[] {
  return GROUPS.map(({ key, label, score }) => ({
    key,
    label,
    pals: [...pals]
      .sort(
        (a, b) =>
          score(b) - score(a) || ivSum(b) - ivSum(a) || b.level - a.level,
      )
      .slice(0, limit),
  }));
}
