import { baseSpeciesId, isFieldBossSpawn } from "./map-data";
import { worldToPx, type BossEntry, type MapData, type MapEntry } from "./map-coords";

export type SpawnKind = "wild" | "alpha" | "both";
export type SpawnPeriod = "all" | "day" | "night";
export type SpawnLayer = "MainMap" | "Tree";
export interface MapSpawnTarget { species: string; kind: SpawnKind }
export interface SpeciesLocation {
  map: SpawnLayer; x: number; y: number; radius: number;
  alpha: boolean; lv: [number, number]; n: [number, number];
  /** undefined means the reference has no schedule for this Alpha. */
  time: string | null | undefined;
}
export function isSpawnLayer(value: string): value is SpawnLayer {
  return value === "MainMap" || value === "Tree";
}
export function matchesSpawnPeriod(time: string | null | undefined, period: SpawnPeriod): boolean {
  // Unrestricted and unknown schedules remain visible in both periods.
  return period === "all" || (period === "day" ? time !== "night" : time !== "day");
}
export function alphaSpawnTime(data: MapData, boss: BossEntry): string | null | undefined {
  const points = data.spawns.filter(s => s.map === boss.map && s.species.toLowerCase() === boss.species.toLowerCase())
    .flatMap(s => s.points).filter(p => p.boss && Math.abs(p.x - boss.x) <= 1 && Math.abs(p.y - boss.y) <= 1
      && p.lv[0] <= boss.level && p.lv[1] >= boss.level);
  // The spawn manifest rounds coordinates to centimetres. Never transfer the
  // schedule from a nearby dungeon/random Alpha encounter to a field boss.
  if (!points.length) return undefined;
  if (points.some(p => p.time === null)) return null;
  return points.every(p => p.time === points[0].time) ? points[0].time : undefined;
}
export function speciesLocations(data: MapData, id: string, kind: SpawnKind = "both", period: SpawnPeriod = "all"): SpeciesLocation[] {
  const base = baseSpeciesId(id).toLowerCase();
  const locations: SpeciesLocation[] = [];
  if (kind !== "alpha") for (const group of data.spawns) {
    if (!isSpawnLayer(group.map) || isFieldBossSpawn(group.species) || baseSpeciesId(group.species).toLowerCase() !== base) continue;
    for (const p of group.points) if (!p.boss && matchesSpawnPeriod(p.time, period)) locations.push({
      map: group.map, x: p.x, y: p.y, radius: p.r, alpha: false, lv: p.lv, n: p.n, time: p.time,
    });
  }
  if (kind !== "wild") for (const boss of data.bosses) {
    if (!isSpawnLayer(boss.map) || baseSpeciesId(boss.species).toLowerCase() !== base) continue;
    const time = alphaSpawnTime(data, boss);
    if (matchesSpawnPeriod(time, period)) locations.push({ map: boss.map, x: boss.x, y: boss.y,
      radius: 0, alpha: true, lv: [boss.level, boss.level], n: [1,1], time });
  }
  return locations;
}
/** Preserve a valid current layer; otherwise choose a layer with real locations. */
export function chooseSpawnLayer(locations: SpeciesLocation[], current: SpawnLayer): SpawnLayer {
  if (locations.some(p => p.map === current)) return current;
  return locations[0]?.map ?? current;
}
export function fitSpawnLocations(entry: MapEntry, locations: SpeciesLocation[], width: number, height: number): { k: number; tx: number; ty: number } | null {
  if (!locations.length || width <= 0 || height <= 0) return null;
  const scale = entry.px[0] / (entry.world_max[1] - entry.world_min[1]);
  const points = locations.map(p => ({ xy: worldToPx(entry, p.x, p.y), r: p.radius * scale }));
  const minU = Math.min(...points.map(p => p.xy[0] - p.r)), maxU = Math.max(...points.map(p => p.xy[0] + p.r));
  const minV = Math.min(...points.map(p => p.xy[1] - p.r)), maxV = Math.max(...points.map(p => p.xy[1] + p.r));
  const k = Math.max(0.06, Math.min(0.5, Math.max(1, width - 100) / Math.max(1, maxU - minU), Math.max(1, height - 100) / Math.max(1, maxV - minV)));
  return { k, tx: width / 2 - (minU + maxU) / 2 * k, ty: height / 2 - (minV + maxV) / 2 * k };
}
