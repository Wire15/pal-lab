// Unit tests for the shared Palbox filters. Run with `bun test`.
// The `bun:test` import type-resolves via the ambient app/src/bun-test.d.ts shim.
import { expect, test } from "bun:test";

import { DEFAULT_QUERY, isQueryActive, matchesQuery, type PalboxQuery } from "./selectors";
import type { OwnedPal, SpeciesEntry } from "../../lib/types";

const guid = (n: number): number[] => [n, ...new Array(15).fill(0)];

function mkPal(
  over: Partial<OwnedPal> & { instance_id: number[]; character_id: string },
): OwnedPal {
  return {
    is_boss: false,
    is_lucky: false,
    is_human: false,
    gender: "Male",
    level: 1,
    rank: 0,
    passives: [],
    active_skills: [],
    ivs: { hp: 0, attack: 0, defense: 0 },
    nickname: null,
    owner_player_uid: null,
    container_id: null,
    slot_index: null,
    container_kind: "Palbox",
    ...over,
  };
}

// The passive filter is species-independent, so name/species lookups stay empty.
const NAMES = new Map<string, string>();
const SPECIES = new Map<string, SpeciesEntry>();
const q = (passives: string[]): PalboxQuery => ({ ...DEFAULT_QUERY, passives });

const pal = (passives: string[]): OwnedPal =>
  mkPal({ instance_id: guid(1), character_id: "PenguinPal", passives });

test("DEFAULT_QUERY has an empty passives filter", () => {
  expect(DEFAULT_QUERY.passives).toEqual([]);
});

test("no selected passives leaves the passive filter inactive", () => {
  expect(matchesQuery(pal([]), DEFAULT_QUERY, NAMES, SPECIES)).toBe(true);
  expect(matchesQuery(pal(["Legend"]), DEFAULT_QUERY, NAMES, SPECIES)).toBe(true);
});

test("AND semantics: a pal must carry every selected passive", () => {
  const query = q(["Legend", "Swift"]);
  // both → match
  expect(matchesQuery(pal(["Legend", "Swift"]), query, NAMES, SPECIES)).toBe(true);
  // superset → still match
  expect(matchesQuery(pal(["Legend", "Swift", "Ferocious"]), query, NAMES, SPECIES)).toBe(true);
  // only one of two → no match
  expect(matchesQuery(pal(["Legend"]), query, NAMES, SPECIES)).toBe(false);
  expect(matchesQuery(pal(["Swift"]), query, NAMES, SPECIES)).toBe(false);
  // none → no match
  expect(matchesQuery(pal(["Ferocious"]), query, NAMES, SPECIES)).toBe(false);
});

test("passive match is exact by id (no substring)", () => {
  // "Leg" is not a passive the pal carries; only exact ids match.
  expect(matchesQuery(pal(["Legend"]), q(["Leg"]), NAMES, SPECIES)).toBe(false);
});

test("isQueryActive reflects the passive filter", () => {
  expect(isQueryActive(DEFAULT_QUERY)).toBe(false);
  expect(isQueryActive(q(["Legend"]))).toBe(true);
});

test("perfect IV filters check each stat and require exactly 100", () => {
  const all: PalboxQuery = { ...DEFAULT_QUERY, ivFilter: "all100" };
  const one: PalboxQuery = { ...DEFAULT_QUERY, ivFilter: "one100" };
  const cases = [
    { ivs: { hp: 100, attack: 100, defense: 100 }, all: true, one: true },
    { ivs: { hp: 100, attack: 20, defense: 0 }, all: false, one: true },
    { ivs: { hp: 20, attack: 100, defense: 0 }, all: false, one: true },
    { ivs: { hp: 20, attack: 0, defense: 100 }, all: false, one: true },
    { ivs: { hp: 100, attack: 100, defense: 99 }, all: false, one: true },
    { ivs: { hp: 99, attack: 99, defense: 99 }, all: false, one: false },
    { ivs: { hp: 101, attack: 0, defense: 0 }, all: false, one: false },
    { ivs: { hp: 0, attack: 0, defense: 0 }, all: false, one: false },
  ];
  for (const c of cases) {
    const p = mkPal({ instance_id: guid(1), character_id: "PenguinPal", ivs: c.ivs });
    expect(matchesQuery(p, DEFAULT_QUERY, NAMES, SPECIES)).toBe(true);
    expect(matchesQuery(p, all, NAMES, SPECIES)).toBe(c.all);
    expect(matchesQuery(p, one, NAMES, SPECIES)).toBe(c.one);
  }
  expect(isQueryActive(all)).toBe(true);
  expect(isQueryActive(one)).toBe(true);
  const human = mkPal({ instance_id: guid(2), character_id: "Hunter_Rifle",
    is_human: true, ivs: { hp: 100, attack: 100, defense: 100 } });
  expect(matchesQuery(human, DEFAULT_QUERY, NAMES, SPECIES)).toBe(true);
  expect(matchesQuery(human, all, NAMES, SPECIES)).toBe(false);
  expect(matchesQuery(human, one, NAMES, SPECIES)).toBe(false);
});

test("perfect IV filters combine with gender and required passives", () => {
  const query: PalboxQuery = {
    ...DEFAULT_QUERY, ivFilter: "all100", gender: "Female", passives: ["Legend"],
  };
  const p = mkPal({
    instance_id: guid(1), character_id: "PenguinPal", gender: "Female",
    passives: ["Legend"], ivs: { hp: 100, attack: 100, defense: 100 },
  });
  expect(matchesQuery(p, query, NAMES, SPECIES)).toBe(true);
  expect(matchesQuery({ ...p, gender: "Male" }, query, NAMES, SPECIES)).toBe(false);
  expect(matchesQuery({ ...p, passives: [] }, query, NAMES, SPECIES)).toBe(false);
});

// A captured human is absent from the species pack; search must fall through to
// the frontend humans.json profile name (speciesName -> getHuman). We pull a
// real profile from the shipped data so the test tracks the contract.
import humansData from "../../lib/humans.json";

const humans = humansData as Record<string, { name: string }>;
const [KNOWN_HUMAN_ID, KNOWN_HUMAN] = Object.entries(humans)[0]!;

function mkHuman(): OwnedPal {
  return mkPal({
    instance_id: guid(9),
    character_id: KNOWN_HUMAN_ID,
    is_human: true,
    gender: null,
  });
}

test("matchesQuery finds a captured human by its display name", () => {
  const human = mkHuman();
  const firstWord = KNOWN_HUMAN.name.split(" ")[0]!.toLowerCase();
  const hit: PalboxQuery = { ...DEFAULT_QUERY, search: firstWord };
  const miss: PalboxQuery = { ...DEFAULT_QUERY, search: "zzz-not-a-human-name" };
  expect(matchesQuery(human, hit, NAMES, SPECIES)).toBe(true);
  expect(matchesQuery(human, miss, NAMES, SPECIES)).toBe(false);
});

test("matchesQuery still finds a captured human by its raw CharacterID", () => {
  const human = mkHuman();
  const byId: PalboxQuery = { ...DEFAULT_QUERY, search: KNOWN_HUMAN_ID.toLowerCase() };
  expect(matchesQuery(human, byId, NAMES, SPECIES)).toBe(true);
});
