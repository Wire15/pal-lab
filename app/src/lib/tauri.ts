// Thin `invoke` wrapper. Inside the Tauri webview it delegates to the real
// `@tauri-apps/api` IPC. In a plain browser (`bun run dev`) there is no backend,
// so it serves static JSON fixtures captured from the real commands run against
// `testdata` — letting every view render and be screenshotted without Tauri.
//
// Regenerate the fixtures with:
//   cargo test gen_dev_fixtures -- --ignored   (in app/src-tauri)

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";

import paldexSpecies from "../dev-fixtures/paldex-species.json";
import rosterCounts from "../dev-fixtures/roster-counts.json";
import saveSummary from "../dev-fixtures/save-summary.json";
import solveResult from "../dev-fixtures/solve-result.json";
import listPassives from "../dev-fixtures/list-passives.json";

/** Tauri v2 injects this global into the webview; absent in a plain browser. */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** `{id, name}` list derived from the species fixture (mirrors list_species). */
const listSpecies = (paldexSpecies as { id: string; name: string }[]).map((s) => ({
  id: s.id,
  name: s.name,
}));

/** Command name -> fixture served in browser dev mode. */
const FIXTURES: Record<string, unknown> = {
  load_save: saveSummary,
  solve: solveResult,
  list_species: listSpecies,
  list_passives: listPassives,
  paldex_species: paldexSpecies,
  roster_counts: rosterCounts,
};

/**
 * Invoke a Tauri command. Delegates to the real IPC inside Tauri; serves a
 * static fixture in a plain browser. Throws for commands without a fixture so
 * dev gaps are obvious rather than silently wrong.
 */
export function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  if (isTauri) {
    return tauriInvoke<T>(cmd, args);
  }
  if (cmd in FIXTURES) {
    return Promise.resolve(FIXTURES[cmd] as T);
  }
  return Promise.reject(
    new Error(`dev shim: no fixture for command '${cmd}' (run in Tauri, or add a fixture)`),
  );
}
