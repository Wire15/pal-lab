// Unit tests for the Xbox save-source sentinel codec. Run with `bun test`. The
// `bun:test` import type-resolves via app/src/bun-test.d.ts (no @types/bun here).
import { expect, test } from "bun:test";

import {
  XBOX_SENTINEL_PREFIX,
  decodeXboxSource,
  encodeXboxSource,
} from "./xbox-save";

const WGS = "C:/Users/me/AppData/Local/Packages/PocketpairInc.Palworld_x/SystemAppData/wgs/AAAA_BBBB";
const SAVE = "00000000000000000000000000000001";

test("encodeXboxSource builds the xbox:// sentinel", () => {
  expect(encodeXboxSource(WGS, SAVE)).toBe(`${XBOX_SENTINEL_PREFIX}${WGS}#${SAVE}`);
});

test("decodeXboxSource round-trips an encoded sentinel", () => {
  const decoded = decodeXboxSource(encodeXboxSource(WGS, SAVE));
  expect(decoded).toEqual({ wgsDir: WGS, saveId: SAVE });
});

test("decodeXboxSource returns null for a plain folder path", () => {
  expect(decodeXboxSource("C:/Palworld/Saved/SaveGames/0/ABC")).toBeNull();
  expect(decodeXboxSource("/home/me/save")).toBeNull();
});

test("decodeXboxSource returns null for a scheme with no '#'", () => {
  expect(decodeXboxSource("xbox://just-a-dir")).toBeNull();
});

test("decodeXboxSource splits on the LAST '#' so a '#' in the path survives", () => {
  const weird = "C:/od#d/wgs/AAAA_BBBB";
  const decoded = decodeXboxSource(encodeXboxSource(weird, SAVE));
  expect(decoded).toEqual({ wgsDir: weird, saveId: SAVE });
});

test("decodeXboxSource yields an empty saveId for a trailing '#'", () => {
  // Not a valid source, but the split must be total (no throw / no undefined).
  expect(decodeXboxSource("xbox://C:/wgs/AAAA_BBBB#")).toEqual({
    wgsDir: "C:/wgs/AAAA_BBBB",
    saveId: "",
  });
});
