import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import { isAlpha, type NamedEntry, type OwnedPal, type SpeciesEntry } from "../lib/types";
import { containerLabel, genderView, ivBand, QUALITY_FILL, QUALITY_TEXT } from "../lib/ui";
import { PalIcon, Tag } from "../components/primitives";
import { PassiveStrip } from "../components/passive-strip";
import { useAppState } from "../state";
import { FilterBar } from "../components/palbox/filter-bar";
import { BaseStrip, BoxGrid, PartyRail } from "../components/palbox/surfaces";
import { usePalboxState, type PalboxMode } from "../components/palbox/use-palbox-state";
import {
  applyQuery,
  baseGroups,
  compactPages,
  dimensionalPages,
  GRID_COLS,
  guildBases,
  hexGuid,
  isQueryActive,
  matchesQuery,
  palKey,
  partySlots,
  physicalPages,
  playerContainers,
  scopeBasesToPlayer,
  type GridCell,
  type SortKey,
} from "../components/palbox/selectors";

type BoxSurface = "palbox" | "dimensional" | "global" | "cage";

const SURFACE_LABEL: Record<BoxSurface, string> = {
  palbox: "Palbox",
  dimensional: "Dimensional",
  global: "Global storage",
  cage: "Viewing cages",
};

/** One IV talent for the list table: mono numeral tinted by band + quality bar. */
function IvCell({ value }: { value: number }) {
  const band = ivBand(value);
  return (
    <div className="flex flex-col items-end gap-1">
      <span className={`font-mono text-[13px] font-medium tabular-nums ${QUALITY_TEXT[band]}`}>
        {value}
      </span>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-abyss">
        <span
          className={`block h-full rounded-full ${QUALITY_FILL[band]}`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </span>
    </div>
  );
}

/** Column headers that map to a shared sort key are clickable; the rest are
 *  plain labels. Ordering for both modes comes from the one shared query. */
const SORTABLE_COLUMNS: Partial<Record<SortKey, true>> = { name: true, level: true };

/** One roster row — memoized so re-sorts, filter changes and selection moves
 *  only re-render the rows that actually changed (a 637-row list otherwise
 *  re-renders every row, each with an icon + IV cells + passive strips). Props
 *  are stable: `pal` is a fixed object, `name` a resolved string, `onSelect` a
 *  stable callback; only `selected` flips for the two rows a cursor move touches. */
const RosterRow = memo(function RosterRow({
  pal,
  name,
  selected,
  onSelect,
}: {
  pal: OwnedPal;
  name: string;
  selected: boolean;
  onSelect: (pal: OwnedPal) => void;
}) {
  const g = genderView(pal.gender);
  return (
    <tr
      data-pal={palKey(pal)}
      onClick={() => onSelect(pal)}
      aria-selected={selected}
      className={`cursor-pointer border-b border-line-soft transition-colors ${
        selected ? "bg-hover" : "hover:bg-panel/70"
      }`}
    >
      <td className="relative px-4 py-2">
        {selected && (
          <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-amber" />
        )}
        <div className="flex items-center gap-3">
          <PalIcon id={pal.character_id} name={name} size={34} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium text-ink">{name}</span>
              {isAlpha(pal) && <Tag tone="boss">Alpha</Tag>}
              {pal.rank > 0 && (
                <span
                  className="font-mono text-[11px] text-amber"
                  title={`Condensation rank ${pal.rank}`}
                >
                  {"\u2605".repeat(pal.rank)}
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[11px] text-ink-faint">
              {pal.nickname ? `"${pal.nickname}"` : pal.character_id}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-2">
        <span className={`text-base leading-none ${g.className}`} title={g.label}>
          {g.glyph}
        </span>
      </td>
      <td className="px-4 py-2 text-right font-mono text-[13px] tabular-nums text-ink-dim">
        {pal.level}
      </td>
      <td className="px-4 py-2">
        <IvCell value={pal.ivs.hp} />
      </td>
      <td className="px-4 py-2">
        <IvCell value={pal.ivs.attack} />
      </td>
      <td className="px-4 py-2">
        <IvCell value={pal.ivs.defense} />
      </td>
      <td className="px-4 py-2">
        <Tag>{containerLabel(pal.container_kind)}</Tag>
      </td>
      <td className="px-4 py-2">
        {pal.passives.length > 0 ? (
          <div className="flex max-w-[24rem] flex-col gap-1">
            {pal.passives.map((p, i) => (
              <PassiveStrip key={`${p}-${i}`} id={p} size="sm" />
            ))}
          </div>
        ) : (
          <span className="text-ink-faint">&mdash;</span>
        )}
      </td>
    </tr>
  );
});

function RosterTable({
  rows,
  nameOf,
  sortKey,
  sortDir,
  onSort,
  selectedKey,
  onSelect,
}: {
  rows: OwnedPal[];
  nameOf: (pal: OwnedPal) => string;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
}) {
  const header = (label: string, key: SortKey | null, align?: "right") => {
    const sortable = key !== null && SORTABLE_COLUMNS[key];
    const active = sortable && sortKey === key;
    return (
      <th
        onClick={sortable ? () => onSort(key) : undefined}
        className={`border-b border-line px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-wider ${
          align === "right" ? "text-right" : "text-left"
        } ${sortable ? "cursor-pointer select-none transition-colors hover:text-ink" : ""} ${
          active ? "text-amber" : "text-ink-faint"
        }`}
      >
        {label}
        {sortable && (
          <span className="ml-1 inline-block w-2 text-amber">
            {active ? (sortDir === "asc" ? "\u25b2" : "\u25bc") : ""}
          </span>
        )}
      </th>
    );
  };

  return (
    <table className="w-full border-collapse text-sm">
      <thead className="sticky top-0 z-10">
        <tr className="bg-raised text-left">
          {header("Pal", "name")}
          {header("Sex", null)}
          {header("Lv", "level", "right")}
          {header("HP", null, "right")}
          {header("ATK", null, "right")}
          {header("DEF", null, "right")}
          {header("Location", null)}
          {header("Passives", null)}
        </tr>
      </thead>
      <tbody>
        {rows.map((pal) => {
          const key = palKey(pal);
          return (
            <RosterRow
              key={key}
              pal={pal}
              name={nameOf(pal)}
              selected={key === selectedKey}
              onSelect={onSelect}
            />
          );
        })}
      </tbody>
    </table>
  );
}

export default function SaveInspector() {
  const { saveSummary, saveLoading, saveError, requestDex } = useAppState();
  const { storedPlayer, setStoredPlayer, mode, setMode, query, patchQuery } =
    usePalboxState();

  const [namesById, setNamesById] = useState<Map<string, string>>(new Map());
  const [species, setSpecies] = useState<Map<string, SpeciesEntry>>(new Map());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [surface, setSurface] = useState<BoxSurface>("palbox");
  const [page, setPage] = useState(0);

  useEffect(() => {
    invoke<NamedEntry[]>("list_species")
      .then((list) => setNamesById(new Map(list.map((s) => [s.id, s.name]))))
      .catch(() => {});
    invoke<SpeciesEntry[]>("paldex_species")
      .then((list) => setSpecies(new Map(list.map((s) => [s.id, s]))))
      .catch(() => {});
  }, []);

  const players = saveSummary?.players ?? [];
  // Resolve the active player: the remembered one if still present, else first.
  const activeUid =
    players.find((p) => p.uid === storedPlayer)?.uid ?? players[0]?.uid ?? "";

  const nameOf = useCallback(
    (pal: OwnedPal) => namesById.get(pal.character_id) ?? pal.character_id,
    [namesById],
  );

  const bases = useMemo(
    () => (saveSummary ? baseGroups(saveSummary.pals) : []),
    [saveSummary],
  );

  const containers = useMemo(
    () =>
      saveSummary
        ? playerContainers(saveSummary.pals, activeUid)
        : { party: [], palbox: [], dimensional: [], global: [], cage: [] },
    [saveSummary, activeUid],
  );

  // Guild-scoped bases (slice A contract: SaveSummary.bases). Show only bases
  // whose guild members include the active player; when players share a guild
  // the bases appear on each member's tab. Falls back to the combined view when
  // guild data is absent (stale fixture / pre-contract backend).
  const guild = useMemo(
    () => (saveSummary ? guildBases(saveSummary) : []),
    [saveSummary],
  );
  const scopedBases = useMemo(
    () => scopeBasesToPlayer(bases, guild, activeUid),
    [bases, guild, activeUid],
  );

  // Fluid slot sizing: measure the (stable) content width and pack the party
  // rail + GRID_COLS box columns into it, so the grid fills the viewport and
  // grows on wider screens. Measuring the wrapper (not the flex-1 box column)
  // avoids a size<->layout feedback loop.
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setContentWidth(entries[0]?.contentRect.width ?? 0);
    });
    ro.observe(el);
    setContentWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [saveSummary, mode]);

  const slotSize = useMemo(() => {
    if (contentWidth <= 0) return 84;
    const ROW_GAP = 24; // party rail -> box grid
    const SLOT_GAP = 12; // matches PalGrid / PartyRail
    const usable = contentWidth - ROW_GAP - (GRID_COLS - 1) * SLOT_GAP;
    const raw = Math.floor(usable / (GRID_COLS + 1)); // +1 = party column
    return Math.max(56, Math.min(160, raw));
  }, [contentWidth]);

  // The intrinsic width of the palbox composition once slots saturate (clamped
  // at 160px on wide screens): party column + row gap + the GRID_COLS box grid.
  // Below saturation this equals the usable width, so centering it is a no-op;
  // once saturated it's narrower than the content area and mx-auto centers it
  // instead of letting the grid hug the left edge.
  const composeWidth = useMemo(() => {
    const ROW_GAP = 24;
    const SLOT_GAP = 12;
    return slotSize * (GRID_COLS + 1) + ROW_GAP + (GRID_COLS - 1) * SLOT_GAP;
  }, [slotSize]);

  // Typing in the search bar updates `query` synchronously (the FilterBar input
  // stays instant); the expensive filtered/paged/roster derivations below read a
  // DEFERRED copy so React renders them in an interruptible pass instead of
  // blocking the keystroke on a full 637-row re-filter+re-render.
  const dq = useDeferredValue(query);
  const active = isQueryActive(dq);

  // The pool that both the list table and the shown/total counter range over:
  // the active player's own pals plus the (player-independent) base pals.
  const pool = useMemo(
    () => [
      ...containers.party,
      ...containers.palbox,
      ...containers.dimensional,
      ...containers.global,
      ...containers.cage,
      ...scopedBases.flatMap((b) => b.pals),
    ],
    [containers, scopedBases],
  );

  const shown = useMemo(
    () => pool.filter((p) => matchesQuery(p, dq, namesById, species)).length,
    [pool, dq, namesById, species],
  );

  // Grid-mode surface pages for the active box surface.
  const pages: GridCell[][] = useMemo(() => {
    const pals =
      surface === "palbox"
        ? containers.palbox
        : surface === "global"
          ? containers.global
          : surface === "cage"
            ? containers.cage
            : containers.dimensional;
    if (active) return compactPages(applyQuery(pals, dq, namesById, species));
    if (surface === "palbox") return physicalPages(pals);
    return dimensionalPages(pals).map((dp) =>
      dp.pals.map((pal, i) => ({ pal, cell: i })),
    );
  }, [surface, containers, active, dq, namesById, species]);

  // List-mode rows: the whole pool under the shared query.
  const rows = useMemo(
    () => applyQuery(pool, dq, namesById, species),
    [pool, dq, namesById, species],
  );

  // The bar hides non-matches on EVERY surface (PALBOX decision 4), not just
  // the box grid: party slots that fail the query blank out, and base rows are
  // filtered (and reordered) then dropped when they hold no matches.
  const partyCells = useMemo(() => {
    const slots = partySlots(containers.party);
    if (!active) return slots;
    return slots.map((p) =>
      p && matchesQuery(p, dq, namesById, species) ? p : null,
    );
  }, [containers.party, active, dq, namesById, species]);

  const visibleBases = useMemo(() => {
    if (!active) return scopedBases;
    return scopedBases
      .map((b) => ({ ...b, pals: applyQuery(b.pals, dq, namesById, species) }))
      .filter((b) => b.pals.length > 0);
  }, [scopedBases, active, dq, namesById, species]);

  // Reset paging when the underlying page set changes (player / surface / query).
  // Land on the first box that actually holds a pal so a player whose pals sit
  // in later physical boxes never opens onto a field of empty slots (compact and
  // dimensional pages are gap-free, so this is box 0 there).
  useEffect(() => {
    const first = pages.findIndex((pg) => pg.some((c) => c.pal));
    setPage(first < 0 ? 0 : first);
  }, [pages]);

  // Clamp the page if the underlying page count shrank.
  const safePage = Math.min(page, Math.max(0, pages.length - 1));

  // Clicking a pal (slot or roster row) opens its Pal-dex page enriched with
  // this instance's save data — the palbox no longer has its own detail panel.
  const openPal = useCallback(
    (pal: OwnedPal) => requestDex(pal.character_id, hexGuid(pal.instance_id)),
    [requestDex],
  );

  // Reset the search + structured filters (keeps the sort) — the one-click
  // escape from an over-narrowed query, mirroring the Pal-dex empty state.
  const clearFilters = useCallback(
    () =>
      patchQuery({
        search: "",
        elements: [],
        gender: "any",
        alphaOnly: false,
        passives: [],
      }),
    [patchQuery],
  );

  // The flat, visual-order list arrow keys walk in grid mode: party, then the
  // current box page, then every base — matching what's on screen.
  const navList = useMemo(() => {
    if (mode !== "grid") return rows;
    const flat: OwnedPal[] = [];
    for (const p of partyCells) if (p) flat.push(p);
    for (const c of pages[safePage] ?? []) if (c.pal) flat.push(c.pal);
    for (const b of visibleBases) flat.push(...b.pals);
    return flat;
  }, [mode, rows, partyCells, pages, safePage, visibleBases]);

  // Keyboard: arrows move a highlight cursor (grid geometry: ±1 horizontal,
  // ±cols vertical), Enter/Space opens the cursor's pal, Esc clears it, and
  // [ ] / PgUp / PgDn page the box grid.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) {
        if (e.key !== "Escape") return;
      }
      if (e.key === "Escape") {
        setSelectedKey(null);
        return;
      }
      // Box paging (grid mode).
      if (mode === "grid" && (e.key === "[" || e.key === "]" || e.key === "PageUp" || e.key === "PageDown")) {
        e.preventDefault();
        const back = e.key === "[" || e.key === "PageUp";
        setPage((p) => Math.min(pages.length - 1, Math.max(0, p + (back ? -1 : 1))));
        return;
      }
      // Open the cursor's pal.
      if ((e.key === "Enter" || e.key === " ") && selectedKey) {
        const cur = navList.find((p) => palKey(p) === selectedKey);
        if (cur) {
          e.preventDefault();
          openPal(cur);
        }
        return;
      }
      const arrows: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: mode === "grid" ? -GRID_COLS : -1,
        ArrowDown: mode === "grid" ? GRID_COLS : 1,
      };
      if (!(e.key in arrows)) return;
      e.preventDefault();
      // Establish a cursor on first arrow if none is set yet.
      if (!selectedKey) {
        if (navList.length > 0) setSelectedKey(palKey(navList[0]));
        return;
      }
      const idx = navList.findIndex((p) => palKey(p) === selectedKey);
      if (idx === -1) return;
      const next = Math.min(navList.length - 1, Math.max(0, idx + arrows[e.key]));
      const key = palKey(navList[next]);
      setSelectedKey(key);
      requestAnimationFrame(() => {
        document.querySelector(`[data-pal="${key}"]`)?.scrollIntoView({ block: "nearest" });
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey, navList, mode, pages.length, openPal]);

  const surfaces = useMemo(() => {
    const s: BoxSurface[] = ["palbox"];
    if (containers.dimensional.length > 0) s.push("dimensional");
    if (containers.global.length > 0) s.push("global");
    if (containers.cage.length > 0) s.push("cage");
    return s;
  }, [containers]);

  return (
    <div className="flex h-full flex-col">
      {/* View header */}
      <header className="shrink-0 border-b border-line bg-panel/60 px-6 pb-3 pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
              Save Inspector
            </div>
            <h1 className="font-display text-xl font-bold tracking-wide text-ink">Palbox</h1>
          </div>
          {saveSummary && (
            <div className="flex items-center gap-4">
              <div className="text-right font-mono text-xs text-ink-dim">
                <span className="text-ink">{saveSummary.world_name}</span>
                <span className="mx-2 text-ink-faint">/</span>
                <span className="text-amber">{saveSummary.pals.length}</span> pals
              </div>
              {/* Mode toggle */}
              <div className="flex items-center overflow-hidden rounded-md border border-line">
                {(["grid", "list"] as PalboxMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                      mode === m
                        ? "bg-amber/15 text-amber"
                        : "bg-abyss text-ink-dim hover:bg-hover hover:text-ink"
                    }`}
                  >
                    {m === "grid" ? "Palbox" : "List"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {saveSummary && saveSummary.warnings.length > 0 && (
          <div className="mt-2 text-xs">
            <span
              className="text-warn"
              title={saveSummary.warnings.slice(0, 20).join("\n")}
            >
              {saveSummary.warnings.length} parser warnings
            </span>
          </div>
        )}
      </header>

      {/* Player tabs */}
      {saveSummary && players.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-b border-line bg-panel/40 px-6 pt-2">
          {players.map((p) => {
            const isActive = p.uid === activeUid;
            return (
              <button
                key={p.uid}
                onClick={() => setStoredPlayer(p.uid)}
                aria-pressed={isActive}
                className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
                  isActive
                    ? "border-amber font-medium text-ink"
                    : "border-transparent text-ink-dim hover:text-ink"
                }`}
              >
                {p.name || "Unnamed"}
              </button>
            );
          })}
        </div>
      )}

      {/* Shared sort / search / filter bar */}
      {saveSummary && <FilterBar query={query} onChange={patchQuery} shown={shown} total={pool.length} />}

      {/* Body */}
      {saveError && !saveSummary && (
        <div className="m-6 rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {saveError}
        </div>
      )}

      {saveSummary ? (
        <div className="relative flex flex-1 overflow-hidden">
          {mode === "grid" ? (
            <div className="flex-1 overflow-auto px-6 py-5">
              <div ref={contentRef} className="w-full">
                <div
                  className="mx-auto flex w-full flex-col gap-6"
                  style={{ maxWidth: composeWidth }}
                >
                {/* Surface toggle (Palbox / Dimensional / Global / Cages) */}
                {surfaces.length > 1 && (
                  <div className="flex items-center gap-1 self-start rounded-md border border-line p-0.5">
                    {surfaces.map((s) => (
                      <button
                        key={s}
                        onClick={() => setSurface(s)}
                        aria-pressed={surface === s}
                        className={`rounded px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                          surface === s
                            ? "bg-amber/15 text-amber"
                            : "text-ink-dim hover:bg-hover hover:text-ink"
                        }`}
                      >
                        {SURFACE_LABEL[s]}
                      </button>
                    ))}
                  </div>
                )}

                {/* Party rail (vertical, left) + the box grid filling the rest. */}
                <div className="flex items-start gap-6">
                  <PartyRail
                    slots={partyCells}
                    nameOf={nameOf}
                    selectedKey={selectedKey}
                    onSelect={openPal}
                    size={slotSize}
                  />
                  <div className="min-w-0 flex-1">
                    <BoxGrid
                      pages={pages}
                      page={safePage}
                      onPage={setPage}
                      pagerLabel={surface === "palbox" ? "Box" : "Page"}
                      nameOf={nameOf}
                      selectedKey={selectedKey}
                      onSelect={openPal}
                      size={slotSize}
                      onClear={active ? clearFilters : undefined}
                      emptyHint={
                        active
                          ? "No pals match your filters."
                          : surface === "palbox"
                            ? "This player has no boxed pals."
                            : `No ${SURFACE_LABEL[surface].toLowerCase()} pals.`
                      }
                    />
                  </div>
                </div>

                <BaseStrip
                  bases={visibleBases}
                  nameOf={nameOf}
                  selectedKey={selectedKey}
                  onSelect={openPal}
                  size={slotSize}
                />
                </div>
              </div>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-faint">
              <span>No pals match your filters.</span>
              {active && (
                <button
                  onClick={clearFilters}
                  className="rounded-md border border-line bg-raised px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <RosterTable
                rows={rows}
                nameOf={nameOf}
                sortKey={query.sortKey}
                sortDir={query.sortDir}
                onSort={(key) =>
                  patchQuery(
                    query.sortKey === key
                      ? { sortDir: query.sortDir === "asc" ? "desc" : "asc" }
                      : { sortKey: key, sortDir: "asc" },
                  )
                }
                selectedKey={selectedKey}
                onSelect={openPal}
              />
            </div>
          )}
        </div>
      ) : saveLoading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
          Loading save&hellip;
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="font-display text-lg text-ink-dim">No save loaded</div>
          <p className="max-w-xs text-sm text-ink-faint">
            Load a Palworld save from the sidebar to inspect every player&rsquo;s
            party, boxes, dimensional storage, and base pals.
          </p>
        </div>
      )}
    </div>
  );
}
