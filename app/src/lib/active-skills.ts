// Resolve a save-side active-skill (waza) id to its real in-game stats. The
// backend `list_active_skills` command returns a map keyed by the prefix-
// stripped waza id (e.g. "AirCanon", "Unique_SheepBall_Roll"); each value is an
// {@link ActiveSkill} carrying the localized name plus extraction-sourced
// element/power/cooldown/description. We cache it module-wide so every your-pal
// section shares one fetch. When the map has no entry (or the backend/fixture is
// unavailable) a deterministic humanizer stands in so a skill id is never shown
// raw — with no stats, since none are known.

import type { ActiveSkill, ActiveSkills } from "./types";
import { invoke } from "./tauri";

// The canonical `ActiveSkill` shape + `ActiveSkills` map live in `lib/types.ts`
// (WazaData owns it, mirroring the Rust/C# `list_active_skills` return). We
// import them for local use and re-export so every consumer imports the display
// types from here alongside the loader/humanizer — one door, no drift.
export type { ActiveSkill, ActiveSkills };

let cache: Promise<ActiveSkills> | null = null;

/** Fetch (once) the id -> {@link ActiveSkill} map. Never rejects: a failed load
 *  resolves to an empty map so the humanizer fallback takes over. */
export function loadActiveSkills(): Promise<ActiveSkills> {
  if (!cache) {
    cache = invoke<ActiveSkills>("list_active_skills").catch(() => ({}));
  }
  return cache;
}

/**
 * Humanized display name for a waza id with no map entry — the fallback used
 * when `list_active_skills` lacks the id (or hasn't loaded). Strips a
 * `Unique_<Species>_` prefix, splits camelCase and underscores, and title-cases
 * each word — "Unique_SheepBall_Roll" -> "Roll", "AirCanon" -> "Air Canon".
 * The `activeName(id, map)`-equivalent fallback: the map lookup is the caller's,
 * this is the "no entry" arm. A humanized name never carries stats (none known).
 */
export function humanizeWaza(id: string): string {
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
