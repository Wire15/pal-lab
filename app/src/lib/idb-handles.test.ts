// Unit tests for the web save-folder memory helper. Run with `bun test`. bun has
// no `indexedDB` global, so each helper is called with an injected in-memory fake
// (the `factory` parameter exists for exactly this). The `bun:test` import
// type-resolves via the ambient app/src/bun-test.d.ts shim.
import { expect, test } from "bun:test";

import { fakeFactory, fakeHandle } from "./idb-fake";
import {
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
} from "./idb-handles";

// --- Tests ------------------------------------------------------------------

test("save then load returns the stored handle with metadata", async () => {
  const factory = fakeFactory();
  const handle = fakeHandle("SaveWorld01");
  const before = Date.now();
  await saveDirHandle(handle, factory);
  const rec = await loadDirHandle(factory);
  expect(rec).not.toBeNull();
  expect(rec?.handle).toBe(handle);
  expect(rec?.name).toBe("SaveWorld01");
  expect(typeof rec?.savedAt).toBe("number");
  expect((rec?.savedAt ?? 0) >= before).toBe(true);
});

test("load returns null when nothing is stored", async () => {
  expect(await loadDirHandle(fakeFactory())).toBeNull();
});

test("clear forgets the stored handle", async () => {
  const factory = fakeFactory();
  await saveDirHandle(fakeHandle("W"), factory);
  await clearDirHandle(factory);
  expect(await loadDirHandle(factory)).toBeNull();
});

test("absent IndexedDB degrades to no-op / null", async () => {
  // Firefox/Safari (and bun) with no factory: save/clear no-op, load null.
  await saveDirHandle(fakeHandle("W"), undefined);
  expect(await loadDirHandle(undefined)).toBeNull();
  await clearDirHandle(undefined);
});
