// World <-> texture-pixel transforms for the World Map view, plus the in-game
// coordinate readout. The numeric constants (image px, world bounds, mask px)
// are NEVER hardcoded here — they are read verbatim from
// `public/map/map-data.json` (contract C1), so a recalibration is a data change,
// not a code change.
//
// The one thing that lives in code is the axis *orientation* — which world axis
// drives the horizontal pixel (u) vs the vertical pixel (v), and whether either
// is flipped. Palworld's world-map texture is axis-swapped relative to world
// coordinates: the horizontal texture axis tracks world Y, the vertical tracks
// world X (with a top-down flip). MapExtract calibrated this empirically (boss +
// fast-travel pins land on terrain) and documents it in each layer's
// `world_to_px` string, which this ORIENT constant mirrors verbatim. If that
// string ever changes, change ORIENT to match and re-verify the two spot coords.

/** One map layer's calibration as published in `public/map/map-data.json`. */
export interface MapEntry {
  /** Public URL of the layer image (8192x8192 lossy webp). */
  image: string;
  /** Logical image size in pixels, `[width, height]`. */
  px: [number, number];
  /** World-space bounds of the image, `[minX, minY]`. */
  world_min: [number, number];
  /** World-space bounds of the image, `[maxX, maxY]`. */
  world_max: [number, number];
  /** Fog mask resolution for this layer, `[width, height]`. */
  mask_px: [number, number];
  /** Human-readable source-of-truth formula this module implements. */
  world_to_px: string;
}

/** One wild-spawn location for a species: world `[x,y]`, spawn `r`adius (world
 *  units), level range `lv`, pack-size range `n`, and optional `time`/`weather`
 *  gates (`"night"` etc., or null = anytime). `boss` flags a field-boss spawn. */
export interface SpawnPoint {
  x: number;
  y: number;
  r: number;
  lv: [number, number];
  n: [number, number];
  time: string | null;
  weather: string | null;
  boss: boolean;
}

/** All spawn points of one species on one map layer. `species` is the internal
 *  id (joins `/pals/<id>.png` and the pal-dex species id). */
export interface SpawnEntry {
  species: string;
  map: string;
  points: SpawnPoint[];
}

/** A field-boss (alpha) location. `species` is `BOSS_<Internal>` (strip the
 *  case-insensitive `BOSS_` prefix for the pal-icon / dex id). */
export interface BossEntry {
  species: string;
  x: number;
  y: number;
  level: number;
  map: string;
}

/** A world POI point: fast-travel statue, effigy, or bounty board. `name` is
 *  null for the unnamed (effigy) variety. `guid` is the world-static actor
 *  instance GUID (32-char UPPERCASE UE-Digits hex) that matches a player's
 *  save-side found/unlocked flag keys exactly (R1); it is absent/null on POIs
 *  the extractor could not resolve, and the found/unlocked join degrades to
 *  counts-only when no POI carries one. */
export interface PoiPoint {
  x: number;
  y: number;
  z?: number;
  map: string;
  name?: string | null;
  guid?: string | null;
  /** Bounty only: the wanted humanoid boss CharacterID (CamelCase, usually
   *  `BOSS_`-prefixed). Bounty names are procedural (always null), so the UI
   *  humanizes this into an enemy-type label. Absent on fast-travel/effigy. */
  cid?: string | null;
}

/** A syndicate-tower landmark POI (Map Wave 3). Towers are major in-game
 *  landmarks visible from the start, so they are NEVER fog-gated. `name` is the
 *  tower's display name (null when unnamed); `key` is the identifier that joins
 *  a tower to a player's `towers_defeated` flag set (TowerData/T1 — the exact
 *  RecordData-derived string), or null when no static join exists (the UI then
 *  degrades to neutral pins + a total-only count). Owned by MapData (this file);
 *  the array is populated by the extractor and may be absent on older data. */
