// The POI pin model + the found/unlocked join (contract R3). This turns the pak
// pin arrays (fast-travel statues, field bosses, effigies, bounties) plus the
// save's per-player flag sets into a flat, layer-tagged pin list the overlay
// renders, and computes the per-layer "found / total" counts the filter panel
// shows.
//
// R3 join semantics: each pak fast-travel / effigy POI in map-data.json carries
// a `guid` — the world-static actor instance GUID, formatted as 32-char
// UPPERCASE UE-Digits hex — that matches the keys in a player's
// `fast_travel_unlocked` / `effigies_found` flag arrays EXACTLY. A pin is
// "found/unlocked" for the current player scope iff some scoped player's flag
// set contains that pin's guid (plain string equality — no coordinate join, no
// radius). When a pin's guid is null (the extractor could not resolve one) that
// pin renders neutral, and when NO POI carries a guid at all the counts fall
// back to the raw flag-set sizes (honest "you've unlocked N" rather than a
// fabricated per-pin state).

import type { MapData } from "../../lib/map-coords";
import type { MapState } from "../../lib/types";
import { baseSpeciesId } from "../../lib/map-data";

export type PoiKind = "fast_travel" | "alpha" | "effigy" | "bounty" | "tower";

/** One resolved POI pin in world space. `found` is meaningful only for
 *  fast-travel (unlocked), effigies (collected), and towers (conquered); it
 *  stays false for alpha / bounty pins (no per-pin discovered state in scope)
 *  and whenever the pin has no id to match. `known` gates the fog spoiler rule:
 *  an unlocked fast-travel, a found effigy, or a tower (a landmark visible from
 *  the start) is already known to the player, so it shows through fog. */
export interface PoiPin {
  key: string;
  kind: PoiKind;
  map: string;
  x: number;
  y: number;
  found: boolean;
  known: boolean;
  /** Alpha only: base species id (for the portrait + dex cross-link). */
  speciesId?: string;
  /** Alpha only: field-boss level (hover chip). */
  level?: number;
  /** Fast-travel / bounty / tower display name (null for the unnamed variety). */
  name?: string | null;
}

/** Per-layer found/total counts for the filter panel rows. `joined` is false
 *  when the counts come from raw flag-set sizes (no POI carried a guid, so no
 *  per-pin match was possible). `towers.joined` is independent: towers join on
 *  a per-POI `key` against the save's `towers_defeated`, absent on older data. */
export interface PoiCounts {
  fastTravel: { found: number; total: number };
  effigies: { found: number; total: number };
  towers: { found: number; total: number; joined: boolean };
  bounties: number;
  alphas: number;
  joined: boolean;
}

/** Union the scoped players' flag arrays into one Set. `scope` is a player uid
 *  hex or `"all"` (every player's flags unioned). Flag keys are already the
 *  32-char UPPERCASE hex the pak guids are matched against — no normalization. */
function unionFlags(
  players: MapState["players"],
  scope: string,
  pick: (p: MapState["players"][number]) => string[],
): Set<string> {
  const out = new Set<string>();
  for (const p of players) {
    if (scope !== "all" && p.uid !== scope) continue;
    for (const g of pick(p)) out.add(g);
  }
  return out;
}

/** Turn a bounty's boss CharacterID into a readable enemy-type label. Bounty
 *  names are procedural (always null), so the wanted-target TYPE is the useful
 *  label: strip a leading `BOSS_`, then split on underscores, CamelCase, and
 *  letter→digit boundaries. `BOSS_FireCult_FlameThrower` -> "Fire Cult Flame
 *  Thrower", `VikingElite` -> "Viking Elite", `BOSS_Male_Soldier02` -> "Male
 *  Soldier 02". */
