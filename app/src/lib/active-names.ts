// Resolve a save-side active-skill (waza) id to its localized in-game display
// name. The backend `list_active_names` command returns a flat map keyed by the
// prefix-stripped waza id (e.g. "Unique_SheepBall_Roll", "AirCanon"); we cache
// it module-wide so every your-pal section shares one fetch. When the map has
// no entry (or the backend/fixture is unavailable) a deterministic humanizer
// stands in so a skill id is never shown raw.

import { invoke } from "./tauri";

let cache: Promise<Record<string, string>> | null = null;

/** Fetch (once) the id -> display-name map. Never rejects: a failed load
 *  resolves to an empty map so the humanizer fallback takes over. */
export function loadActiveNames(): Promise<Record<string, string>> {
  if (!cache) {
    cache = invoke<Record<string, string>>("list_active_names").catch(() => ({}));
  }
  return cache;
}

/**
 * Display name for a waza id: the map hit wins, else a humanized fallback.
 * The fallback strips a `Unique_<Species>_` prefix, splits camelCase and
 * underscores, and title-cases each word — "Unique_SheepBall_Roll" -> "Roll",
 * "AirCanon" -> "Air Canon".
 */
export function activeName(id: string, map: Record<string, string>): string {
  return map[id] ?? humanizeWaza(id);
}

function humanizeWaza(id: string): string {
  let base = id;
  if (base.startsWith("Unique_")) {
    // Unique_<Species>_<Skill...> -> drop the "Unique" tag and species segment.
    const parts = base.split("_");
    base = parts.slice(2).join("_") || parts.slice(1).join("_") || base;
  }
  const words = base
    .split(/[_\s]+/)
    .flatMap((seg) => seg.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || id;
}
