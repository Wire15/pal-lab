// Pure presentation model for the captured-human card, split out of the .tsx so
// the honest-empty behavior and work ordering are unit-testable without pulling
// the React/Tauri component tree into the test runner.

import type { OwnedPal } from "../lib/types";
import { getHuman, type HumanInfo } from "../lib/humans";

/** The presentation model behind the human card. `info` is null for an unknown
 *  id, in which case `name` is the raw CharacterID, `faction` is "Unknown", and
 *  `work` is empty (the card then shows no stats/work sections). */
export interface HumanCardModel {
  info: HumanInfo | null;
  name: string;
  faction: string;
  /** Nonzero work suitabilities, highest level first. */
  work: [string, number][];
}

export function humanCardModel(pal: OwnedPal): HumanCardModel {
  const info = getHuman(pal.character_id);
  return {
    info,
    name: info?.name ?? pal.character_id,
    faction: info?.faction ?? "Unknown",
    work: info
      ? Object.entries(info.work)
          .filter(([, lv]) => lv > 0)
          .sort((a, b) => b[1] - a[1])
      : [],
  };
}
