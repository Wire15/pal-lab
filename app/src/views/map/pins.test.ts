import { expect, test } from "bun:test";
import { buildPois, isEffigyVisible } from "./pins";
import type { MapData } from "../../lib/map-coords";
import type { MapState, MapPlayerState } from "../../lib/types";
declare const Bun: { file(path: URL): { json(): Promise<unknown> } };
const extracted = await Bun.file(new URL("../../../public/map/map-data.json", import.meta.url)).json();
import icons from "../../../public/map/icons.json";

const data: MapData = {
  maps: {}, spawns: [], bosses: [], fast_travel: [],
  effigy_types: [
    { id: "Relic", name: "Lifmunk Effigy", icon: "effigy" },
    { id: "Relic_01", name: "Lamball Effigy", icon: "effigy_Relic_01" },
    { id: "Relic_08", name: "Cattiva Effigy", icon: "effigy_Relic_08" },
  ],
  effigies: [
    { x: 1, y: 2, map: "MainMap", guid: "A", item_id: "Relic" },
    { x: 3, y: 4, map: "MainMap", guid: "B", item_id: "Relic_01" },
    { x: 5, y: 6, map: "Tree", guid: "C", item_id: "Relic_08" },
  ],
};
function player(uid: string, flags: string[]): MapPlayerState {
  return { uid, nickname: null, x: null, y: null, fast_travel_unlocked: [],
    effigies_found: flags, effigy_possess_num: 0, bosses_defeated: [], areas_found: [], towers_defeated: [] };
}
const state: MapState = { fog: null, local_source: null, markers: [],
  players: [player("one", ["A", "B", "unknown"]), player("two", ["A", "C"])] };

test("all effigy variants join exact save GUIDs and respect player scope", () => {
  const one = buildPois(data, state, "one");
  expect(one.counts.effigies).toEqual({ found: 2, total: 3 });
  expect(one.pins.map(p => [p.effigyId, p.found, p.known])).toEqual([
    ["Relic", true, true], ["Relic_01", true, true], ["Relic_08", false, false],
  ]);
  expect(one.pins[1].name).toBe("Lamball Effigy");
  expect(one.pins[1].iconKey).toBe("effigy_Relic_01");
  const all = buildPois(data, state, "all");
  expect(all.counts.effigies.found).toBe(3); // shared flags count once
  expect(all.counts.effigyTypes.map(t => [t.id, t.found, t.total])).toEqual([
    ["Relic", 1, 1], ["Relic_01", 1, 1], ["Relic_08", 1, 1],
  ]);
  expect(buildPois(data, null, "all").counts.effigies.found).toBe(0);
});

test("filter counts describe the active map, including its effigy types", () => {
  const tree = buildPois(data, state, "one", "Tree");
  expect(tree.counts.effigies).toEqual({ found: 0, total: 1 });
  expect(tree.counts.effigyTypes.map(t => t.id)).toEqual(["Relic_08"]);
  expect(tree.pins.map(p => p.map)).toEqual(["Tree"]);
  expect(buildPois(data, state, "two", "MainMap").counts.effigies).toEqual({ found: 1, total: 2 });
});

test("legacy map data and saved filters retain the Lifmunk fallback", () => {
  const legacy: MapData = { ...data, effigy_types: undefined,
    effigies: [{ x: 0, y: 0, map: "MainMap", guid: "A" }] };
  const { pins, counts } = buildPois(legacy, state, "one");
  expect(pins[0].effigyId).toBe("Relic");
  expect(pins[0].name).toBe("Lifmunk Effigy");
  expect(pins[0].iconKey).toBe("effigy");
  expect(counts.effigyTypes[0].found).toBe(1);
  expect(isEffigyVisible(pins[0], { effigies: true, hideUnfoundEffigies: false })).toBe(true);
});

test("species toggles compose with the master toggle and collected-only filter", () => {
  const { pins } = buildPois(data, state, "one");
  const filters = { effigies: true, hideUnfoundEffigies: false, effigyTypes: { Relic: false } };
  expect(pins.filter(p => isEffigyVisible(p, filters)).map(p => p.effigyId)).toEqual(["Relic_01", "Relic_08"]);
  expect(pins.filter(p => isEffigyVisible(p, { ...filters, hideUnfoundEffigies: true })).map(p => p.effigyId)).toEqual(["Relic_01"]);
  expect(pins.filter(p => isEffigyVisible(p, { ...filters, effigies: false }))).toHaveLength(0);
  const unknownType = { ...pins[0], effigyId: "future-type" };
  expect(isEffigyVisible(unknownType, filters)).toBe(true);
});

