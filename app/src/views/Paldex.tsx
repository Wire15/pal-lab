import { useCallback, useEffect, useState } from "react";
import { invoke } from "../lib/tauri";
import type { RosterCounts, SpeciesEntry } from "../lib/types";
import { useAppState } from "../state";
import PaldexIndex from "./paldex/index-view";
import PaldexDetail from "./paldex/detail-view";

/**
 * Pal-dex reference layer. Owns the full species list, the current save's
 * roster tally (annotation), and which species detail is open. The index and
 * detail sub-views are otherwise self-contained.
 */
export default function Paldex() {
  const { saveDir, setSaveDir } = useAppState();
  const [species, setSpecies] = useState<SpeciesEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterCounts | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  useEffect(() => {
    invoke<SpeciesEntry[]>("paldex_species").then(setSpecies).catch(() => {});
  }, []);

  const loadRoster = useCallback(async (dir: string) => {
    if (!dir.trim()) return;
    setRosterLoading(true);
    setRosterError(null);
    try {
      setRoster(await invoke<RosterCounts>("roster_counts", { saveDir: dir }));
    } catch (e) {
      setRosterError(String(e));
      setRoster(null);
    } finally {
      setRosterLoading(false);
    }
  }, []);

  // Reuse a save already loaded in another view: pull its roster once on mount.
  useEffect(() => {
    if (saveDir.trim()) loadRoster(saveDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <PaldexIndex
      species={species}
      roster={roster}
      saveDir={saveDir}
      setSaveDir={setSaveDir}
      loadRoster={loadRoster}
      rosterLoading={rosterLoading}
      rosterError={rosterError}
      onSelect={setSelectedId}
    />
  );
}
