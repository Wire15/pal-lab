// Runtime capability flags. Pal Lab ships in three backend modes that share one
// frontend; every seam that differs by mode reads these flags instead of
// re-sniffing the environment:
//   - Tauri desktop — real `@tauri-apps/api` IPC (`__TAURI_INTERNALS__` present).
//   - Web           — the static browser build backed by the wasm worker
//                     (`crates/pal-web`), selected at build time via `--mode web`
//                     (VITE_BACKEND=web). Save I/O is drag-drop / File System
//                     Access; no watcher, no updater, no native dir picker.
//   - Fixture dev   — plain `bun run dev`: no backend, static JSON fixtures.
//
// The fixture path stays the fallback (`!isTauri && !isWeb`), so `bun run dev`
// is unchanged.

/** Tauri v2 injects this global into the webview; absent in a plain browser. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The static browser build backed by the wasm worker. Only true in a plain
 *  browser built/run with `--mode web` (VITE_BACKEND=web). */
export const isWeb = !isTauri && import.meta.env.VITE_BACKEND === "web";

/** Plain-browser dev with no backend: static JSON fixtures serve every command
 *  (`bun run dev`). The default when neither Tauri nor web mode is active. */
export const isFixture = !isTauri && !isWeb;

/** Feature availability by mode. The live save watcher, GitHub update check, and
 *  native OS directory picker are Tauri-only; the web build substitutes
 *  drag-drop / File System Access for loading and a manual "re-read folder"
 *  refresh for the watcher, and hides the updater. */
export const caps = {
  isTauri,
  isWeb,
  /** Live filesystem save watcher (Tauri only; web uses manual re-read). */
  watchSave: isTauri,
  /** GitHub release update check (Tauri only). */
  updater: isTauri,
  /** Native OS directory picker via the Tauri dialog plugin (web uses File
   *  System Access / <input webkitdirectory>). */
  pickNativeDir: isTauri,
} as const;
