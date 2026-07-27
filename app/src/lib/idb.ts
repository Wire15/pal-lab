// Shared IndexedDB plumbing for the web save-memory helpers. The app keeps two
// kinds of save memory in one database ("pal-lab"): a `FileSystemDirectoryHandle`
// (Chromium-only live re-read, in the "handles" store) and a byte snapshot of the
// loaded bundle (universal fallback, in the "snapshots" store). Both are opened
// through THIS module's single `openDb` so they agree on the schema version.
//
// Why one shared open: IndexedDB versions the whole database, not a store. If one
// module opened v1 (just "handles") and another opened v2 (adds "snapshots"), the
// module still asking for v1 after the v2 upgrade landed would throw VersionError
// (you cannot open below the live version). So the version and the full set of
// stores live here; each consumer picks its own store off the shared handle.
//
// No external deps: a thin promise wrapper over the callback-based IndexedDB API.
// Callers inject the `factory` (defaulting to ambient `indexedDB`) so unit tests
// can pass an in-memory fake — bun has no `indexedDB` global.

/** The single database both save-memory stores live in. */
export const DB_NAME = "pal-lab";

/** Schema version. Bumped 1→2 when the "snapshots" store was added; every store
 *  the app uses is created in the one `onupgradeneeded` below. */
const DB_VERSION = 2;

/** Resolve an IDBRequest's success/error callbacks into a promise. */
export function wrap<T>(req: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  return promise;
}

/** Open the shared save-memory DB, creating any missing object stores on upgrade. */
export function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const req = factory.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles");
    if (!db.objectStoreNames.contains("snapshots")) {
      db.createObjectStore("snapshots");
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  return promise;
}
