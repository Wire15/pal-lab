import { expect, test } from "bun:test";
declare const Bun: { file(path: URL): { json(): Promise<unknown> } };
import { buildPois, clusterExtraPois, isExtraPoiVisible } from "./pins";
import type { MapData } from "../../lib/map-coords";
import type { MapState, MapPlayerState } from "../../lib/types";
const data: MapData = { maps: {}, spawns: [], bosses: [], fast_travel: [], effigies: [],
  poi_categories: [
    { id: "watchtower", name: "Observation towers", icon: "watchtower", group: "Landmarks", default_visible: true, flag: "FastTravelPointUnlockFlag" },
    { id: "journal", name: "Journals", icon: "journal", group: "Collectibles", default_visible: false, flag: "NoteObtainForInstanceFlag" },
    { id: "ore", name: "Ore deposits", icon: "ore", group: "Resources", default_visible: false, recurring: true },
  ],
  points_of_interest: [
    { category: "watchtower", x: 1, y: 1, map: "MainMap", save_key: "GUID" },
    { category: "watchtower", x: 2, y: 2, map: "Tree", save_key: "TREE" },
    { category: "journal", x: 3, y: 3, map: "MainMap", guid: "OTHER", save_key: "Day0" },
    { category: "ore", x: 4, y: 4, map: "MainMap" },
  ],
};
function player(uid: string, flags?: Record<string, string[]>): MapPlayerState {
  return { uid, nickname: null, x: null, y: null, fast_travel_unlocked: uid === "one" ? ["GUID"] : ["TREE"],
    effigies_found: [], effigy_possess_num: 0, bosses_defeated: [], areas_found: [], towers_defeated: [], poi_flags: flags };
}
const state: MapState = { fog: null, local_source: null, markers: [], players: [player("one", { NoteObtainForInstanceFlag: ["Day0", "UNKNOWN"] }), player("two")] };
test("new landmarks join the correct record field and key, respecting map and player scope", () => {
  const one = buildPois(data, state, "one", "MainMap");
  expect(one.pins.map(p => [p.category, p.found, p.tracked])).toEqual([["watchtower", true, true], ["journal", true, true], ["ore", false, false]]);
  expect(one.counts.categories?.map(c => [c.id, c.found, c.total, c.joined])).toEqual([["watchtower", 1, 1, true], ["journal", 1, 1, true], ["ore", 0, 1, false]]);
  expect(buildPois(data, state, "one", "Tree").pins[0].found).toBe(false);
  expect(buildPois(data, state, "all", "Tree").pins[0].found).toBe(true);
  const two = buildPois(data, state, "two");
  expect(two.pins.find(p => p.category === "journal")?.tracked).toBe(false);
  expect(buildPois(data, null, "all").pins.every(p => !p.tracked && !p.found)).toBe(true);
});
test("category defaults and overrides preserve existing saved settings", () => {
  const pins = buildPois(data, state, "one").pins;
  expect(pins.map(p => isExtraPoiVisible(p))).toEqual([true, true, false, false]);
  expect(isExtraPoiVisible(pins[0], { watchtower: false })).toBe(false);
  expect(isExtraPoiVisible(pins[3], { ore: true })).toBe(true);
});
test("dense optional layers cluster without mixing types or swallowing tracked collectibles", () => {
  const pins = buildPois(data, state, "one").pins;
  const ore = pins[3];
  const input = [{ pin: ore, left: 1, top: 1 }, { pin: { ...ore, key: "ore2" }, left: 5, top: 5 },
    { pin: { ...ore, category: "coal", key: "coal" }, left: 5, top: 5 },
    { pin: pins[2], left: 5, top: 5 }, { pin: { ...pins[2], key: "journal2" }, left: 5, top: 5 }];
  const clustered = clusterExtraPois(input);
  expect(clustered.length).toBe(4);
  expect(clustered.find(p => p.pin.category === "ore")?.count).toBe(2);
  expect(clustered.find(p => p.pin.category === "ore")?.left).toBe(3);
  expect(clustered.reduce((n, p) => n + p.count, 0)).toBe(input.length);
  expect(clusterExtraPois(input, 2).length).toBe(5);
});

// Validate the distributed manifest rather than accepting an empty extraction.
test("published outdoor map covers the audited categories without internal templates or duplicate points", async () => {
  const data = await Bun.file(new URL("../../../public/map/map-data.json", import.meta.url)).json() as MapData;
  const points = data.points_of_interest ?? [];
  const categories = data.poi_categories ?? [];
  expect(points.length).toBe(38272);
  expect(categories.length).toBe(37);
  expect(points.filter(p => p.category === "watchtower").map(p => p.map).sort()).toEqual([...Array(20).fill("MainMap"), "Tree", "Tree"]);
  expect(points.filter(p => p.category === "dungeon").length).toBe(170);
  expect(points.filter(p => p.category === "skill_fruit").length).toBe(43);
  expect(points.filter(p => p.category === "shrine").length).toBe(106);
  const chromite = points.filter(p => p.category === "chromite");
  expect(chromite.length).toBe(257);
  expect(chromite.every(p => p.map === "MainMap" && p.detail === "Reveal with a Metal Detector or Smokie" && !p.save_key)).toBe(true);
  const category = categories.find(c => c.id === "chromite")!;
  expect([category.name, category.group, category.default_visible, category.recurring]).toEqual(["Chromite deposits", "Resources", false, true]);
  // RockStone18 is chromite, so those points must not also count as stone.
  const stone = points.filter(p => p.category === "stone");
  expect(stone.length).toBe(7789);
  const stonePositions = new Set(stone.map(p => `${p.x}:${p.y}:${p.z}`));
  expect(chromite.every(p => !stonePositions.has(`${p.x}:${p.y}:${p.z}`))).toBe(true);
  const springs = points.filter(p => p.category === "healing");
  expect(springs.length).toBe(3);
  expect(springs.every(p => p.map === "Tree" && p.detail === "Teafant spring" && !p.save_key)).toBe(true);
  const springCategory = categories.find(c => c.id === "healing")!;
  expect([springCategory.name, springCategory.group, springCategory.default_visible, springCategory.recurring]).toEqual(["World Tree Holy Water", "Resources", false, true]);
  const ids = new Set(categories.map(c => c.id));
  expect(points.every(p => ids.has(p.category) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.z! >= -20000)).toBe(true);
  expect(new Set(points.map(p => `${p.category}:${Math.round(p.x*10)}:${Math.round(p.y*10)}:${Math.round(p.z!*10)}`)).size).toBe(points.length);
  expect(points.filter(p => ["watchtower", "shrine", "journal"].includes(p.category)).every(p => !!p.save_key)).toBe(true);
});
