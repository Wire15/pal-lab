// Unit tests for the "EXTRA PASSIVES" tolerance control logic. Run with
// `bun test`. `bun:test` type-resolves via app/src/bun-test.d.ts. The persist
// path needs `localStorage`; bun has none, so each test installs a minimal
// Map-backed stub on `globalThis` and tears it down after, matching the
// plan-link test's global-stub pattern.
import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  contextualExtraPassives,
  readExtraPassives,
  resolveExtraPassives,
  writeExtraPassives,
} from "./extra-passives";

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
    writable: true,
  });
  return store;
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("contextual default is Any (4) with no required passives, ≤1 (1) otherwise", () => {
  expect(contextualExtraPassives(0)).toBe(4);
  expect(contextualExtraPassives(1)).toBe(1);
  expect(contextualExtraPassives(3)).toBe(1);
});

test("auto preference resolves via the query context", () => {
  expect(resolveExtraPassives({ mode: "auto" }, 0)).toBe(4);
  expect(resolveExtraPassives({ mode: "auto" }, 2)).toBe(1);
});

test("an explicit choice sticks regardless of context", () => {
  // None (0) chosen with no required passives — context would say Any, choice wins.
  expect(resolveExtraPassives({ mode: "set", value: 0 }, 0)).toBe(0);
  // ≤2 chosen with a full required list — context would say ≤1, choice wins.
  expect(resolveExtraPassives({ mode: "set", value: 2 }, 3)).toBe(2);
});

test("an explicit choice persists across a read", () => {
  writeExtraPassives({ mode: "set", value: 2 });
  expect(readExtraPassives()).toEqual({ mode: "set", value: 2 });
});

test("auto persists and reads back as auto", () => {
  writeExtraPassives({ mode: "auto" });
  expect(readExtraPassives()).toEqual({ mode: "auto" });
});

test("absent storage defaults to auto", () => {
  expect(readExtraPassives()).toEqual({ mode: "auto" });
});

test("corrupt or out-of-range stored value falls back to auto", () => {
  localStorage.setItem("pal-lab.extraPassives", "not json");
  expect(readExtraPassives()).toEqual({ mode: "auto" });
  localStorage.setItem("pal-lab.extraPassives", JSON.stringify({ mode: "set", value: 3 }));
  expect(readExtraPassives()).toEqual({ mode: "auto" });
});
