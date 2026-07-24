// The map filter popover (the in-game "Filter" equivalent): one row per overlay
// layer with a toggle and a live count, plus the "show hidden" spoiler override.
// MapView owns the filter state (persisted to localStorage); this is the
// presentation. Anchored under the header "Filter" button.

import type { LayerFilters } from "./PinLayer";
import type { PoiCounts } from "./pins";

/** A layer toggle row: a checkbox-style switch, label, and a right-aligned
 *  count chip. `dimCount` styles the count as approximate (no per-pin join). */
function Row({
  on,
  onToggle,
  label,
  count,
  countTitle,
  dimCount,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  count?: string;
  countTitle?: string;
  dimCount?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-hover"
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
          on ? "border-amber bg-amber text-abyss" : "border-line bg-abyss"
        }`}
      >
        {on && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
          </svg>
        )}
      </span>
      <span
        className={`flex-1 font-mono text-[12px] tracking-wide ${on ? "text-ink" : "text-ink-faint"}`}
      >
        {label}
      </span>
      {count && (
        <span
          title={countTitle}
          className={`font-mono text-[11px] tabular-nums ${dimCount ? "text-ink-faint italic" : "text-ink-dim"}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export default function FilterPanel({
  filters,
  setFilter,
  counts,
  hasBounties,
  spawnLabel,
  playerCount,
  markerCount,
  basesCount,
  fogOn,
  showHidden,
  setShowHidden,
}: {
  filters: LayerFilters;
  setFilter: (key: keyof LayerFilters, on: boolean) => void;
  counts: PoiCounts;
  hasBounties: boolean;
  spawnLabel: string | null;
  playerCount: number;
  markerCount: number;
  basesCount: number;
  fogOn: boolean;
  showHidden: boolean;
  setShowHidden: (on: boolean) => void;
}) {
  const ft = counts.fastTravel;
  const ef = counts.effigies;
  return (
    <div className="absolute right-0 top-full z-20 mt-2 w-60 rounded-md border border-line bg-panel/95 p-1.5 shadow-lg backdrop-blur">
      <div className="px-2 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
        Layers
      </div>
      <Row
        on={filters.fastTravel}
        onToggle={() => setFilter("fastTravel", !filters.fastTravel)}
        label="Fast Travel"
        count={`${ft.found}/${ft.total}`}
        countTitle={counts.joined ? "Unlocked / total" : "Unlocked (per-pin match unavailable)"}
        dimCount={!counts.joined}
      />
      <Row
        on={filters.alpha}
        onToggle={() => setFilter("alpha", !filters.alpha)}
        label="Alpha Pals"
        count={String(counts.alphas)}
      />
      <Row
        on={filters.effigies}
        onToggle={() => setFilter("effigies", !filters.effigies)}
        label="Effigies"
        count={`${ef.found}/${ef.total}`}
        countTitle={counts.joined ? "Collected / total" : "Collected (per-pin match unavailable)"}
        dimCount={!counts.joined}
      />
      {hasBounties && (
        <Row
          on={filters.bounties}
          onToggle={() => setFilter("bounties", !filters.bounties)}
          label="Bounties"
          count={String(counts.bounties)}
        />
      )}
      <Row
        on={filters.spawns}
        onToggle={() => setFilter("spawns", !filters.spawns)}
        label="Spawns"
        count={spawnLabel ?? "—"}
        countTitle={spawnLabel ? `Showing ${spawnLabel}` : "Search a species below"}
      />
      <Row
        on={filters.players}
        onToggle={() => setFilter("players", !filters.players)}
        label="Players"
        count={String(playerCount)}
      />
      <Row
        on={filters.markers}
        onToggle={() => setFilter("markers", !filters.markers)}
        label="Markers"
        count={String(markerCount)}
      />
      {basesCount > 0 && (
        <Row
          on={filters.bases}
          onToggle={() => setFilter("bases", !filters.bases)}
          label="Bases"
          count={String(basesCount)}
          countTitle="Your base camps"
        />
      )}

      {fogOn && (
        <div className="mt-1 border-t border-line-soft pt-1.5">
          <Row
            on={showHidden}
            onToggle={() => setShowHidden(!showHidden)}
            label="Show hidden"
          />
          <p className="px-2 pb-1 pt-0.5 font-mono text-[9px] leading-relaxed tracking-wide text-warn/80">
            {showHidden
              ? "Revealing pins in unexplored areas — spoilers."
              : "Pins under fog are hidden to avoid spoilers."}
          </p>
        </div>
      )}
    </div>
  );
}
