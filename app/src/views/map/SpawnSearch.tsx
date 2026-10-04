// Spawn overlay control: a species search combobox (same datalist pattern as
// the Solver's target field) plus, once a species is chosen, a legend chip
// showing the species, its on-layer point count and level range, a day/night
// key, a jump-to-dex link, and a clear button. The heat-dot rendering itself
// lives in MapView's canvas paint; this is only the control surface.

import { useState } from "react";
import { PalIcon } from "../../components/primitives";
import type { SpawnKind, SpawnPeriod } from "../../lib/map-spawns";

/** Aggregate legend info for the active species on the active layer. */
export interface SpawnLegend {
  count: number;
  lv: [number, number];
  hasDay: boolean;
  hasNight: boolean;
  wildCount: number;
  alphaCount: number;
}

export default function SpawnSearch({
  options,
  selectedId,
  selectedName,
  legend,
  onSelect,
  onClear,
  onOpenDex,
  kind,
  period,
  onKindChange,
  onPeriodChange,
}: {
  options: { id: string; name: string }[];
  selectedId: string | null;
  selectedName: string | null;
  legend: SpawnLegend | null;
  onSelect: (id: string) => void;
  onClear: () => void;
  onOpenDex: (id: string) => void;
  kind: SpawnKind;
  period: SpawnPeriod;
  onKindChange: (kind: SpawnKind) => void;
  onPeriodChange: (period: SpawnPeriod) => void;
}) {

  const [text, setText] = useState("");
  const nameToId = new Map(options.map((o) => [o.name, o.id]));

  return <div className="flex flex-wrap items-center gap-2">
    <label className="sr-only" htmlFor="map-spawn-kind">{"Encounter type"}</label>
    <select id="map-spawn-kind" value={kind} onChange={e => onKindChange(e.target.value as SpawnKind)}
      className="rounded-md border border-line bg-abyss px-2 py-1.5 text-xs text-ink-dim">
      <option value="wild">{"Wild spawns"}</option>
      <option value="alpha">{"Alpha Pals"}</option>
      <option value="both">{"Wild and Alpha"}</option>
    </select>
    <label className="sr-only" htmlFor="map-spawn-period">{"Spawn period"}</label>
    <select id="map-spawn-period" value={period} onChange={e => onPeriodChange(e.target.value as SpawnPeriod)}
      title={"Spawns without a time restriction remain visible during both day and night."}
      className="rounded-md border border-line bg-abyss px-2 py-1.5 text-xs text-ink-dim">
      <option value="all">{"All times"}</option>
      <option value="day">{"Day"}</option>
      <option value="night">{"Night"}</option>
    </select>
    {selectedId && legend ? (
      <div className="flex max-w-full flex-wrap items-center gap-2 rounded-md border border-el-leaf/40 bg-el-leaf/10 py-1 pl-1.5 pr-1 font-mono text-[11px]">
        <PalIcon id={selectedId} size={20} className="!rounded-full" />
        <button
          type="button"
          onClick={() => onOpenDex(selectedId)}
          className="tracking-wide text-el-leaf transition-colors hover:text-ink"
          title={"Open in Pal-dex"}
        >
          {selectedName ?? selectedId}
        </button>
        <span className="tabular-nums text-ink-dim">
          {legend.count} {legend.count === 1 ? "site" : "sites"}
        </span>
        <span className="text-line">·</span>
        {legend.count > 0 ? <>
          <span className="tabular-nums text-ink-faint">{"Lv "}{legend.lv[0] === legend.lv[1] ? legend.lv[0] : `${legend.lv[0]}–${legend.lv[1]}`}</span>
          <span className="text-ink-faint">{`${legend.wildCount} wild · ${legend.alphaCount} Alpha`}</span>
        </> : <span className="text-ink-faint">{"No locations for this map and period"}</span>}
        {legend.hasNight && (
          <span className="text-el-dark" title={"Night-only spawns present"}>
            {"\u263e"}
          </span>
        )}
        {legend.hasDay && legend.hasNight && (
          <span className="text-amber" title={"Day spawns present"}>
            {"\u2600"}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setText("");
            onClear();
          }}
          aria-label={"Clear spawn overlay"}
          className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
    ) : (
    <div className="flex items-center gap-2 rounded-md border border-line bg-abyss px-2 py-1 focus-within:border-el-leaf/60">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-faint">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" strokeLinecap="round" />
      </svg>
      <input
        className="w-40 min-w-0 bg-transparent py-0.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:outline-none"
        list="spawn-species-options"
        placeholder={"Find spawns…"}
        aria-label={"Find spawns…"}
        value={text}
        onChange={(e) => {
          const v = e.currentTarget.value;
          setText(v);
          const id = nameToId.get(v);
          if (id) onSelect(id);
        }}
      />
      <datalist id="spawn-species-options">
        {options.map((o) => (
          <option key={o.id} value={o.name} />
        ))}
      </datalist>
    </div>
    )}
  </div>;
}
