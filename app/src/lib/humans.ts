// Captured-human display data. Humans (villagers, merchants, faction thugs,
// bounty targets) are presentation-only in Pal Lab — they carry no species
// index or gender and are excluded from breeding/solving. This module resolves
// a save's raw human CharacterID to a name, faction, portrait, work
// suitabilities, and stats.
//
// Data + portraits are vendored from oMaN-Rod/palworld-save-pal (MIT), ultimately
// Palworld game data/art (c) Pocketpair. Regenerate with `bun scripts/gen-humans.mjs`;
// humans.json and the icons under public/humans/ are committed output.

import humansData from "./humans.json";

/** Per-human display record. Keyed in {@link humansData} by exact in-game
 * CharacterID (e.g. `Hunter_Rifle`, `BOSS_Hunter_Rifle`, `SalesPerson`). */
export interface HumanInfo {
  /** The CharacterID this record was resolved from (its key). */
  id: string;
  /** Localized (en) display name, e.g. `Syndicate Gunner`, `Hawk`, `Villager`. */
  name: string;
  /** Faction label derived from the CharacterID, or `Unknown`. */
  faction: string;
  /** Portrait basename (no extension/path); the file is `public/humans/<icon>.webp`. */
  icon: string;
  /** Nonzero work suitabilities, keyed by canonical work name -> level. */
  work: Record<string, number>;
  /** Base stats. */
  stats: { hp: number; attack: number; defense: number };
  /** True for bounty targets (BOSS_-prefixed / is_boss) — they keep the Alpha badge. */
  bounty: boolean;
  /** Merchant/sale price, when the game data carries one. */
  price?: number;
}

type HumanRecord = Omit<HumanInfo, "id">;

const HUMANS = humansData as Record<string, HumanRecord>;

/** Lower-cased id -> canonical id, for case-insensitive fallback lookup. */
const LOWER_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {};
  for (const key of Object.keys(HUMANS)) idx[key.toLowerCase()] = key;
  return idx;
})();

/**
 * Resolve a raw CharacterID to its human display record, or `null` when the id
 * is not a known human. Exact match first, then case-insensitive.
 */
export function getHuman(id: string): HumanInfo | null {
  let key: string | undefined = HUMANS[id] ? id : undefined;
  if (!key) key = LOWER_INDEX[id.toLowerCase()];
  if (!key) return null;
  return { id: key, ...HUMANS[key] };
}

/** URL for a human's bundled portrait: `/humans/<icon>.webp`. */
export function humanIconUrl(info: HumanInfo): string {
  return `/humans/${info.icon}.webp`;
}
