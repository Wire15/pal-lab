// Shared in-memory IndexedDB fake for the idb-* unit tests (idb-handles.test.ts,
// idb-snapshot.test.ts). bun has no `indexedDB` global, so each helper is
// exercised through an injected fake (the `factory` parameter exists for exactly
// this). Implements only the surface the helpers touch: open→(upgrade)→success,
// transaction→objectStore, put/get/delete. Requests resolve on a microtask so
// success/error handlers attached synchronously after the call still fire, and
// the open request fires onupgradeneeded (the v2 upgrade) before onsuccess.
//
// One Map backs every object store; the helpers key handles ("saveDir") and
// snapshots ("saveSnapshot") distinctly, so both coexist in the one fake DB
// without needing separate stores — which lets a test prove the shared v2 open.

/** A pending IDB request whose success handler runs on the next microtask. */
function settle<T>(result: T): IDBRequest<T> {
  const req = {
    result,
    error: null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  queueMicrotask(() => req.onsuccess?.());
  // Fake carries only the fields the idb helpers read off a request.
  return req as unknown as IDBRequest<T>;
}

/** A pending IDB request whose error handler runs on the next microtask. */
function settleError(error: DOMException): IDBRequest<never> {
  const req = {
    result: undefined,
    error,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  queueMicrotask(() => req.onerror?.());
  return req as unknown as IDBRequest<never>;
}

/** How a fake's `put` should fail, to exercise the silent-failure paths. */
export type FailMode = "throw" | "error";

export interface FakeOptions {
  /** Make `objectStore.put` fail: throw synchronously, or reject via onerror. */
  failPut?: FailMode;
}

/** A fresh factory backed by its own in-memory store (isolates each test). */
export function fakeFactory(opts: FakeOptions = {}): IDBFactory {
  const store = new Map<IDBValidKey, unknown>();
  const objectStore = {
    put: (value: unknown, key: IDBValidKey) => {
      if (opts.failPut === "throw") {
        throw new DOMException("quota", "QuotaExceededError");
      }
      if (opts.failPut === "error") {
        return settleError(new DOMException("quota", "QuotaExceededError"));
      }
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
  // Fake implements only IDBFactory.open, the sole method the helpers call.
  return { open } as unknown as IDBFactory;
}

/** A stand-in directory handle — only `.name` is read by the helper. */
export function fakeHandle(name: string): FileSystemDirectoryHandle {
  return { name } as unknown as FileSystemDirectoryHandle;
}