export interface TowerPoint {
  x: number;
  y: number;
  map: string;
  name?: string | null;
  key?: string | null;
}

/** The whole `map-data.json` document. Wave 2 consumes every pin array; the
 *  optional `bounties` is appended by IconExtract only if bounty POI locations
 *  are found in the paks (contract C1), so it may be absent. */
export interface MapData {
  meta?: { game_build?: string; extracted_at?: string; usmap?: string };
  maps: Record<string, MapEntry>;
  spawns: SpawnEntry[];
  bosses: BossEntry[];
  effigies: PoiPoint[];
  fast_travel: PoiPoint[];
  bounties?: PoiPoint[];
  /** Syndicate-tower landmarks (Map Wave 3, TowerData/T1). Absent on data
   *  extracted before towers were added; the UI degrades to no tower layer. */
  towers?: TowerPoint[];
}

/**
 * Axis orientation of the landscape -> texture mapping, mirroring the
 * `world_to_px` string baked in `map-data.json`:
 *   u (horizontal px) = (worldY - minY) / (maxY - minY) * W
 *   v (vertical px)   = (1 - (worldX - minX) / (maxX - minX)) * H
 * i.e. u tracks world **Y**, v tracks world **X** with a vertical flip.
 */
const ORIENT = {
  uAxis: "y" as "x" | "y",
  vAxis: "x" as "x" | "y",
  uFlip: false,
  vFlip: true,
} as const;

/**
 * World -> texture pixel `[u, v]` in the layer's own px space (top-left origin,
 * u right, v down). Pure function of `entry`'s calibration + the ORIENT above.
 */
export function worldToPx(
  entry: MapEntry,
  wx: number,
  wy: number,
): [number, number] {
  const [minX, minY] = entry.world_min;
  const [maxX, maxY] = entry.world_max;
  const [W, H] = entry.px;
  const fx = (wx - minX) / (maxX - minX);
  const fy = (wy - minY) / (maxY - minY);
  const uN = ORIENT.uAxis === "y" ? fy : fx;
  const vN = ORIENT.vAxis === "x" ? fx : fy;
  const u = (ORIENT.uFlip ? 1 - uN : uN) * W;
  const v = (ORIENT.vFlip ? 1 - vN : vN) * H;
  return [u, v];
}

/**
 * Texture pixel `[u, v]` -> world `[x, y]`. Exact inverse of {@link worldToPx};
 * used by the cursor readout (screen -> content px -> world -> in-game).
 */
export function pxToWorld(
  entry: MapEntry,
  u: number,
  v: number,
): [number, number] {
  const [minX, minY] = entry.world_min;
  const [maxX, maxY] = entry.world_max;
  const [W, H] = entry.px;
  let uN = u / W;
  let vN = v / H;
  if (ORIENT.uFlip) uN = 1 - uN;
  if (ORIENT.vFlip) vN = 1 - vN;
  const fx = ORIENT.vAxis === "x" ? vN : uN;
  const fy = ORIENT.uAxis === "y" ? uN : vN;
  const wx = minX + fx * (maxX - minX);
  const wy = minY + fy * (maxY - minY);
  return [wx, wy];
}

/** True when a world point lies within a layer's world bounds. */
export function worldInBounds(entry: MapEntry, wx: number, wy: number): boolean {
  const [minX, minY] = entry.world_min;
  const [maxX, maxY] = entry.world_max;
  return wx >= minX && wx <= maxX && wy >= minY && wy <= maxY;
}

/** The in-game map coordinate readout — the numbers a player sees in-game.
 *  Palworld's UI is axis-swapped: the displayed X is derived from world Y, the
 *  displayed Y from world X. Constants are the game's own (verified in the probe
 *  contract), so this readout matches the in-client coordinate overlay. */
export function worldToInGame(
  wx: number,
  wy: number,
): { x: number; y: number } {
  return { x: (wy - 158000) / 459, y: (wx + 123888) / 459 };
}