test("published game map contains all 407 placed effigies with distinct GUIDs and matching icons", () => {
  const map = extracted as unknown as MapData;
  expect(map.effigies).toHaveLength(407);
  expect(map.effigy_types).toHaveLength(12);
  expect(new Set(map.effigies.map(p => p.guid)).size).toBe(407);
  expect(map.effigies.every(p => /^[A-F0-9]{32}$/.test(p.guid ?? ""))).toBe(true);
  expect(map.effigies.filter(p => p.map === "MainMap")).toHaveLength(360);
  expect(map.effigies.filter(p => p.map === "Tree")).toHaveLength(47);
  const types = new Map(map.effigy_types?.map(t => [t.id, t]));
  expect(map.effigies.every(p => types.has(p.item_id!))).toBe(true);
  for (const type of types.values()) expect(type.icon in icons).toBe(true);
  const counts = buildPois(map, null, "all").counts.effigyTypes;
  expect(counts.map(t => t.total)).toEqual([155, 30, 30, 30, 30, 30, 30, 30, 30, 4, 4, 4]);
  expect(types.has("Relic_12")).toBe(false); // Mimog is not a placed world actor
});


test("map audit keeps all World Tree towers and trader-type wanted targets", () => {
  const map = extracted as unknown as MapData;
  expect(map.towers).toHaveLength(13);
  expect(map.towers?.filter(t => t.map === "Tree")).toHaveLength(4);
  expect(map.towers?.filter(t => t.key != null)).toHaveLength(6);
  expect(map.bounties).toHaveLength(33);
  expect(map.bounties?.some(b => b.cid === "BOSS_DarkTrader")).toBe(true);
  expect(map.bounties?.filter(b => b.cid?.startsWith("BOSS_Male_Trader"))).toHaveLength(3);
  const tree = buildPois(map, null, "all", "Tree");
  expect(tree.counts.towers.landmarks).toBe(4);
  expect(tree.counts.towers.joined).toBe(false);
  expect(tree.pins.filter(p => p.kind === "tower").every(p => p.known && !p.found)).toBe(true);
});

test("alpha and bounty victories join exact spawner keys for the selected player", () => {
  const map: MapData = { ...data, effigies: [], bosses: [
    { species: "BOSS_SheepBall", key: "SPAWNER_A", x: 1, y: 2, level: 10, map: "MainMap" },
    { species: "BOSS_SheepBall", key: "SPAWNER_B", x: 3, y: 4, level: 20, map: "Tree" },
    { species: "BOSS_SheepBall", x: 5, y: 6, level: 30, map: "MainMap" },
  ], bounties: [
    { cid: "BOSS_Male_Trader01", x: 1, y: 2, map: "MainMap" },
    { cid: "BOSS_DarkTrader", x: 3, y: 4, map: "MainMap" },
  ] };
  const one = player("one", []), two = player("two", []);
  one.bosses_defeated = ["SPAWNER_A", "BOSS_Male_Trader01", "BOSS_SheepBall", "unknown"];
  two.bosses_defeated = ["SPAWNER_A", "SPAWNER_B", "BOSS_DarkTrader"];
  const saves: MapState = { ...state, players: [one, two] };
  const scoped = buildPois(map, saves, "one");
  expect(scoped.counts.alphas).toEqual({ found: 1, total: 3, joined: true });
  expect(scoped.counts.bounties).toEqual({ found: 1, total: 2, joined: true });
  expect(scoped.pins.map(p => [p.found, p.known])).toEqual([
    [true, true], [false, false], [false, false], [true, true], [false, false],
  ]);
  expect(buildPois(map, saves, "all").counts.alphas.found).toBe(2);
  expect(buildPois(map, saves, "all").counts.bounties.found).toBe(2);
  expect(buildPois(map, saves, "one", "Tree").counts.alphas).toEqual({ found: 0, total: 1, joined: true });
  expect(buildPois(map, null, "all").counts.alphas.found).toBe(0);
  expect(buildPois({ ...map, bosses: map.bosses.map(b => ({ ...b, key: undefined })) }, saves, "all").counts.alphas.joined).toBe(false);
});

test("published alpha locations carry game save spawner IDs", () => {
  const map = extracted as MapData;
  expect(map.bosses).toHaveLength(90);
  expect(map.bosses.every(b => !!b.key)).toBe(true);
  expect(new Set(map.bosses.map(b => b.key)).size).toBe(89);
  // The game reuses the GrassGolem spawner key across MainMap and Tree.
  expect(map.bosses.filter(b => b.key === "remainsIsland_1_GrassGolem_FBOSS")).toHaveLength(2);
});
