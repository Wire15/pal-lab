import { expect, test } from "bun:test";
import { searchMaterials, expectedAmount, sortMaterialSources, materialLocations, merchantOffers, rewardPoolLabel,
  type MaterialSource, type MaterialCatalog } from "./materials";
import type { MapData } from "./map-coords";
import french from "./materials-fr.json";
declare const Bun: { file(path: URL): { json(): Promise<unknown>; text(): Promise<string> } };
const catalog = await Bun.file(new URL("../../public/data/materials.json", import.meta.url)).json() as MaterialCatalog;
const item = (id: string) => catalog.items.find(i => i.id === id)!;

test("material search accepts French accents, English names and IDs together", () => {
  expect(searchMaterials(catalog.items, "eau sacree").map(i => i.id)).toContain("WorldTreeHolyWater");
  expect(searchMaterials(catalog.items, "world water").map(i => i.id)).toEqual(["WorldTreeHolyWater"]);
  expect(searchMaterials(catalog.items, "LAINE").map(i => i.id)).toContain("Wool");
  expect(searchMaterials(catalog.items, "WorldTreeHolyWater").map(i => i.id)).toEqual(["WorldTreeHolyWater"]);
  expect(searchMaterials(catalog.items, "zzzzmissing")).toEqual([]);
});

test("source ranking accounts for quantity and chance and never mutates the catalog", () => {
  const sources: MaterialSource[] = [
    { kind: "drop", name: "Rare", min: 1, max: 100, rate: 1 },
    { kind: "drop", name: "Reliable", min: 2, max: 4, rate: 100 },
  ];
  expect(expectedAmount(sources[0])).toBe(0.505);
  expect(sortMaterialSources(sources, "expected", "en")[0].name).toBe("Reliable");
  expect(sortMaterialSources(sources, "max", "en")[0].name).toBe("Rare");
  expect(sources[0].name).toBe("Rare");
});

test("map links respect actual encounter IDs, levels, layer and random predators", () => {
  const map: MapData = { maps: {}, effigies: [], fast_travel: [],
    spawns: [{ species: "Mothman", map: "Tree", points: [
      { x: 1, y: 2, lv: [70,75], n: [1,1], r: 1, time: null, weather: null, boss: false },
      { x: 3, y: 4, lv: [1,5], n: [1,1], r: 1, time: null, weather: null, boss: false },
    ] }], bosses: [{ species: "BOSS_Mothman", map: "Tree", x: 5, y: 6, level: 78 }] };
  const normal: MaterialSource = { kind: "drop", character_id: "Mothman", species_id: "Mothman", variant: "normal", level_min: 70 };
  expect(materialLocations(normal, map)).toEqual([{ map: "Tree", x: 1, y: 2, species: "Mothman" }]);
  expect(materialLocations({ ...normal, character_id: "BOSS_Mothman", variant: "alpha" }, map)).toEqual([{ map: "Tree", x: 5, y: 6, alpha: true }]);
  expect(materialLocations({ ...normal, variant: "predator" }, map)).toEqual([]);
  expect(materialLocations({ ...normal, variant: "raid" }, map)).toEqual([]);
  expect(materialLocations({ ...normal, level_max: 69 }, map)).toEqual([]);
  const arenaMap = { ...map, towers: [{ map: "Tree", x: 10, y: 20, boss_type: "WorldTreeMiddleBoss2" }] };
  expect(materialLocations({ ...normal, variant: "battle", battle_id: "WorldTreeMiddleBoss2" }, arenaMap))
    .toEqual([{ map: "Tree", x: 10, y: 20, tower: true }]);
});

test("Holy Water separates arena victory rewards, alpha drops and normal level tiers", () => {
  const drops = item("WorldTreeHolyWater").sources.filter(s => s.kind === "drop");
  const battles = drops.filter(s => s.variant === "battle");
  expect(battles.map(s => [s.battle_id,s.min,s.max,s.rate,s.level_min])).toEqual([
    ["WorldTreeMiddleBoss1",60,80,100,78], ["WorldTreeMiddleBoss2",60,80,100,78], ["WorldTreeMiddleBoss3",60,80,100,78],
  ]);
  expect(battles[2].species_id).toBe("ElecPanda");
  expect(drops.filter(s => s.variant === "normal").every(s => s.min === 2 && s.max === 4 && s.rate === 75 && s.level_min === 70)).toBe(true);
  expect(drops.filter(s => s.variant === "alpha").every(s => s.min === 20 && s.max === 30 && s.rate === 100 && s.level_min === 70)).toBe(true);
  expect(sortMaterialSources(drops, "expected", "en")[0].variant).toBe("battle");
});

test("ranch records preserve suitability ranks and catalog offers collapse identical stocks", () => {
  const wool = item("Wool");
  const ranch = wool.sources.filter(s => s.kind === "ranch" && s.rank === 5);
  expect(ranch.map(s => [s.species_id,s.min,s.max]).sort()).toEqual([["Alpaca",2,6],["SheepBall",1,5],["WoolFox",2,6]]);
  expect(wool.sources.some(s => s.character_id?.startsWith("Quest_") && s.kind === "ranch")).toBe(false);
  const offers = merchantOffers(wool.sources);
  expect(offers.filter(s => s.name === "Caravan merchant")).toHaveLength(1);
  expect(offers.every(s => s.price === 200 && s.currency === "Money" && s.qty === 1)).toBe(true);
});

test("published material catalog has valid quantities, references, localized reward pools and recipes", () => {
  expect(catalog.meta.game_build).toBe("25246127");
  expect(catalog.items.length >= 700).toBe(true);
  expect(new Set(catalog.items.map(i => i.id)).size).toBe(catalog.items.length);
  for (const material of catalog.items) {
    expect(!!material.name && !!material.name_fr).toBe(true);
    for (const s of material.sources) {
      if (s.rate !== undefined) expect(s.rate >= 0 && s.rate <= 100 && s.min! <= s.max!).toBe(true);
      for (const ingredient of s.ingredients ?? []) expect(!!catalog.labels[ingredient.id] && ingredient.qty > 0).toBe(true);
      if (s.pool) expect((french as Record<string,string>)[rewardPoolLabel(s.pool)]).toBeDefined();
    }
    for (const u of material.uses) expect(!!catalog.labels[u.id] && u.qty > 0 && u.output_qty > 0).toBe(true);
  }
  expect(item("Chromium").sources.some(s => s.kind === "gather" && s.category === "chromite")).toBe(true);
  expect(item("WorldTreeHolyWater").sources.some(s => s.kind === "gather" && s.category === "healing")).toBe(true);
  expect(item("PredatorCrystal").sources.some(s => s.variant === "predator")).toBe(true);
});

test("every static material UI message has a French translation", async () => {
  const source = await Bun.file(new URL("../views/Materials.tsx", import.meta.url)).text();
  for (const match of source.matchAll(/\bt\("([^"\n]+)"/g)) expect((french as Record<string,string>)[match[1]]).toBeDefined();
});
