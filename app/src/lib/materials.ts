import type { MapData } from "./map-coords";

export type SourceKind = "drop" | "ranch" | "merchant" | "craft" | "gather" | "fishing" | "expedition";
export interface MaterialSource {
  kind: SourceKind;
  character_id?: string; species_id?: string;
  name?: string; name_fr?: string; variant?: string;
  level_min?: number; level_max?: number;
  min?: number; max?: number; rate?: number; first_defeat?: boolean;
  rank?: number; base_rank?: number; food?: number; slot?: number;
  conditional_slot?: boolean;
  battle_id?: string; difficulty?: string;
  shop_id?: string; price?: number; currency?: string; qty?: number; stock?: number;
  recipe_id?: string; ingredients?: { id: string; qty: number }[];
  category?: string; pool?: string;
}
export interface Material {
  id: string; name: string; name_fr: string; category: string; subtype: string;
  weight: number; sources: MaterialSource[];
  uses: { id: string; qty: number; output_qty: number; recipe_id: string }[];
}
export interface MaterialCatalog {
  meta: { game_build: string; schema: number };
  items: Material[];
  labels: Record<string, { name: string; name_fr: string }>;
}
let cached: Promise<MaterialCatalog> | null = null;
export function loadMaterials(): Promise<MaterialCatalog> {
  if (!cached) cached = fetch("/data/materials.json").then(r => {
    if (!r.ok) throw new Error(`materials.json ${r.status}`);
    return r.json() as Promise<MaterialCatalog>;
  }).catch(e => { cached = null; throw e; });
  return cached;
}
export const foldMaterialText = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’']/g, " ");
export function searchMaterials(items: Material[], query: string): Material[] {
  const terms = foldMaterialText(query.trim()).split(/\s+/).filter(Boolean);
  return items.filter(i => {
    const text = foldMaterialText(`${i.id} ${i.name} ${i.name_fr}`);
    return terms.every(term => text.includes(term));
  });
}
/** A comparison per encounter/production cycle, assuming uniform quantity rolls.
 * Not an hourly rate; does not fold in server settings or player drop buffs. */
export function expectedAmount(source: MaterialSource): number {
  return ((source.min ?? 0) + (source.max ?? 0)) / 2 * (source.rate ?? 0) / 100;
}
export type MaterialSort = "expected" | "max" | "rate" | "name";
export function sortMaterialSources(sources: MaterialSource[], sort: MaterialSort, locale: "en" | "fr"): MaterialSource[] {
  return [...sources].sort((a, b) => {
    const metric = (s: MaterialSource) => sort === "max" ? s.max ?? 0 : sort === "rate" ? s.rate ?? 0 : expectedAmount(s);
    const name = (s: MaterialSource) => (locale === "fr" ? s.name_fr : s.name) ?? s.name ?? "";
    return (sort === "name" ? 0 : metric(b) - metric(a)) || name(a).localeCompare(name(b), locale)
      || (a.level_min ?? 0) - (b.level_min ?? 0);
  });
}
export interface MaterialMapTarget {
  map: "MainMap" | "Tree"; x: number; y: number;
  category?: string; species?: string; alpha?: boolean; tower?: boolean;
}
export function rewardPoolLabel(pool: string): string {
  const labels: Record<string,string> = {
    "DarkIsland02_Fishing": "Feybreak fishing (area 2)",
    "DarkIsland_Treasure_Fishing": "Feybreak fishing",
    "Desert01_Fishing": "Desert fishing (area 1)",
    "Desert02_Fishing": "Desert fishing (area 2)",
    "Expedition_DarkIsland": "Feybreak expedition",
    "Expedition_DarkIsland_Hard": "Feybreak expedition (hard)",
    "Expedition_Desert": "Desert expedition",
    "Expedition_Desert_Hard": "Desert expedition (hard)",
    "Expedition_Forest": "Forest expedition",
    "Expedition_Forest_Hard": "Forest expedition (hard)",
    "Expedition_Grass": "Grasslands expedition",
    "Expedition_Grass_Hard": "Grasslands expedition (hard)",
    "Expedition_Sakurajima": "Sakurajima expedition",
    "Expedition_Sakurajima_Hard": "Sakurajima expedition (hard)",
    "Expedition_SkyIsland": "Sky islands expedition",
    "Expedition_SkyIsland_Hard": "Sky islands expedition (hard)",
    "Expedition_Snow": "Snow expedition",
    "Expedition_Snow_Hard": "Snow expedition (hard)",
    "Expedition_Volcano": "Volcano expedition",
    "Expedition_Volcano_Hard": "Volcano expedition (hard)",
    "Expedition_WorldTree": "World Tree expedition",
    "Expedition_WorldTree_Hard": "World Tree expedition (hard)",
    "Forest01_Fishing": "Forest fishing (area 1)",
    "Forest02_Fishing": "Forest fishing (area 2)",
    "Grass01_Fishing": "Grasslands fishing (area 1)",
    "Grass02_Fishing": "Grasslands fishing (area 2)",
    "Sakurajima02_Fishing": "Sakurajima fishing (area 2)",
    "Sakurajima_Treasure_Fishing": "Sakurajima fishing",
    "SkyIsland02_Fishing": "Sky islands fishing (area 2)",
    "SkyIsland_Treasure_Fishing": "Sky islands fishing",
    "SkyIsland_Treasure_Fishpond": "Sky islands fishing (large pond)",
    "Snow01_Fishing": "Snow fishing (area 1)",
    "Snow02_Fishing": "Snow fishing (area 2)",
    "Volcano01_Fishing": "Volcano fishing (area 1)",
    "Volcano02_Fishing": "Volcano fishing (area 2)",
    "WorldTree02_Fishing": "World Tree fishing (area 2)",
    "WorldTree_Treasure_Fishing": "World Tree fishing",
    "WorldTree_Treasure_Fishpond": "World Tree fishing (large pond)"
};
  return labels[pool] ?? pool.replace(/^Expedition_/, "").replace(/_Treasure_Fishing$/, "").replace(/_/g, " ");
}
/** Match exact encounter IDs and actual spawn levels. Predators have no fixed
 * anchors in 1.0; their ordinary species locations are not predator pins. */
