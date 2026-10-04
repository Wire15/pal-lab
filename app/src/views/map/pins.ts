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

import type { MapData, PoiCategory } from "../../lib/map-coords";
import type { MapState } from "../../lib/types";
import { baseSpeciesId } from "../../lib/map-data";

export type PoiKind = "fast_travel" | "alpha" | "effigy" | "bounty" | "tower" | "poi";

/** One resolved POI pin. `found` means unlocked, collected, or defeated;
 * towers retain their area-reached semantics. Missing save join keys stay
 * neutral. Completed POIs are known and can show through fog. */
export interface PoiPin {
  key: string;
  category?: string;
  defaultVisible?: boolean;
  recurring?: boolean;
  tracked?: boolean;
  detail?: string | null;
  kind: PoiKind;
  map: string;
  x: number;
  y: number;
  found: boolean;
  known: boolean;
  /** Alpha only: base species id (for the portrait + dex cross-link). */
  speciesId?: string;
  /** Effigy item id and icon-manifest key. */
  effigyId?: string;
  iconKey?: string;
  /** Alpha only: field-boss level (hover chip). */
  level?: number;
  /** Fast-travel / effigy / bounty / tower display name (null for the unnamed variety). */
  name?: string | null;
}

/** Per-layer found/total counts for the filter panel rows. `joined` is false
 *  when the counts come from raw flag-set sizes (no POI carried a guid, so no
 *  per-pin match was possible). `towers.joined` is independent: towers join on
 *  a per-POI `key` against the save's `towers_defeated`, absent on older data. */
export interface PoiCounts {
  categories?: (PoiCategory & { found: number; total: number; joined: boolean })[];
  fastTravel: { found: number; total: number };
  effigies: { found: number; total: number };
  effigyTypes: { id: string; name: string; icon: string; found: number; total: number; joined: boolean }[];
  towers: { found: number; total: number; landmarks: number; joined: boolean };
  bounties: { found: number; total: number; joined: boolean };
  alphas: { found: number; total: number; joined: boolean };
  joined: boolean;
}

