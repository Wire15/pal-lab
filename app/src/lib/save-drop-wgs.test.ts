// Unit tests for the web WGS (Xbox / Game Pass) routing in save-drop.ts. Run
// with `bun test`. The wasm bridge (`./tauri` wgsManifest / wgsWorldName) is
// mocked, so store detection, manifest-input selection, world enumeration, and
// bundle-keying are exercised with plain in-memory File maps — no worker/wasm.
// `bun:test` type-resolves via app/src/bun-test.d.ts (no @types/bun here).
import { beforeEach, expect, mock, test } from "bun:test";

import type { WgsManifest } from "./tauri";
import type { WgsWorldOption } from "./save-drop";

// Swappable mock impls + a capture of the args each wgsManifest call receives,
// so a test can drive the bridge and assert what was fed to it.
let manifestImpl: (paths: string[], bufs: ArrayBuffer[]) => Promise<WgsManifest>;
let worldNameImpl: (blob: ArrayBuffer) => Promise<string | null>;
const manifestCalls: string[][] = [];
const presentCalls: string[][] = [];

mock.module("./tauri", () => ({
  wgsManifest: async (paths: string[], bufs: ArrayBuffer[], present: string[]) => {
    manifestCalls.push(paths);
    presentCalls.push(present);
    return manifestImpl(paths, bufs);
  },
  wgsWorldName: async (blob: ArrayBuffer) => worldNameImpl(blob),
}));

// Dynamic import: bun's mock.module is NOT hoisted, so save-drop must load AFTER
// the mock is registered — a module-loading boundary a static import can't honor.
const { detectWgsWorlds, acceptWgsWorld, readBundle } = await import("./save-drop");

/** A File carrying the given bytes (name is irrelevant — keys carry the path). */
function blobFile(...data: number[]): File {
  return new File([new Uint8Array(data)], "blob");
}

beforeEach(() => {
  manifestCalls.length = 0;
  presentCalls.length = 0;
  worldNameImpl = async () => null;
  manifestImpl = async () => ({ worlds: [], warnings: [] });
});

test("detectWgsWorlds returns null when there is no containers.index", async () => {
  const files = new Map<string, File>([
    ["World/Level.sav", blobFile(1)],
    ["World/Players/UID.sav", blobFile(2)],
  ]);
  expect(await detectWgsWorlds(files)).toBeNull();
});

test("detectWgsWorlds parses a single-world store, feeding only index + container files", async () => {
  const files = new Map<string, File>([
    ["wgs/AAAA_BBBB/containers.index", blobFile(0)],
    ["wgs/AAAA_BBBB/D1/container.0", blobFile(0)],
    ["wgs/AAAA_BBBB/D1/BLOB1", blobFile(10)],
    ["wgs/AAAA_BBBB/D2/container.5", blobFile(0)],
    ["wgs/AAAA_BBBB/D2/BLOB2", blobFile(20)],
    ["wgs/AAAA_BBBB/D3/BLOB3", blobFile(30)],
    ["wgs/AAAA_BBBB/D4/BLOB4", blobFile(40)],
  ]);
  manifestImpl = async () => ({
    worlds: [
      {
        save_id: "SAVE1",
        mtime_ticks: 1000,
        files: [
          { target_path: "Level.sav", blob_path: "D1/BLOB1", size: 1 },
          { target_path: "LevelMeta.sav", blob_path: "D2/BLOB2", size: 1 },
          { target_path: "Players/UID.sav", blob_path: "D3/BLOB3", size: 1 },
          { target_path: "Players/UID_dps.sav", blob_path: "D4/BLOB4", size: 1 },
        ],
      },
    ],
    warnings: [],
  });
  worldNameImpl = async () => "Test World";

  const result = await detectWgsWorlds(files);
  expect(result).not.toBeNull();
  expect(result!.worlds).toHaveLength(1);
  const w = result!.worlds[0]!;
  expect(w.saveId).toBe("SAVE1");
  expect(w.worldName).toBe("Test World");
  expect(w.playerCount).toBe(1); // UID.sav counts; UID_dps.sav excluded.

  // Only containers.index + container.<N> reach the manifest — never blobs.
  expect(manifestCalls).toHaveLength(1);
  expect([...manifestCalls[0]!].sort()).toEqual(
    ["D1/container.0", "D2/container.5", "containers.index"].sort(),
  );
  // present_paths carries every store path (incl. blobs) so the core's Level-blob
  // existence probe passes and the world isn't dropped.
  expect(presentCalls[0]).toContain("D1/BLOB1");
  expect(presentCalls[0]).toContain("D4/BLOB4");
});

