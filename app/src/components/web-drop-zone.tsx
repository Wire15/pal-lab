// Web-mode save loader. The desktop app points the backend at a filesystem
// path; a browser can't, so this full-pane card takes a dropped `SaveGames`
// folder (or a File System Access pick, or an <input webkitdirectory>), reads it
// entirely in-page (lib/save-drop.ts), hands the bytes to the wasm worker
// (loadSaveBundle), then feeds the resulting SaveSummary through the SAME state
// path a native load uses (state.loadSave) — so every view downstream is
// identical to desktop. Nothing is uploaded; parsing is local.
//
// It renders only in web mode when no save is loaded (see App Shell). The
// exported `rereadWebSave` powers the sidebar "Re-read folder" button: it
// re-reads the stored directory handle and fires the shared `save-changed` seam
// so the reload path (state.reloadSave) refreshes the roster + plan tracking.
//
// Two remembrance tiers let a returning visitor reload without re-dropping:
//   1. Live handle (Chromium only) — a persisted FileSystemDirectoryHandle
//      (lib/idb-handles.ts) re-reads the folder in place, picking up new
//      progress; needs a permission gesture, so it renders a "Reload" button.
//   2. Byte snapshot as-of-load (every browser) — the exact bundle bytes are
//      stashed in IndexedDB (lib/idb-snapshot.ts) at load time, so Firefox /
//      Safari / permissionless Chromium get a "Restore" button that replays the
//      last-loaded copy (stale until re-dropped). The handle is preferred where
//      available; the snapshot is the universal fallback.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppState } from "../state";
import { loadSaveBundle } from "../lib/tauri";
import {
  acceptDrop,
  acceptHandle,
  acceptInput,
  acceptSnapshot,
  currentHandle,
  currentLabel,
  isFsAccessSupported,
  pickDirectory,
  readBundle,
} from "../lib/save-drop";
import {
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
  type StoredDirHandle,
} from "../lib/idb-handles";
import {
  clearSnapshot,
  loadSnapshot,
  saveSnapshot,
  type StoredSnapshot,
} from "../lib/idb-snapshot";

/** Re-read the currently loaded save from its stored File System Access handle
 *  and refresh state through the existing `save-changed` seam. Only meaningful
 *  when `save-drop.canReread()` is true (a directory was picked, not dropped). */
export async function rereadWebSave(): Promise<void> {
  const bundle = await readBundle();
  await loadSaveBundle(bundle.paths, bundle.buffers);
  // Reuse the browser `save-changed` listener (state.tsx) → state.reloadSave,
  // which re-summarizes the freshly-cached bundle and refreshes the roster and
  // solver plans (keyed off saveSummary), toasting "Save reloaded".
  window.dispatchEvent(new Event("save-changed"));
}

/** Upload/inbox glyph for the dropzone. */
function DropGlyph() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V3" />
      <path d="m7 8 5-5 5 5" />
      <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

/** Coarse relative age ("just now" / "3h ago" / "5d ago") for a snapshot's
 *  savedAt timestamp — enough to gauge staleness at a glance. */
function snapshotAge(savedAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - savedAt) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Snapshot size as MB, one decimal, for the faint UI suffix. */
function snapshotSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Extract the dropped folder's live directory handle so it can be remembered.
 *  Chromium exposes `getAsFileSystemHandle`; Firefox/Safari don't, so those drops
 *  return null and simply aren't persisted. Must run synchronously in the drop
 *  handler (DataTransferItems expire after it), so the getAsFileSystemHandle()
 *  calls fire before the first await. */
async function dirHandleFromDrop(
  dt: DataTransfer,
): Promise<FileSystemDirectoryHandle | null> {
  if (
    typeof DataTransferItem === "undefined" ||
    !("getAsFileSystemHandle" in DataTransferItem.prototype)
  ) {
    return null;
  }
  const pending: Promise<FileSystemHandle | null>[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file") pending.push(item.getAsFileSystemHandle());
  }
  for (const handle of await Promise.all(pending)) {
    if (handle?.kind === "directory") return handle as FileSystemDirectoryHandle;
  }
  return null;
}

