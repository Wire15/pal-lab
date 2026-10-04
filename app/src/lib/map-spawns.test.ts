import { expect, test } from "bun:test";
import { speciesLocations, chooseSpawnLayer, matchesSpawnPeriod, alphaSpawnTime, fitSpawnLocations } from "./map-spawns";
import { worldToPx, type MapData, type MapEntry, type SpawnPoint } from "./map-coords";
declare const Bun: { file(path: URL): { json(): Promise<unknown> } };
const point = (x: number, time: string | null = null, boss = false): SpawnPoint => ({
  x, y: 2, r: 10, lv: [5,10], n: [1,2], time, boss, weather: null,
});
const map: MapData = { maps: {}, effigies: [], fast_travel: [],
  spawns: [
    { species: "Pal", map: "Tree", points: [point(1),point(3,"night")] },
    { species: "Both", map: "MainMap", points: [point(1)] },
    { species: "Both", map: "Tree", points: [point(1)] },
    { species: "BOSS_Only", map: "MainMap", points: [point(100,"night",false)] },
    { species: "BOSS_Night", map: "MainMap", points: [point(1,"night",true),point(100,null,false)] },
  ], bosses: [
    { species: "BOSS_Only", map: "Tree", x: 1, y: 2, level: 9 },
    { species: "BOSS_Night", map: "MainMap", x: 1.3, y: 2.2, level: 9 },
  ],
};
test("cross-links choose the map with actual wild or Alpha locations and preserve a valid current map", () => {
  expect(chooseSpawnLayer(speciesLocations(map,"Pal","wild"),"MainMap")).toBe("Tree");
  expect(chooseSpawnLayer(speciesLocations(map,"Only","alpha"),"MainMap")).toBe("Tree");
  expect(chooseSpawnLayer(speciesLocations(map,"Both","wild"),"Tree")).toBe("Tree");
  expect(speciesLocations(map,"Only","wild")).toEqual([]);
  expect(chooseSpawnLayer([],"Tree")).toBe("Tree");
});
test("day excludes nocturnal encounters and night retains unrestricted spawns", () => {
  expect(speciesLocations(map,"Pal","wild","day")).toHaveLength(1);
  expect(speciesLocations(map,"Pal","wild","night")).toHaveLength(2);
  expect(matchesSpawnPeriod("day","night")).toBe(false);
  expect(matchesSpawnPeriod(null,"night")).toBe(true);
  expect(matchesSpawnPeriod(undefined,"day")).toBe(true);
});
test("Alpha schedules join the same fixed spawner, allowing coordinate rounding but excluding random encounters", () => {
  expect(alphaSpawnTime(map,map.bosses[1])).toBe("night");
  expect(speciesLocations(map,"Night","alpha","day")).toEqual([]);
  expect(speciesLocations(map,"Night","alpha","night")).toHaveLength(1);
  expect(alphaSpawnTime(map,map.bosses[0])).toBeUndefined();
  expect(speciesLocations(map,"Only","alpha","day")).toHaveLength(1);
});
test("focusing puts all known locations inside the viewport and centres an isolated Alpha", () => {
  const entry: MapEntry = { image:"",px:[8192,8192],world_min:[0,0],world_max:[1000,1000],mask_px:[1,1],world_to_px:"" };
  const locations = speciesLocations(map,"Only","alpha");
  const fit = fitSpawnLocations(entry,locations,1000,700)!;
  const [u,v]=worldToPx(entry,locations[0].x,locations[0].y);
  expect(u*fit.k+fit.tx).toBe(500);
  expect(v*fit.k+fit.ty).toBe(350);
  expect(fitSpawnLocations(entry,[],1000,700)).toBeNull();
  expect(fitSpawnLocations(entry,locations,0,700)).toBeNull();
});
test("published map routes Tree-only Grizzbolt spawns and Alpha-only Tree pals correctly", async () => {
  const data = await Bun.file(new URL("../../public/map/map-data.json",import.meta.url)).json() as MapData;
  expect(chooseSpawnLayer(speciesLocations(data,"ElecPanda","wild"),"MainMap")).toBe("Tree");
  expect(chooseSpawnLayer(speciesLocations(data,"ElecPanda","alpha"),"Tree")).toBe("MainMap");
  expect(speciesLocations(data,"DomeArmorDragon","wild")).toEqual([]);
  expect(chooseSpawnLayer(speciesLocations(data,"DomeArmorDragon","alpha"),"MainMap")).toBe("Tree");
  expect(speciesLocations(data,"LilyQueen_Dark","alpha","day")).toEqual([]);
  expect(speciesLocations(data,"LilyQueen_Dark","alpha","night")).toHaveLength(1);
  expect(speciesLocations(data,"GrimGirl","alpha","day")).toEqual([]);
  expect(speciesLocations(data,"NightFox","wild","night")).toHaveLength(167);
  expect(speciesLocations(data,"NightFox","wild","day")).toHaveLength(15);
});
