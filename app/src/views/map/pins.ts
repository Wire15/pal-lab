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

export type PoiKind = "fast_travel" | "alpha" | "effigy" | "bounty";

/** One resolved POI pin in world space. `found` is meaningful only for
 *  fast-travel (unlocked) and effigies (collected); it stays false for alpha /
 *  bounty pins (no per-pin discovered state in scope) and whenever the pin has
 *  no guid to match. `known` gates the fog spoiler rule: an unlocked
 *  fast-travel or a found effigy is already known to the player, so it shows
 *  through fog. */
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
  /** Fast-travel / bounty display name (null for the unnamed variety). */
  name?: string | null;
}

/** Per-layer found/total counts for the filter panel rows. `joined` is false
 *  when the counts come from raw flag-set sizes (no POI carried a guid, so no
 *  per-pin match was possible). */
export interface PoiCounts {
  fastTravel: { found: number; total: number };
  effigies: { found: number; total: number };
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

/** Build the POI pin list + per-layer counts for the active player scope. */
export function buildPois(
  data: MapData,
  state: MapState | null,
  scope: string,
): { pins: PoiPin[]; counts: PoiCounts } {
  const players = state?.players ?? [];
  const unlockedFt = unionFlags(players, scope, (p) => p.fast_travel_unlocked);
  const foundEff = unionFlags(players, scope, (p) => p.effigies_found);

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
      name: p.name ?? null,
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
    bounties: bounties.length,
    alphas: data.bosses.length,
    joined,
  };

  return { pins, counts };
}
