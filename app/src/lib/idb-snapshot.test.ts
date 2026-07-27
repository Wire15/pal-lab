// Unit tests for the web universal save snapshot (lib/idb-snapshot.ts) plus its
// save-drop `acceptSnapshot` Restore path. Run with `bun test`. bun has no
// `indexedDB` global, so helpers are driven through the shared in-memory fake in
// ./idb-fake (the `factory` parameter exists for exactly this). The `bun:test`
// import type-resolves via the ambient app/src/bun-test.d.ts shim.
import { expect, test } from "bun:test";

import { fakeFactory, fakeHandle } from "./idb-fake";
import { loadDirHandle, saveDirHandle } from "./idb-handles";
import {
  clearSnapshot,
  loadSnapshot,
  saveSnapshot,
} from "./idb-snapshot";
import { acceptSnapshot, currentLabel, readBundle } from "./save-drop";

/** Build ArrayBuffers with distinct, checkable byte contents. */
function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

// --- Snapshot store ---------------------------------------------------------

test("save then load roundtrips label, paths, buffers, and bytes", async () => {
  const factory = fakeFactory();
  const paths = ["Level.sav", "Players/00001.sav"];
  const buffers = [buf(1, 2, 3), buf(4, 5, 6, 7)];
  const before = Date.now();
  await saveSnapshot("World A", paths, buffers, factory);
  const rec = await loadSnapshot(factory);
  expect(rec).not.toBeNull();
  expect(rec?.label).toBe("World A");
  expect(rec?.paths).toEqual(paths);
  expect(rec?.buffers).toEqual(buffers);
  expect(rec?.bytes).toBe(7); // 3 + 4
  expect(typeof rec?.savedAt).toBe("number");
  expect((rec?.savedAt ?? 0) >= before).toBe(true);
});

test("load returns null when nothing is stored", async () => {
  expect(await loadSnapshot(fakeFactory())).toBeNull();
});

test("clear forgets the stored snapshot", async () => {
  const factory = fakeFactory();
  await saveSnapshot("W", ["Level.sav"], [buf(1)], factory);
  await clearSnapshot(factory);
  expect(await loadSnapshot(factory)).toBeNull();
});

test("saveSnapshot with no IndexedDB resolves without throwing", async () => {
  await saveSnapshot("W", ["Level.sav"], [buf(1)], undefined);
  expect(await loadSnapshot(undefined)).toBeNull();
  await clearSnapshot(undefined);
});

test("saveSnapshot swallows a put() that throws — never breaks the load", async () => {
  const factory = fakeFactory({ failPut: "throw" });
  // Must resolve despite the QuotaExceededError; nothing gets stored.
  await saveSnapshot("W", ["Level.sav"], [buf(1)], factory);
  expect(await loadSnapshot(factory)).toBeNull();
});

test("saveSnapshot swallows a put() that errors via onerror", async () => {
  const factory = fakeFactory({ failPut: "error" });
  await saveSnapshot("W", ["Level.sav"], [buf(1)], factory);
  expect(await loadSnapshot(factory)).toBeNull();
});

test("handles and snapshot coexist in one shared v2 database", async () => {
  const factory = fakeFactory();
  const handle = fakeHandle("SaveWorld01");
  await saveDirHandle(handle, factory);
  await saveSnapshot("SaveWorld01", ["Level.sav"], [buf(9)], factory);
  // Both records survive the shared open — proves the v2 schema holds both stores.
  expect((await loadDirHandle(factory))?.name).toBe("SaveWorld01");
  expect((await loadSnapshot(factory))?.label).toBe("SaveWorld01");
});

// --- acceptSnapshot Restore path --------------------------------------------

test("acceptSnapshot installs a source readBundle replays byte-for-byte", async () => {
  const paths = ["Level.sav", "LevelMeta.sav", "Players/00001.sav"];
  const buffers = [buf(10, 11), buf(12), buf(13, 14, 15)];
  const label = acceptSnapshot(paths, buffers, "World B");
  expect(label).toBe("World B");
  expect(currentLabel()).toBe("World B");

  const bundle = await readBundle();
  expect(bundle.paths).toEqual(paths);
  const got = bundle.buffers.map((b) => Array.from(new Uint8Array(b)));
  expect(got).toEqual([
    [10, 11],
    [12],
    [13, 14, 15],
  ]);
});
