import { memo, useMemo, useState } from "react";
import type { RosterCounts, SpeciesEntry } from "../../lib/types";
import { PalHoverCard } from "../../components/pal-hover-card";
import { ElementBadges, ElementIcon } from "../../components/element";
import { palIconUrl, UNKNOWN_ICON } from "../../lib/assets";
import { DexTabs, type DexTab } from "../../components/dex-tabs";
import {
  DexFilterButton,
  EMPTY_DEX_FILTERS,
  dexFilterCount,
  matchesDexFilters,
  type DexFilterState,
  type PassiveOption,
} from "./dex-filters";

type SortKey = "paldex" | "name" | "rank";
type SortDir = "asc" | "desc";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "paldex", label: "Dex #" },
  { key: "name", label: "Name" },
  { key: "rank", label: "Combi rank" },
];

/** The 9 canonical element types, in the §2 palette order, for the filter row. */
const ELEMENT_KINDS = [
  "Normal",
  "Fire",
  "Water",
  "Leaf",
  "Electricity",
  "Ice",
  "Earth",
  "Dark",
  "Dragon",
];

/** Circular species portrait in the Palbox slot idiom (see palbox/slot.tsx and
 *  plan-graph PalCircle): art clipped to a ringed circle. Owned species carry a
 *  full-saturation amber ring; unowned species (with a save loaded) desaturate
 *  so dex completion reads at a glance; with no save every tile stays neutral.
 *  Holds its own icon-failed state so the fallback works inside the grid map. */
function DexPortrait({
  id,
  state,
}: {
  id: string;
  state: "owned" | "unowned" | "neutral";
}) {
  const [failed, setFailed] = useState(false);
  const src = !failed ? palIconUrl(id) : UNKNOWN_ICON;
  const ring =
    state === "owned"
      ? "ring-amber/55 group-hover:ring-amber"
      : state === "unowned"
        ? "ring-line/50 group-hover:ring-amber/40"
        : "ring-line/70 group-hover:ring-amber/50";
  const dim =
    state === "unowned"
      ? "opacity-60 saturate-[0.45] group-hover:opacity-100 group-hover:saturate-100"
      : "";
  return (
    <span
      className={`block h-full w-full overflow-hidden rounded-full bg-abyss/70 ring-1 transition-[box-shadow,transform] group-hover:-translate-y-0.5 ${ring}`}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className={`h-full w-full object-contain transition-[opacity,filter] ${dim}`}
      />
    </span>
  );
}

/** One species grid tile — memoized so a re-sort or filter reorders the keyed
 *  tiles without re-rendering each tile's portrait/hover-card/badges (299 tiles
 *  otherwise re-render on every sort). Props are all stable values: `s` is a
 *  fixed object from the species list, `onSelect` a stable setter. */
const DexTile = memo(function DexTile({
  s,
  state,
  male,
  female,
  onSelect,
}: {
  s: SpeciesEntry;
  state: "owned" | "unowned" | "neutral";
  male: number;
  female: number;
  onSelect: (id: string) => void;
}) {
  const total = male + female;
  return (
    <PalHoverCard speciesId={s.id}>
      <button
        onClick={() => onSelect(s.id)}
        aria-label={`${s.name}, #${String(s.paldex_no).padStart(3, "0")}`}
        className="group flex flex-col items-center gap-2 rounded-2xl px-1 py-2 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 focus-visible:ring-offset-abyss"
      >
        <div className="relative mx-auto aspect-square w-full max-w-[104px]">
          <DexPortrait id={s.id} state={state} />
          {/* Element type chip — bottom overlay, palbox badge idiom */}
          <span className="absolute -bottom-1 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-abyss/90 px-1.5 py-0.5">
            <ElementBadges elements={s.elements} size={13} />
          </span>
        </div>
        <div className="flex w-full flex-col items-center gap-0.5">
          <div className="max-w-full truncate text-[13px] font-medium text-ink">
            {s.name}
          </div>
          <div className="flex items-center gap-1.5 font-mono text-[10px] leading-none tabular-nums text-ink-faint">
            <span>#{String(s.paldex_no).padStart(3, "0")}</span>
            {s.is_variant && <span className="font-bold text-el-dragon">B</span>}
            <span className="text-ink-faint/60">{"\u00b7"}</span>
            <span>rank {s.combi_rank}</span>
          </div>
          {total > 0 && (
            <div className="flex items-center gap-1.5 font-mono text-[11px] leading-none tabular-nums">
              {male > 0 && (
                <span className="text-el-water">{"\u2642"}{male}</span>
              )}
              {female > 0 && (
                <span className="text-el-dragon">{"\u2640"}{female}</span>
              )}
            </div>
          )}
        </div>
      </button>
    </PalHoverCard>
  );
});

