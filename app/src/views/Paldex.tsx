import { useEffect, useState } from "react";
import { invoke } from "../lib/tauri";
import type { SpeciesEntry } from "../lib/types";
import { useAppState } from "../state";
import type { DexTab } from "../components/dex-tabs";
import PaldexIndex from "./paldex/index-view";
import PaldexDetail from "./paldex/detail-view";
import PassivesIndex from "./paldex/passives-view";

/**
 * Pal-dex reference layer. Owns the full species list and which species detail
 * is open. The roster annotation comes from the shared app state (derived once
 * from the loaded save summary), so switching to this view never refetches.
 */
export default function Paldex() {
  const { roster, dexTarget, clearDexTarget } = useAppState();
  const [species, setSpecies] = useState<SpeciesEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DexTab>("pals");

  useEffect(() => {
    invoke<SpeciesEntry[]>("paldex_species").then(setSpecies).catch(() => {});
  }, []);

  // Consume a one-shot dex target (e.g. "View in Pal-dex" from the roster):
  // always lands on a species, so snap back to the pals tab.
  useEffect(() => {
    if (dexTarget !== null) {
      setSelectedId(dexTarget);
      setTab("pals");
      clearDexTarget();
    }
  }, [dexTarget, clearDexTarget]);

  if (selectedId) {
    return (
      <PaldexDetail
        id={selectedId}
        roster={roster}
        onBack={() => setSelectedId(null)}
        onNavigate={setSelectedId}
      />
    );
  }

  if (tab === "passives") {
    return <PassivesIndex tab={tab} onTab={setTab} />;
  }

  return (
    <PaldexIndex
      species={species}
      roster={roster}
      onSelect={setSelectedId}
      tab={tab}
      onTab={setTab}
    />
  );
}