/** Union the scoped players' flag arrays into one Set. `scope` is a player uid
 *  hex or `"all"` (every player's flags unioned). Keys are compared exactly:
 *  actor GUIDs for collectibles, spawner names for boss victories. */
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
  layer?: string,
): { pins: PoiPin[]; counts: PoiCounts } {
  if (layer) {
    data = { ...data,
      fast_travel: data.fast_travel.filter(p => p.map === layer),
      effigies: data.effigies.filter(p => p.map === layer),
      bosses: data.bosses.filter(p => p.map === layer),
      bounties: data.bounties?.filter(p => p.map === layer),
      towers: data.towers?.filter(p => p.map === layer),
      points_of_interest: data.points_of_interest?.filter(p => p.map === layer),
    };
  }
  const players = state?.players ?? [];
  const unlockedFt = unionFlags(players, scope, (p) => p.fast_travel_unlocked);
  const foundEff = unionFlags(players, scope, (p) => p.effigies_found);
  const defeated = unionFlags(players, scope, (p) => p.bosses_defeated ?? []);
  // `towers_defeated` is an additive MapPlayerState field (TowerData/T1). Read
  // it through a checked guard so this degrades cleanly both before the type
  // lands and against older save states that predate the field.
  const conqueredTowers = unionFlags(players, scope, (p) =>
    "towers_defeated" in p && Array.isArray(p.towers_defeated)
      ? p.towers_defeated
      : [],
  );

  // The GUID join is "live" only when the extractor has stamped guids onto the POIs
  // (R1). Absent guids everywhere => degrade to counts-only + neutral pins.
  const hasFtGuids = data.fast_travel.some((p) => p.guid != null);
  const hasEffGuids = data.effigies.some((p) => p.guid != null);
  const joined = hasFtGuids || hasEffGuids;

  const pins: PoiPin[] = [];
  let ftFound = 0;
  let effFound = 0;
  const definitions = new Map((data.effigy_types ?? []).map(e => [e.id, e]));
  const effigyTypes = new Map<string, PoiCounts["effigyTypes"][number]>();

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
    const id = p.item_id ?? "Relic";
    const type = definitions.get(id) ?? {
      id, name: id === "Relic" ? "Lifmunk Effigy" : id,
      icon: id === "Relic" ? "effigy" : `effigy_${id}`,
    };
    let count = effigyTypes.get(id);
    if (!count) {
      count = { ...type, found: 0, total: 0, joined: false };
      effigyTypes.set(id, count);
    }
    count.total++;
    if (found) count.found++;
    if (p.guid != null) count.joined = true;
    pins.push({
      key: `ef${i}`,
      kind: "effigy",
      map: p.map,
      x: p.x,
      y: p.y,
      found,
      known: found,
      effigyId: id,
      iconKey: type.icon,
      name: type.name,
    });
  });

  let alphaFound = 0;
  data.bosses.forEach((b, i) => {
    const found = b.key != null && defeated.has(b.key);
    if (found) alphaFound++;
    pins.push({
      key: `bs${i}`,
      kind: "alpha",
      map: b.map,
      x: b.x,
      y: b.y,
      found,
      known: found,
      speciesId: baseSpeciesId(b.species),
      level: b.level,
    });
  });

  const bounties = data.bounties ?? [];
  let bountyFound = 0;
  bounties.forEach((p, i) => {
    const found = p.cid != null && defeated.has(p.cid);
    if (found) bountyFound++;
    pins.push({
      key: `bt${i}`,
      kind: "bounty",
      map: p.map,
      x: p.x,
      y: p.y,
      found,
      known: found,
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

  const categories = (data.poi_categories ?? []).map(c => ({ ...c, found: 0, total: 0, joined: false }));
  const byCategory = new Map(categories.map(c => [c.id, c]));
  const flags = new Map<string, Set<string>>();
  for (const category of categories) {
    if (!category.flag) continue;
    flags.set(category.flag, unionFlags(players, scope, p =>
      category.flag === "FastTravelPointUnlockFlag" ? p.fast_travel_unlocked : p.poi_flags?.[category.flag!] ?? []));
    category.joined = players.some(p => (scope === "all" || p.uid === scope) &&
      (category.flag === "FastTravelPointUnlockFlag" || p.poi_flags?.[category.flag!] !== undefined));
  }
  (data.points_of_interest ?? []).forEach((p, i) => {
    const c = byCategory.get(p.category);
    if (!c) return;
    const tracked = c.joined && p.save_key != null;
    const found = tracked && flags.get(c.flag!)?.has(p.save_key!) === true;
    c.total++;
    if (found) c.found++;
    pins.push({ key: `poi${i}`, kind: "poi", category: c.id, map: p.map, x: p.x, y: p.y,
      name: p.name ?? c.name, detail: p.detail, iconKey: c.icon, found, known: found,
      defaultVisible: c.default_visible, recurring: c.recurring, tracked });
  });

  const counts: PoiCounts = {
    categories: categories.filter(c => c.total > 0),
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
    effigyTypes: [...effigyTypes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    towers: {
      // With keys, "found" = towers a scoped player has reached and "total" is
      // the trackable (keyed) tower count — keyless towers are excluded so the
      // readout can reach 100%. Without any keys, fall back to the raw
      // reached-flag count over all towers (clamped so it never over-reports).
      found: hasTowerKeys
        ? towerFound
        : Math.min(conqueredTowers.size, towers.length),
      total: hasTowerKeys ? keyedTowers : towers.length,
      landmarks: towers.length,
      joined: hasTowerKeys,
    },
    bounties: { found: bountyFound, total: bounties.length, joined: bounties.some(p => p.cid != null) },
    alphas: { found: alphaFound, total: data.bosses.length, joined: data.bosses.some(p => p.key != null) },
    joined,
  };

  return { pins, counts };
}

/** Effigy visibility is shared by the renderer and its regression tests. Unlisted types
 * default to visible so an existing saved filter does not hide newly extracted variants. */
export function isEffigyVisible(pin: PoiPin, filters: {
  effigies: boolean;
  hideUnfoundEffigies: boolean;
  effigyTypes?: Record<string, boolean>;
}): boolean {
  return filters.effigies
    && filters.effigyTypes?.[pin.effigyId ?? "Relic"] !== false
    && (!filters.hideUnfoundEffigies || pin.found);
}

/** Newly added categories follow their default until explicitly toggled. */
export function isExtraPoiVisible(pin: PoiPin, categories?: Record<string, boolean>): boolean {
  return categories?.[pin.category ?? ""] ?? pin.defaultVisible ?? false;
}

/** Aggregate dense optional layers in screen-space cells; retain every point in
 * counts and leave sparse landmark/collectible layers unclustered. */
export function clusterExtraPois<T extends { pin: PoiPin; left: number; top: number }>(points: T[], cellSize = 36): (T & { count: number })[] {
  const buckets = new Map<string, T & { count: number }>();
  const out: (T & { count: number })[] = [];
  for (const p of points) {
    if (p.pin.kind !== "poi" || p.pin.tracked || p.pin.defaultVisible) { out.push({ ...p, count: 1 }); continue; }
    const key = `${p.pin.category}:${Math.floor(p.left / cellSize)}:${Math.floor(p.top / cellSize)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.left = (existing.left * existing.count + p.left) / (existing.count + 1);
      existing.top = (existing.top * existing.count + p.top) / (existing.count + 1);
      existing.count++;
    } else buckets.set(key, { ...p, count: 1 });
  }
  return [...out, ...buckets.values()];
}
