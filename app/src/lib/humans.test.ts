// Unit tests for captured-human lookup. Run with `bun test`. The `bun:test`
// import type-resolves via app/src/bun-test.d.ts.
import { expect, test } from "bun:test";

import humansData from "./humans.json";
import { getHuman, humanIconUrl } from "./humans";

test("getHuman resolves an exact CharacterID", () => {
  const h = getHuman("Hunter_Rifle");
  expect(h).not.toBeNull();
  expect(h!.id).toBe("Hunter_Rifle");
  expect(h!.name).toBe("Syndicate Gunner");
  expect(h!.faction).toBe("Rayne Syndicate");
});

test("getHuman is case-insensitive", () => {
  const h = getHuman("hUnTeR_rIfLe");
  expect(h).not.toBeNull();
  expect(h!.id).toBe("Hunter_Rifle"); // canonical key, not the queried casing
});

test("getHuman returns null for an unknown id", () => {
  expect(getHuman("NotARealCharacter")).toBeNull();
  expect(getHuman("")).toBeNull();
});

test("every icon value is a bare basename (no extension or path separator)", () => {
  for (const [, rec] of Object.entries(humansData as Record<string, { icon: string }>)) {
    expect(rec.icon).not.toContain("/");
    expect(rec.icon).not.toContain("\\");
    expect(rec.icon).not.toContain(".");
  }
});

test("humanIconUrl builds the public path", () => {
  const h = getHuman("SalesPerson")!;
  expect(humanIconUrl(h)).toBe(`/humans/${h.icon}.webp`);
});

test("at least one BOSS_ row is a bounty target", () => {
  const boss = getHuman("BOSS_Hunter_Rifle");
  expect(boss).not.toBeNull();
  expect(boss!.bounty).toBe(true);
  expect(boss!.name).toBe("Hawk");
});

test("SalesPerson resolves to the Wandering Merchant", () => {
  const h = getHuman("SalesPerson");
  expect(h).not.toBeNull();
  expect(h!.name).toBe("Wandering Merchant");
});
