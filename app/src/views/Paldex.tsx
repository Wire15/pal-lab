import { useEffect, useMemo, useState } from "react";
import { invoke } from "../lib/tauri";
import type { OwnedPal, SpeciesEntry } from "../lib/types";
import { useAppState } from "../state";
import { hexGuid } from "../components/palbox/selectors";
import type { DexTab } from "../components/dex-tabs";
import PaldexIndex from "./paldex/index-view";
import PaldexDetail from "./paldex/detail-view";
import PassivesIndex from "./paldex/passives-view";
import MovesIndex from "./paldex/moves-view";

/**
 * Pal-dex reference layer. Owns the full species list and which species detail
 * is open. The roster annotation comes from the shared app state (derived once
 * from the loaded save summary), so switching to this view never refetches.
 *
 * A detail can be opened two ways: from the dex itself (species-only) or from
 * the Save Inspector for a specific owned instance (enriched with its save
 * data). The latter remembers its origin so the detail's back bar returns to
 * the Save Inspector rather than the dex index.
 */
export default function Paldex() {
  const { roster, saveSummary, dexTarget, dexInstance, clearDexTarget, setView } =
    useAppState();
  const [species, setSpecies] = useState<SpeciesEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instanceHex, setInstanceHex] = useState<string | null>(null);
  const [fromSave, setFromSave] = useState(false);
  const [tab, setTab] = useState<DexTab>("pals");
  // A move id to reveal + highlight when the MOVES tab opens, set by a detail's
  // LEARNABLE MOVES cross-link; MovesIndex clears it once consumed.
  const [focusMoveId, setFocusMoveId] = useState<string | null>(null);

  useEffect(() => {
    invoke<SpeciesEntry[]>("paldex_species").then(setSpecies).catch(() => {});
  }, []);

  // Consume a one-shot dex target (species click in the dex, or an owned
  // instance from the Save Inspector): always lands on a species, so snap back
  // to the pals tab. An instance guid also flags the save origin.
  useEffect(() => {
    if (dexTarget !== null) {
      setSelectedId(dexTarget);
      setInstanceHex(dexInstance);
      setFromSave(dexInstance !== null);
      setTab("pals");
      clearDexTarget();
    }
  }, [dexTarget, dexInstance, clearDexTarget]);

  // Resolve the owned instance (when one was requested) from the cached save.
  const instance = useMemo<OwnedPal | null>(() => {
    if (!instanceHex || !saveSummary) return null;
    return (
      saveSummary.pals.find((p) => hexGuid(p.instance_id) === instanceHex) ?? null
    );
  }, [instanceHex, saveSummary]);

  // In-dex navigation (parent/child/combo cells) drops any instance context —
  // a different species is a plain reference view whose back returns to the dex.
  function navigate(id: string) {
    setSelectedId(id);
    setInstanceHex(null);
    setFromSave(false);
  }

  // Back: return to the Save Inspector when the detail was opened from there,
  // otherwise fall back to the dex index.
  function back() {
    if (fromSave) {
      setView("save");
      return;
    }
    setSelectedId(null);
    setInstanceHex(null);
  }

  // Detail's LEARNABLE MOVES cross-link: leave the detail, switch to the MOVES
  // tab, and hand it the move to focus.
  function openMove(wazaId: string) {
    setSelectedId(null);
    setInstanceHex(null);
    setFromSave(false);
    setTab("moves");
    setFocusMoveId(wazaId);
  }

  if (selectedId) {
    return (
      <PaldexDetail
        id={selectedId}
        roster={roster}
        instance={instance}
        players={saveSummary?.players ?? []}
        onBack={back}
        onNavigate={navigate}
        onOpenMove={openMove}
      />
    );
  }

  if (tab === "passives") {
    return <PassivesIndex tab={tab} onTab={setTab} />;
  }

  if (tab === "moves") {
    return (
      <MovesIndex
        species={species}
        tab={tab}
        onTab={setTab}
        onSelectPal={navigate}
        focusMoveId={focusMoveId}
        onFocusConsumed={() => setFocusMoveId(null)}
      />
    );
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
