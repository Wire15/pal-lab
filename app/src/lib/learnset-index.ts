// Reverse index for the Pal-dex MOVES view: waza id -> the species that learn
// it (with the level each learns it at). Learnsets live ONLY in the per-species
// detail payload (`paldex_species_detail` -> SpeciesDetail.learnset), never in
// the lightweight grid rows (`paldex_species` -> SpeciesEntry). There is no bulk
// learnset command (Rust is out of scope for this slice), so we fan the detail
// fetch across every species ONCE, concurrently, and cache the built index
// module-wide — the MOVES tab pays a single up-front cost the first time it is
// opened, then every move row reads the reverse map for free.
//
// Each detail fetch is a cheap in-process game-data lookup on the Rust side; in
// fixture mode (`bun run dev`) every species detail is served from the bundled
// `paldex-species-detail.json`, so the fan-out resolves instantly.

import { invoke } from "./tauri";
import type { SpeciesDetail, SpeciesEntry } from "./types";

/** One species that learns a given move, plus the level it is learned at. */
export interface MoveLearner {
  species: SpeciesEntry;
  /** Lowest level-up level at which this species learns the move. */
  level: number;
}

let cache: Promise<Map<string, MoveLearner[]>> | null = null;

/**
 * Fetch (once) the waza-id -> learners reverse index, built from every species'
 * level-up learnset. Never rejects: a failed detail fetch is skipped and a
 * wholesale failure resolves to an empty map so the MOVES list still renders
 * (moves simply show no learners). The `species` list seeds the fan-out and
 * annotates each learner; an empty list resolves to an empty map WITHOUT caching
 * so a later call with the real list still builds the index.
 */
export function loadLearnerIndex(
  species: SpeciesEntry[],
): Promise<Map<string, MoveLearner[]>> {
  if (species.length === 0) return Promise.resolve(new Map());
  if (!cache) cache = buildIndex(species).catch(() => new Map());
  return cache;
}

async function buildIndex(
  species: SpeciesEntry[],
): Promise<Map<string, MoveLearner[]>> {
  const details = await Promise.all(
    species.map((sp) =>
      invoke<SpeciesDetail>("paldex_species_detail", { id: sp.id }).catch(
        () => null,
      ),
    ),
  );

  // Keep one learner row per species per move, at the LOWEST level it is learned
  // (a species can list the same move at several levels; the earliest is what a
  // "learned by · Lv N" reference wants).
  const byMove = new Map<string, Map<string, MoveLearner>>();
  details.forEach((detail, i) => {
    if (!detail) return;
    const sp = species[i];
    for (const m of detail.learnset) {
      let bySpecies = byMove.get(m.id);
      if (!bySpecies) {
        bySpecies = new Map();
        byMove.set(m.id, bySpecies);
      }
      const prev = bySpecies.get(sp.id);
      if (!prev || m.level < prev.level) {
        bySpecies.set(sp.id, { species: sp, level: m.level });
      }
    }
  });

  // Flatten each move's learners to an array sorted by earliest level, then name
  // — the order the LEARNED BY list reads top-to-bottom.
  const index = new Map<string, MoveLearner[]>();
  for (const [wazaId, bySpecies] of byMove) {
    const learners = [...bySpecies.values()].sort(
      (a, b) => a.level - b.level || a.species.name.localeCompare(b.species.name),
    );
    index.set(wazaId, learners);
  }
  return index;
}
