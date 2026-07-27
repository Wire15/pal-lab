// Web-mode universal save memory. Complements idb-handles.ts: a stored
// `FileSystemDirectoryHandle` gives a *live re-read* of the folder, but only
// Chromium-family browsers expose one. So alongside the handle we also stash a
// byte SNAPSHOT of the loaded bundle — the exact `{ paths, buffers }` as of the
// last load — which every browser (Firefox, Safari, stock Brave, ...) can persist
// and later replay via a "Restore <folder>" affordance. The handle stays
// preferred where present (it re-reads the current on-disk save); the snapshot is
// the universal fallback (bytes frozen at load time).
//
// IndexedDB structured-clones on `put` SYNCHRONOUSLY, so a caller may fire
// `saveSnapshot(...)` immediately before transferring the same ArrayBuffers to a
// worker — the clone is taken before the transfer detaches them. (The returned
// promise still resolves later, but the buffers are safe once put() returns.)
//
// A snapshot is best-effort: it must NEVER break the save load. Any failure — no
// IndexedDB, open error, QuotaExceededError on put — resolves silently. Note also
// that Safari's ITP evicts IndexedDB after ~7 days without interaction, so a
// snapshot is not durable there; it is a convenience, not a guarantee.
//
// Shares the one "pal-lab" DB (opened at the current version) with idb-handles via
// ./idb, so both stores coexist. `factory` is injectable for the in-memory test
// fake (bun has no `indexedDB` global); absent factory ⇒ no-op / null.

import { openDb, wrap } from "./idb";

const STORE = "snapshots";
const KEY = "saveSnapshot";

/** A frozen copy of a loaded save bundle, replayable in any browser. */
export interface StoredSnapshot {
  /** World folder name (from save-drop `currentLabel()`). */
  label: string;
  /** Capture time (`Date.now()`). */
  savedAt: number;
  /** Folder-relative bundle paths. */
  paths: string[];
  /** Buffers parallel to `paths`. */
  buffers: ArrayBuffer[];
  /** Sum of buffer byteLengths — for UI display. */
  bytes: number;
}

/** Persist a byte snapshot of the loaded bundle. Best-effort: ANY failure (no
 *  IndexedDB, open error, QuotaExceededError) resolves silently — a failed
 *  snapshot must never break a save load. `put` structured-clones synchronously,
 *  so it is safe to call this right before transferring the same buffers away. */
export async function saveSnapshot(
  label: string,
  paths: string[],
  buffers: ArrayBuffer[],
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  try {
    if (!factory) return;
    const db = await openDb(factory);
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const record: StoredSnapshot = {
        label,
        savedAt: Date.now(),
        paths,
        buffers,
        bytes: buffers.reduce((n, b) => n + b.byteLength, 0),
      };
      await wrap(store.put(record, KEY));
    } finally {
      db.close();
    }
  } catch {
    // Swallow: quota / absent-IDB / open error must not break the load flow.
  }
}

/** Load the remembered snapshot, or null when none/unsupported. */
export async function loadSnapshot(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<StoredSnapshot | null> {
  if (!factory) return null;
  const db = await openDb(factory);
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const record = await wrap(store.get(KEY));
    return (record as StoredSnapshot | undefined) ?? null;
  } finally {
    db.close();
  }
}

/** Forget the remembered snapshot. No-op when IndexedDB is absent. */
export async function clearSnapshot(
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