export function materialLocations(source: MaterialSource, data: MapData & {
  points_of_interest?: { category: string; map: string; x: number; y: number }[];
}): MaterialMapTarget[] {
  const isMap = (s: string): s is "MainMap" | "Tree" => s === "MainMap" || s === "Tree";
  if (source.kind === "gather") return (data.points_of_interest ?? [])
    .filter(p => p.category === source.category && isMap(p.map))
    .map(p => ({ map: p.map as "MainMap" | "Tree", x: p.x, y: p.y, category: p.category }));
  if (source.kind !== "drop" || source.variant === "predator" || source.variant === "raid" || source.variant === "tower") return [];
  const validLevel = (lo: number, hi = lo) => hi >= (source.level_min ?? 0) && lo <= (source.level_max ?? Infinity);
  if (source.variant === "battle" && source.battle_id) {
    const arenas = (data.towers ?? []).filter(t => t.boss_type === source.battle_id && isMap(t.map));
    if (arenas.length) return arenas.map(t => ({ map: t.map as "MainMap" | "Tree", x: t.x, y: t.y, tower: true }));
  }
  if (source.variant === "alpha" || source.variant === "battle") return data.bosses
    .filter(b => b.species.toLowerCase() === source.character_id?.toLowerCase() && isMap(b.map) && validLevel(b.level))
    .map(b => ({ map: b.map as "MainMap" | "Tree", x: b.x, y: b.y, alpha: true }));
  return data.spawns.filter(s => s.species === source.character_id && isMap(s.map)).flatMap(s => s.points
    .filter(p => !p.boss && validLevel(p.lv[0], p.lv[1]))
    .map(p => ({ map: s.map as "MainMap" | "Tree", x: p.x, y: p.y, species: source.species_id })));
}
/** Preserve differing stock variants but collapse identical purchase offers. */
export function merchantOffers(sources: MaterialSource[]): MaterialSource[] {
  const offers = new Map<string, MaterialSource>();
  for (const s of sources.filter(s => s.kind === "merchant")) {
    const key = JSON.stringify([s.name, s.price, s.currency, s.qty]);
    if (!offers.has(key)) offers.set(key, s);
  }
  return [...offers.values()].sort((a,b) => (a.price ?? 0) / (a.qty || 1) - (b.price ?? 0) / (b.qty || 1));
}
