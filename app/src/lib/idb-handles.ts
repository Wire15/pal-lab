// Web-mode save-folder memory. A `FileSystemDirectoryHandle` is structured-
// cloneable, so once the user picks (showDirectoryPicker) or drops (Chrome/Edge
// `getAsFileSystemHandle`) their SaveGames folder we stash the handle in
// IndexedDB and offer a one-click "Reload <folder>" on the next visit. Re-granting
// read permission needs a user gesture, so we never auto-load — the dropzone just
// renders the affordance (lib is consumed by components/web-drop-zone.tsx).
//
// No external deps: the shared ./idb module provides the promise-wrapped open
// (opening the one "pal-lab" DB at the current version so the snapshot store can
// coexist) and the `wrap` helper. The `factory` parameter defaults to the ambient
// `indexedDB` but is injectable so the unit test can pass an in-memory fake (bun
// has no `indexedDB` global). When no factory exists (Firefox/Safari never persist
// a handle; bun/tests without one) the calls degrade to no-op / null so behavior
// is byte-identical to today.

import { openDb, wrap } from "./idb";

const STORE = "handles";
const KEY = "saveDir";

/** A remembered save directory: the live handle plus display metadata. */
export interface StoredDirHandle {
  handle: FileSystemDirectoryHandle;
  name: string;
  savedAt: number;
}

/** Persist the picked/dropped save directory. No-op when IndexedDB is absent. */
export async function saveDirHandle(
  handle: FileSystemDirectoryHandle,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!factory) return;
  const db = await openDb(factory);
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const record: StoredDirHandle = {
      handle,
      name: handle.name,
      savedAt: Date.now(),
    };
    await wrap(store.put(record, KEY));
  } finally {
    db.close();
  }
}

/** Load the remembered save directory, or null when none/unsupported. */
export async function loadDirHandle(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<StoredDirHandle | null> {
  if (!factory) return null;
  const db = await openDb(factory);
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const record = await wrap(store.get(KEY));
    return (record as StoredDirHandle | undefined) ?? null;
  } finally {
    db.close();
  }
}

/** Forget the remembered save directory. No-op when IndexedDB is absent. */
export async function clearDirHandle(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!factory) return;
  const db = await openDb(factory);
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await wrap(store.delete(KEY));
  } finally {
    db.close();
  }
}
