// Resolve a plan/queue node's owned-instance GUID to the live OwnedPal in the
// currently-loaded save. Plans store only the instance_id (a serde [u8;16]
// array); the roster carries the full instance, so the two are joined here by
// the canonical lowercase-hex key (`hexGuid`, the same key the palbox uses).
//
// The map is memoized over `saveSummary.pals`, so every hover trigger shares
// one lookup and only rebuilds when the save reloads. Callers pass the node's
// optional `instance_id`; anything the current save can't resolve — no save
// loaded, a legacy plan with no id, a synthetic queue seed, or a save switched
// out from under an old plan — falls through to `undefined`, and the caller
// degrades to species-only rendering.

import { useMemo } from "react";
import { hexGuid } from "../components/palbox/selectors";
import { useAppState } from "../state";
import type { Guid, OwnedPal } from "./types";

/** Returns a stable resolver from an instance GUID to its OwnedPal, or
 *  `undefined` when there is no save or the id is missing/unknown. */
export function usePalByInstance(): (
  id?: Guid | null,
) => OwnedPal | undefined {
  const { saveSummary } = useAppState();
  const byHex = useMemo(() => {
    const m = new Map<string, OwnedPal>();
    if (saveSummary) {
      for (const p of saveSummary.pals) m.set(hexGuid(p.instance_id), p);
    }
    return m;
  }, [saveSummary]);
  return useMemo(
    () => (id?: Guid | null) => (id && id.length > 0 ? byHex.get(hexGuid(id)) : undefined),
    [byHex],
  );
}