export default function WebDropZone() {
  const { loadSave, saveError, saveLoading } = useAppState();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A directory the user picked/dropped on a previous visit (Chromium only).
  // Non-null renders the "Reload <folder>" affordance; re-granting read
  // permission needs a user gesture, so we never auto-load it.
  const [stored, setStored] = useState<StoredDirHandle | null>(null);
  // The last-loaded save's bytes, stashed in IndexedDB at load time (all
  // browsers). When no live handle is remembered, non-null renders the
  // "Restore <folder>" affordance — a stale-but-replayable copy.
  const [snap, setSnap] = useState<StoredSnapshot | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // `webkitdirectory` isn't in React's input typings; set it imperatively so
    // the fallback <input> picks a whole folder rather than a single file.
    inputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => {
    // Restore a remembered folder (no gesture yet — just surface the Reload
    // affordance). Absent/unsupported → null → dropzone is byte-identical.
    void loadDirHandle().then((rec) => {
      if (rec) setStored(rec);
    });
  }, []);

  useEffect(() => {
    // Surface the universal snapshot fallback. Only shown when no live handle
    // is remembered (see JSX), but always loaded so it's ready on handle-gone.
    void loadSnapshot().then((s) => {
      if (s) setSnap(s);
    });
  }, []);

  // Remember a picked/dropped directory handle for next visit.
  const persistHandle = useCallback((handle: FileSystemDirectoryHandle) => {
    void saveDirHandle(handle);
    setStored({ handle, name: handle.name, savedAt: Date.now() });
  }, []);

  // Acquire a save source, read it fully, cache it in the worker, then feed the
  // shared state load path. `acquire` returns the world label, or null on a
  // cancelled picker.
  const runLoad = useCallback(
    async (
      acquire: () => Promise<string | null>,
      opts: { snapshot?: boolean } = {},
    ) => {
      const { snapshot = true } = opts;
      setError(null);
      setBusy(true);
      try {
        const label = await acquire();
        if (label === null) return; // picker cancelled — leave the zone as-is
        const bundle = await readBundle();
        // Stash the exact bytes for the universal restore path BEFORE handing
        // them to the worker: loadSaveBundle TRANSFERS the ArrayBuffers to the
        // worker (detaching them), and IndexedDB's structured clone happens at
        // put() time — after saveSnapshot's async DB open — so the write must
        // COMPLETE first (awaited; saveSnapshot never throws, so this cannot
        // break the load). State is then rehydrated from the IDB copy, whose
        // buffers are fresh clones — the local `bundle.buffers` are about to be
        // detached and must not be kept. currentLabel() is only correct now
        // that acquire() has resolved the source. Skipped on the restore path
        // itself — re-writing identical bytes is pointless.
        if (snapshot) {
          await saveSnapshot(currentLabel(), bundle.paths, bundle.buffers);
          void loadSnapshot().then((s) => {
            if (s) setSnap(s);
          });
        }
        await loadSaveBundle(bundle.paths, bundle.buffers);
        // load_save via the worker re-summarizes the just-cached bundle; the
        // dropped folder name is the saveDir label.
        await loadSave(currentLabel());
        // A pick / reload leaves a re-readable handle as the source — remember
        // it. Plain drops (kind "files") return null here and persist in onDrop.
        const handle = currentHandle();
        if (handle) persistHandle(handle);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [loadSave, persistHandle],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const dt = e.dataTransfer;
      // Grab a persistable directory handle synchronously (Chromium only), before
      // acceptDrop — both read `dt` while it's still live in the drop handler.
      const handlePromise = dirHandleFromDrop(dt);
      void runLoad(async () => {
        const label = await acceptDrop(dt);
        const handle = await handlePromise;
        if (handle) persistHandle(handle);
        return label;
      });
    },
    [runLoad, persistHandle],
  );

  const browse = useCallback(() => {
    if (isFsAccessSupported()) void runLoad(() => pickDirectory());
    else inputRef.current?.click();
  }, [runLoad]);

  // Restore path: on a user gesture, re-grant read permission and feed the
  // remembered folder through the same load path a fresh pick uses. A denied
  // prompt keeps the affordance; a stale/moved folder (NotFoundError) forgets it.
  const reloadStored = useCallback(() => {
    if (!stored) return;
    const { handle, name } = stored;
    void runLoad(async () => {
      const opts = { mode: "read" } as const;
      const state =
        (await handle.queryPermission(opts)) === "granted"
          ? "granted"
          : await handle.requestPermission(opts);
      if (state !== "granted") {
        throw new Error("Permission to read the save folder was denied.");
      }
      try {
        return await acceptHandle(handle);
      } catch (e) {
        if (e instanceof DOMException && e.name === "NotFoundError") {
          // The live handle is gone, but the byte snapshot (if any) can still
          // replay the last-loaded copy. Clearing only the handle reveals the
          // Restore affordance (setStored(null) → the `snap` branch renders),
          // so keep `snap` and point the user at it.
          void clearDirHandle();
          setStored(null);
          throw new Error(
            `"${name}" isn't at that location anymore — pick your SaveGames folder again.${
              snap ? " — or Restore the last-loaded copy below." : ""
            }`,
          );
        }
        throw e;
      }
    });
  }, [stored, runLoad, snap]);

  // "Forget this save" clears BOTH remembrance tiers — one concept, regardless
  // of which affordance was showing.
  const forgetStored = useCallback(() => {
    void clearDirHandle();
    void clearSnapshot();
    setStored(null);
    setSnap(null);
  }, []);

  // Restore path: replay the stashed bytes with no permission prompt (that's the
  // point of the snapshot). Skip re-snapshotting — the bytes are already stored.
  const restoreSnap = useCallback(() => {
    if (!snap) return;
    const { paths, buffers, label } = snap;
    void runLoad(async () => acceptSnapshot(paths, buffers, label), {
      snapshot: false,
    });
  }, [snap, runLoad]);

  const working = busy || saveLoading;
  const shownError = error ?? saveError;

  return (
    <div className="flex h-full items-center justify-center bg-abyss p-8">
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-panel">
        <div className="border-b border-line px-6 py-5">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            Local save
          </div>
          <h2 className="mt-0.5 font-display text-xl font-bold tracking-wide text-ink">
            Load your Palworld save
          </h2>
        </div>

        <div className="px-6 py-6">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragging) setDragging(true);
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              // Ignore leaves bubbling from children — only the zone boundary.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDragging(false);
            }}
            onDrop={onDrop}
            className={`flex flex-col items-center gap-3 rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors ${
              dragging
                ? "border-amber/60 bg-amber/[0.06]"
                : "border-line bg-abyss/60"
            }`}
          >
            <span className={dragging ? "text-amber" : "text-ink-faint"}>
              <DropGlyph />
            </span>
            <div className="text-[14px] font-medium text-ink">
              {working ? "Reading save\u2026" : "Drop your SaveGames folder"}
            </div>
            <div className="font-mono text-[11px] text-ink-faint">
              the world folder that contains{" "}
              <span className="text-ink-dim">Level.sav</span>
            </div>
            <button
              onClick={browse}
              disabled={working}
              className="mt-1 rounded-md bg-amber px-4 py-1.5 text-[13px] font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-50"
            >
              {working ? "Loading\u2026" : "Browse"}
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.currentTarget.files;
                if (files && files.length) void runLoad(() => acceptInput(files));
              }}
            />
            {stored ? (
              <div className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
                <span>remembered</span>
                <button
                  onClick={reloadStored}
                  disabled={working}
                  title={`Reload ${stored.name}`}
                  className="flex items-center gap-1 rounded-md border border-line bg-raised px-2.5 py-1 text-[11px] font-medium text-ink-dim transition-colors hover:border-amber/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reload
                  <span className="max-w-[16ch] truncate">{stored.name}</span>
                </button>
                <button
                  onClick={forgetStored}
                  disabled={working}
                  aria-label={`Forget ${stored.name}`}
                  title="Forget this save"
                  className="rounded-md p-1 text-ink-faint transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
            ) : snap ? (
              <div className="mt-2 flex flex-col items-center gap-1">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
                  <span>remembered</span>
                  <button
                    onClick={restoreSnap}
                    disabled={working}
                    title={`Restore ${snap.label}`}
                    className="flex items-center gap-1 rounded-md border border-line bg-raised px-2.5 py-1 text-[11px] font-medium text-ink-dim transition-colors hover:border-amber/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Restore
                    <span className="max-w-[16ch] truncate">{snap.label}</span>
                  </button>
                  <span className="whitespace-nowrap text-ink-faint/70">
                    saved {snapshotAge(snap.savedAt)} · {snapshotSize(snap.bytes)}
                  </span>
                  <button
                    onClick={forgetStored}
                    disabled={working}
                    aria-label={`Forget ${snap.label}`}
                    title="Forget this save"
                    className="rounded-md p-1 text-ink-faint transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>
                <span className="font-mono text-[10px] text-ink-faint/70">
                  as of last load — re-drop to pick up new progress
                </span>
              </div>
            ) : null}
          </div>

          {shownError && (
            <div className="mt-4 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-bad">
              {shownError}
            </div>
          )}

          <p className="mt-4 flex items-center gap-2 font-mono text-[11px] text-ink-faint">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-good" />
            parsed locally &mdash; your save never leaves this device
          </p>
        </div>
      </div>
    </div>
  );
}