function humanizeCid(cid: string): string {
  return cid
    .replace(/^BOSS_/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the POI pin list + per-layer counts for the active player scope. */
export function buildPois(
  data: MapData,
  state: MapState | null,
  scope: string,
): { pins: PoiPin[]; counts: PoiCounts } {
  const players = state?.players ?? [];
  const unlockedFt = unionFlags(players, scope, (p) => p.fast_travel_unlocked);
  const foundEff = unionFlags(players, scope, (p) => p.effigies_found);
  // `towers_defeated` is an additive MapPlayerState field (TowerData/T1). Read
  // it through a checked guard so this degrades cleanly both before the type
  // lands and against older save states that predate the field.
  const conqueredTowers = unionFlags(players, scope, (p) =>
    "towers_defeated" in p && Array.isArray(p.towers_defeated)
      ? p.towers_defeated
      : [],
  );

  // The join is "live" only when the extractor has stamped guids onto the POIs
  // (R1). Absent guids everywhere => degrade to counts-only + neutral pins.
  const hasFtGuids = data.fast_travel.some((p) => p.guid != null);
  const hasEffGuids = data.effigies.some((p) => p.guid != null);
  const joined = hasFtGuids || hasEffGuids;

  const pins: PoiPin[] = [];
  let ftFound = 0;
  let effFound = 0;

  data.fast_travel.forEach((p, i) => {
    const found = p.guid != null && unlockedFt.has(p.guid);
    if (found) ftFound++;
    pins.push({
      key: `ft${i}`,
      kind: "fast_travel",
      map: p.map,
      x: p.x,
      y: p.y,
      found,
      known: found,
      name: p.name ?? null,
    });
  });

  data.effigies.forEach((p, i) => {
    const found = p.guid != null && foundEff.has(p.guid);
    if (found) effFound++;
    pins.push({
      key: `ef${i}`,
      kind: "effigy",
      map: p.map,
      x: p.x,
      y: p.y,
      found,
      known: found,
    });
  });

  data.bosses.forEach((b, i) => {
    pins.push({
      key: `bs${i}`,
      kind: "alpha",
      map: b.map,
      x: b.x,
      y: b.y,
      found: false,
      known: false,
      speciesId: baseSpeciesId(b.species),
      level: b.level,
    });
  });

  const bounties = data.bounties ?? [];
  bounties.forEach((p, i) => {
    pins.push({
      key: `bt${i}`,
      kind: "bounty",
      map: p.map,
      x: p.x,
      y: p.y,
      found: false,
      known: false,
      name: p.name ?? (p.cid ? humanizeCid(p.cid) : null),
    });
  });

  // Syndicate towers (Map Wave 3): always `known` (major landmarks visible on
  // the in-game map from the start, so NEVER fog-gated). `found` = conquered by
  // a scoped player. The join is live only when a POI carries a `key` matching
  // the save's `towers_defeated`; absent keys => neutral pins + total-only count.
  const towers = data.towers ?? [];
  // Only towers with a `key` carry a per-player reached flag; the keyless
  // (Feybreak-era) towers still render but can never be tracked, so they are
  // excluded from the reached/total denominator (which could otherwise never
  // hit 100%). They stay visible as always-not-reached landmark pins.
  const keyedTowers = towers.filter((t) => t.key != null).length;
  const hasTowerKeys = keyedTowers > 0;
  let towerFound = 0;
  towers.forEach((t, i) => {
    const found = t.key != null && conqueredTowers.has(t.key);
    if (found) towerFound++;
    pins.push({
      key: `tw${i}`,
      kind: "tower",
      map: t.map,
      x: t.x,
      y: t.y,
      found,
      known: true,
      name: t.name ?? null,
    });
  });

  const counts: PoiCounts = {
    // With a live join the "found" tally is the number of pak pins whose guid a
    // scoped player has unlocked. Without guids it falls back to the raw
    // unlocked-flag count (clamped to the pak total so it never over-reports).
    fastTravel: {
      found: hasFtGuids
        ? ftFound
        : Math.min(unlockedFt.size, data.fast_travel.length),
      total: data.fast_travel.length,
    },
    effigies: {
      found: hasEffGuids
        ? effFound
        : Math.min(foundEff.size, data.effigies.length),
      total: data.effigies.length,
    },
    towers: {
      // With keys, "found" = towers a scoped player has reached and "total" is
      // the trackable (keyed) tower count — keyless towers are excluded so the
      // readout can reach 100%. Without any keys, fall back to the raw
      // reached-flag count over all towers (clamped so it never over-reports).
      found: hasTowerKeys
        ? towerFound
        : Math.min(conqueredTowers.size, towers.length),
      total: hasTowerKeys ? keyedTowers : towers.length,
      joined: hasTowerKeys,
    },
    bounties: bounties.length,
    alphas: data.bosses.length,
    joined,
  };

  return { pins, counts };
}