test("acceptWgsWorld keys blobs by target_path so readBundle yields the standard bundle", async () => {
  const world: WgsWorldOption = {
    saveId: "SAVE1",
    worldName: "Test World",
    playerCount: 1,
    mtimeTicks: 1000,
    storeFiles: new Map<string, File>([
      ["D1/BLOB1", blobFile(10, 11)],
      ["D2/BLOB2", blobFile(20)],
      ["D3/BLOB3", blobFile(30)],
      ["D4/BLOB4", blobFile(40)],
    ]),
    refs: [
      { target_path: "Level.sav", blob_path: "D1/BLOB1", size: 2 },
      { target_path: "LevelMeta.sav", blob_path: "D2/BLOB2", size: 1 },
      { target_path: "Players/UID.sav", blob_path: "D3/BLOB3", size: 1 },
      { target_path: "Players/UID_dps.sav", blob_path: "D4/BLOB4", size: 1 },
    ],
  };
  expect(acceptWgsWorld(world)).toBe("Test World");

  const bundle = await readBundle();
  const byPath = new Map(
    bundle.paths.map((p, i) => [p, new Uint8Array(bundle.buffers[i]!)]),
  );
  expect([...byPath.keys()].sort()).toEqual(
    ["Level.sav", "LevelMeta.sav", "Players/UID.sav", "Players/UID_dps.sav"].sort(),
  );
  expect([...byPath.get("Level.sav")!]).toEqual([10, 11]);
  expect([...byPath.get("Players/UID_dps.sav")!]).toEqual([40]);
});

test("acceptWgsWorld labels an unnamed world with its saveId", () => {
  const world: WgsWorldOption = {
    saveId: "ABCDEF0123",
    worldName: null,
    playerCount: 0,
    mtimeTicks: 0,
    storeFiles: new Map<string, File>([["D1/BLOB1", blobFile(1)]]),
    refs: [{ target_path: "Level.sav", blob_path: "D1/BLOB1", size: 1 }],
  };
  expect(acceptWgsWorld(world)).toBe("ABCDEF0123");
});

test("detectWgsWorlds sorts worlds newest-first and surfaces manifest warnings", async () => {
  const files = new Map<string, File>([
    ["wgs/S/containers.index", blobFile(0)],
    ["wgs/S/D1/container.0", blobFile(0)],
    ["wgs/S/D1/BLOB1", blobFile(1)],
  ]);
  manifestImpl = async () => ({
    worlds: [
      { save_id: "OLD", mtime_ticks: 100, files: [{ target_path: "Level.sav", blob_path: "D1/BLOB1", size: 1 }] },
      { save_id: "NEW", mtime_ticks: 900, files: [{ target_path: "Level.sav", blob_path: "D1/BLOB1", size: 1 }] },
    ],
    warnings: ["skipped a stale container"],
  });

  const result = await detectWgsWorlds(files);
  expect(result!.worlds.map((w) => w.saveId)).toEqual(["NEW", "OLD"]);
  expect(result!.warnings).toContain("skipped a stale container");
});

test("detectWgsWorlds skips *backup* stores and parses only the live one", async () => {
  const files = new Map<string, File>([
    ["wgs/AAAA_BBBB/containers.index", blobFile(0)],
    ["wgs/AAAA_BBBB/D1/container.0", blobFile(0)],
    ["wgs/AAAA_BBBB/D1/BLOB1", blobFile(1)],
    ["wgs/AAAA_BBBB_backup/containers.index", blobFile(0)],
    ["wgs/AAAA_BBBB_backup/D1/container.0", blobFile(0)],
    ["wgs/AAAA_BBBB_backup/D1/BLOB1", blobFile(1)],
  ]);
  let calls = 0;
  manifestImpl = async () => {
    calls += 1;
    return {
      worlds: [
        {
          save_id: `S${calls}`,
          mtime_ticks: calls,
          files: [{ target_path: "Level.sav", blob_path: "D1/BLOB1", size: 1 }],
        },
      ],
      warnings: [],
    };
  };

  const result = await detectWgsWorlds(files);
  expect(manifestCalls).toHaveLength(1); // backup store never parsed
  expect(result!.worlds).toHaveLength(1);
});
