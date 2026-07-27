// Unit tests for the Palbox passive multi-select filter. Run with `bun test`.
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
