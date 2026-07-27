// Unit tests for the web save-folder memory helper. Run with `bun test`. bun has
// no `indexedDB` global, so each helper is called with an injected in-memory fake
// (the `factory` parameter exists for exactly this). The `bun:test` import
// type-resolves via the ambient app/src/bun-test.d.ts shim.
import { expect, test } from "bun:test";

import {
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
} from "./idb-handles";

// --- Minimal in-memory IndexedDB fake ---------------------------------------
// Implements only the surface idb-handles touches: open→(upgrade)→success,
// transaction→objectStore, put/get/delete. Requests resolve on a microtask, so
// success/error handlers attached synchronously after the call still fire.

/** A pending IDB request whose handler runs on the next microtask. */
function settle<T>(result: T): IDBRequest<T> {
  const req = {
    result,
    error: null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  queueMicrotask(() => req.onsuccess?.());
  // Fake carries only the fields idb-handles reads off a request.
  return req as unknown as IDBRequest<T>;
}

/** A fresh factory backed by its own in-memory store (isolates each test). */
function fakeFactory(): IDBFactory {
  const store = new Map<IDBValidKey, unknown>();
  const objectStore = {
    put: (value: unknown, key: IDBValidKey) => {
      store.set(key, value);
      return settle<IDBValidKey>(key);
    },
    get: (key: IDBValidKey) => settle(store.get(key)),
    delete: (key: IDBValidKey) => {
      store.delete(key);
      return settle<undefined>(undefined);
    },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => ({ objectStore: () => objectStore }),
    close: () => {},
  };
  const open = () => {
    const req = {
      result: db,
      error: null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    queueMicrotask(() => {
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    // Fake carries only the fields openDb reads off the open request.
    return req as unknown as IDBOpenDBRequest;
  };
  // Fake implements only IDBFactory.open, the sole method idb-handles calls.
  return { open } as unknown as IDBFactory;
}

/** A stand-in directory handle — only `.name` is read by the helper. */
function fakeHandle(name: string): FileSystemDirectoryHandle {
  return { name } as unknown as FileSystemDirectoryHandle;
}

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
