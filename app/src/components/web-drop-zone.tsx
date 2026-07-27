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

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppState } from "../state";
import { loadSaveBundle } from "../lib/tauri";
import {
  acceptDrop,
  acceptInput,
  currentLabel,
  isFsAccessSupported,
  pickDirectory,
  readBundle,
} from "../lib/save-drop";

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

export default function WebDropZone() {
  const { loadSave, saveError, saveLoading } = useAppState();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // `webkitdirectory` isn't in React's input typings; set it imperatively so
    // the fallback <input> picks a whole folder rather than a single file.
    inputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  // Acquire a save source, read it fully, cache it in the worker, then feed the
  // shared state load path. `acquire` returns the world label, or null on a
  // cancelled picker.
  const runLoad = useCallback(
    async (acquire: () => Promise<string | null>) => {
      setError(null);
      setBusy(true);
      try {
        const label = await acquire();
        if (label === null) return; // picker cancelled — leave the zone as-is
        const bundle = await readBundle();
        await loadSaveBundle(bundle.paths, bundle.buffers);
        // load_save via the worker re-summarizes the just-cached bundle; the
        // dropped folder name is the saveDir label.
        await loadSave(currentLabel());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [loadSave],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      // acceptDrop reads the DataTransfer entries synchronously before awaiting,
      // so it's safe to hand off inside runLoad.
      void runLoad(() => acceptDrop(e.dataTransfer));
    },
    [runLoad],
  );

  const browse = useCallback(() => {
    if (isFsAccessSupported()) void runLoad(() => pickDirectory());
    else inputRef.current?.click();
  }, [runLoad]);

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
