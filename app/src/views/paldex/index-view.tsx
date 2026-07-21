import { useMemo, useState } from "react";
import type { RosterCounts, SpeciesEntry } from "../../lib/types";
import { PalIcon } from "../../components/primitives";
import { PalHoverCard } from "../../components/pal-hover-card";
import { CardWorkBadges } from "../../components/work-suit";

type SortKey = "paldex" | "name" | "rank";
type SortDir = "asc" | "desc";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "paldex", label: "Dex #" },
  { key: "name", label: "Name" },
  { key: "rank", label: "Combi rank" },
];

export default function PaldexIndex({
  species,
  roster,
  onSelect,
}: {
  species: SpeciesEntry[];
  roster: RosterCounts | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("paldex");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [hideVariants, setHideVariants] = useState(false);

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

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = species.filter((s) => {
      if (hideVariants && s.is_variant) return false;
      if (ownedOnly && !(roster?.[s.id] && roster[s.id].male + roster[s.id].female > 0)) return false;
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
  }, [species, roster, query, sortKey, sortDir, ownedOnly, hideVariants]);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line bg-panel/60 px-6 pb-4 pt-5">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
              Pal-dex
            </div>
            <h1 className="font-display text-xl font-bold tracking-wide text-ink">
              Reference
            </h1>
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
        </div>
      </header>

      {/* Grid */}
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="font-display text-lg text-ink-dim">
            {ownedOnly && !query ? "No owned pals" : "No pals match"}
          </div>
          <p className="max-w-xs text-sm text-ink-faint">
            {ownedOnly && !query
              ? "Load a save with owned pals, or turn off the owned-only filter."
              : `Nothing matches \u201c${query}\u201d. Try a different name or dex number.`}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(184px,1fr))]">
            {rows.map((s) => {
              const owned = roster ? roster[s.id] : undefined;
              const total = owned ? owned.male + owned.female : 0;
              return (
                <PalHoverCard key={s.id} speciesId={s.id}>
                  <button
                    onClick={() => onSelect(s.id)}
                    className="group flex flex-col gap-2 rounded-md border border-line bg-panel p-3 text-left transition-colors hover:border-amber/40 hover:bg-hover"
                  >
                    <div className="flex items-start justify-between font-mono text-[10px] leading-none">
                      <span className="text-ink-faint tabular-nums">
                        #{String(s.paldex_no).padStart(3, "0")}
                        {s.is_variant && <span className="ml-1 text-el-dragon">B</span>}
                      </span>
                      {total > 0 && (
                        <span className="tabular-nums">
                          {owned!.male > 0 && <span className="text-el-water">{"\u2642"}{owned!.male}</span>}
                          {owned!.male > 0 && owned!.female > 0 && " "}
                          {owned!.female > 0 && <span className="text-el-dragon">{"\u2640"}{owned!.female}</span>}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2.5">
                      <PalIcon id={s.id} name={s.name} size={44} />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink group-hover:text-ink">
                          {s.name}
                        </div>
                        <div className="font-mono text-[11px] tabular-nums text-ink-faint">
                          rank {s.combi_rank}
                        </div>
                      </div>
                    </div>
                    <CardWorkBadges work={s.work_suitability} />
                  </button>
                </PalHoverCard>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