export default function PaldexIndex({
  species,
  roster,
  onSelect,
  tab,
  onTab,
}: {
  species: SpeciesEntry[];
  roster: RosterCounts | null;
  onSelect: (id: string) => void;
  tab: DexTab;
  onTab: (t: DexTab) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("paldex");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [hideVariants, setHideVariants] = useState(false);
  const [elements, setElements] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<DexFilterState>(EMPTY_DEX_FILTERS);

  function toggleElement(kind: string) {
    setElements((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const ownedSpecies = useMemo(
    () => (roster ? Object.values(roster).filter((c) => c.male + c.female > 0).length : 0),
    [roster],
  );

  // Filter options for the guaranteed-passive picker: every guaranteed passive
  // present across the dataset (unique by name), strongest rank first.
  const passiveOptions = useMemo<PassiveOption[]>(() => {
    const seen = new Map<string, PassiveOption>();
    for (const s of species)
      for (const p of s.guaranteed_passives)
        if (!seen.has(p.name)) seen.set(p.name, { id: p.id, name: p.name, rank: p.rank });
    return [...seen.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  }, [species]);

  const deepCount = dexFilterCount(filters);
  const anyOtherFilter = deepCount > 0 || elements.size > 0 || hideVariants;
  const anyFilterActive = anyOtherFilter || ownedOnly;

  function clearAllFilters() {
    setElements(new Set());
    setOwnedOnly(false);
    setHideVariants(false);
    setFilters(EMPTY_DEX_FILTERS);
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = species.filter((s) => {
      if (hideVariants && s.is_variant) return false;
      if (ownedOnly && !(roster?.[s.id] && roster[s.id].male + roster[s.id].female > 0)) return false;
      if (elements.size > 0 && !s.elements.some((e) => elements.has(e))) return false;
      if (deepCount > 0 && !matchesDexFilters(s, filters)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        String(s.paldex_no) === q
      );
    });

    list = [...list].sort((a, b) => {
      let cmp: number;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "rank") cmp = a.combi_rank - b.combi_rank || a.combi_rank_priority - b.combi_rank_priority;
      else cmp = a.paldex_no - b.paldex_no || a.name.localeCompare(b.name);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [species, roster, query, sortKey, sortDir, ownedOnly, hideVariants, elements, filters, deepCount]);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line bg-panel/60 px-6 pb-4 pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex items-center gap-4">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
                Pal-dex
              </div>
              <h1 className="font-display text-xl font-bold tracking-wide text-ink">
                Reference
              </h1>
            </div>
            <DexTabs tab={tab} onTab={onTab} />
          </div>
          <div className="text-right font-mono text-xs text-ink-dim">
            <span className="text-ink">{species.length}</span> species
            {roster && (
              <>
                <span className="mx-2 text-ink-faint">/</span>
                <span className="text-amber">{ownedSpecies}</span> owned
              </>
            )}
          </div>
        </div>

        {/* Search + sort + filters */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
            placeholder="Search by name, id, or dex number..."
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <div className="flex items-center overflow-hidden rounded-md border border-line">
            {SORTS.map((s) => {
              const active = sortKey === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => toggleSort(s.key)}
                  className={`select-none border-l border-line px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors first:border-l-0 ${
                    active ? "bg-raised text-amber" : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                  }`}
                >
                  {s.label}
                  {active && (
                    <span className="ml-1 text-amber">{sortDir === "asc" ? "\u25b2" : "\u25bc"}</span>
                  )}
                </button>
              );
            })}
          </div>
          <label
            className={`flex select-none items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
              roster
                ? "cursor-pointer border-line bg-panel text-ink-dim hover:text-ink"
                : "cursor-not-allowed border-line-soft bg-panel/50 text-ink-faint"
            }`}
            title={roster ? undefined : "Load a save to filter by owned pals"}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--color-amber)]"
              checked={ownedOnly}
              disabled={!roster}
              onChange={(e) => setOwnedOnly(e.currentTarget.checked)}
            />
            Owned only
          </label>
          <label className="flex cursor-pointer select-none items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px] text-ink-dim transition-colors hover:text-ink">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--color-amber)]"
              checked={hideVariants}
              onChange={(e) => setHideVariants(e.currentTarget.checked)}
            />
            Hide variants
          </label>
          <DexFilterButton
            filters={filters}
            onChange={setFilters}
            passiveOptions={passiveOptions}
          />
          {anyFilterActive && (
            <button
              onClick={clearAllFilters}
              className="select-none rounded-md border border-line-soft bg-panel px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-faint transition-colors hover:bg-hover hover:text-ink-dim"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Element filter — multi-select, OR semantics, ANDed with the rest */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Element
          </span>
          <div className="flex items-center gap-1">
            {ELEMENT_KINDS.map((kind) => {
              const active = elements.has(kind);
              return (
                <button
                  key={kind}
                  onClick={() => toggleElement(kind)}
                  title={kind}
                  aria-pressed={active}
                  className={`group flex items-center justify-center rounded-sm border p-0.5 transition-colors ${
                    active
                      ? "border-amber/70 bg-raised"
                      : "border-line/60 bg-panel hover:border-line hover:bg-hover"
                  }`}
                >
                  <ElementIcon
                    element={kind}
                    size={18}
                    className={
                      active
                        ? ""
                        : "opacity-45 grayscale transition-[filter,opacity] group-hover:opacity-90 group-hover:grayscale-0"
                    }
                  />
                </button>
              );
            })}
          </div>
          {elements.size > 0 && (
            <button
              onClick={() => setElements(new Set())}
              className="font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-dim"
            >
              Clear
            </button>
          )}
        </div>
      </header>

      {/* Grid */}
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="font-display text-lg text-ink-dim">
            {ownedOnly && !query && !anyOtherFilter ? "No owned pals" : "No pals match"}
          </div>
          <p className="max-w-xs text-sm text-ink-faint">
            {ownedOnly && !query && !anyOtherFilter
              ? "Load a save with owned pals, or turn off the owned-only filter."
              : query
                ? `Nothing matches \u201c${query}\u201d. Try a different name or dex number.`
                : "No pals match the active filters. Loosen a level, tier, or passive."}
          </p>
          {anyFilterActive && (
            <button
              onClick={clearAllFilters}
              className="mt-1 rounded-md border border-line bg-raised px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="grid grid-cols-5 gap-x-4 gap-y-6">
            {rows.map((s) => {
              const owned = roster ? roster[s.id] : undefined;
              const total = owned ? owned.male + owned.female : 0;
              const state = !roster ? "neutral" : total > 0 ? "owned" : "unowned";
              return (
                <DexTile
                  key={s.id}
                  s={s}
                  state={state}
                  male={owned?.male ?? 0}
                  female={owned?.female ?? 0}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
