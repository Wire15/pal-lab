// The Palbox surfaces: the party rail, the paged 6x5 box grid (shared by the
// physical-layout Palbox and the compact Dimensional Storage), and the base
// strip. All render the circular Slot primitive and open the shared detail
// panel via the lifted selection state. Every occupied slot is a PalHoverCard
// trigger (species-level info); per-instance data lives in the detail panel.

import type { OwnedPal } from "../../lib/types";
import { PalHoverCard } from "../pal-hover-card";
import { EmptySlot, Slot } from "./slot";
import {
  GRID_COLS,
  PARTY_SIZE,
  palKey,
  type BaseGroup,
  type GridCell,
} from "./selectors";

/** One occupied slot wrapped in its species hover card. */
function SlotCell({
  pal,
  name,
  selectedKey,
  onSelect,
  size,
}: {
  pal: OwnedPal;
  name: string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
  size?: number;
}) {
  const key = palKey(pal);
  return (
    <PalHoverCard speciesId={pal.character_id}>
      <Slot
        pal={pal}
        name={name}
        size={size}
        selected={key === selectedKey}
        onClick={() => onSelect(pal)}
      />
    </PalHoverCard>
  );
}

/** A 6-wide grid of cells (pals or empty slots), data-tagged for scroll-into. */
function PalGrid({
  cells,
  nameOf,
  selectedKey,
  onSelect,
}: {
  cells: GridCell[];
  nameOf: (pal: OwnedPal) => string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
}) {
  return (
    <div
      className="grid w-fit gap-3"
      style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
    >
      {cells.map((c, i) =>
        c.pal ? (
          <span key={palKey(c.pal)} data-pal={palKey(c.pal)}>
            <SlotCell
              pal={c.pal}
              name={nameOf(c.pal)}
              selectedKey={selectedKey}
              onSelect={onSelect}
            />
          </span>
        ) : (
          <EmptySlot key={`empty-${i}`} />
        ),
      )}
    </div>
  );
}

/** prev / "Label N / M" / next pager. Arrows disable at the ends. */
function Pager({
  label,
  page,
  total,
  onPage,
}: {
  label: string;
  page: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const arrow = "flex h-7 w-7 items-center justify-center rounded-md border border-line bg-abyss text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-abyss disabled:hover:text-ink-dim";
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => onPage(page - 1)}
        disabled={page <= 0}
        aria-label="Previous box"
        title="Previous ( [ )"
        className={arrow}
      >
        {"\u2039"}
      </button>
      <span className="min-w-[7.5rem] text-center font-mono text-[12px] uppercase tracking-wider text-ink-dim">
        {label} <span className="text-amber tabular-nums">{page + 1}</span>
        <span className="mx-1 text-ink-faint">/</span>
        <span className="tabular-nums">{total}</span>
      </span>
      <button
        onClick={() => onPage(page + 1)}
        disabled={page >= total - 1}
        aria-label="Next box"
        title="Next ( ] )"
        className={arrow}
      >
        {"\u203a"}
      </button>
    </div>
  );
}

/** Party rail: PARTY_SIZE fixed circular slots for the active player. */
export function PartyRail({
  slots,
  nameOf,
  selectedKey,
  onSelect,
}: {
  slots: (OwnedPal | null)[];
  nameOf: (pal: OwnedPal) => string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
}) {
  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        Party
      </div>
      <div className="flex gap-3">
        {slots.map((pal, i) =>
          pal ? (
            <span key={palKey(pal)} data-pal={palKey(pal)}>
              <SlotCell
                pal={pal}
                name={nameOf(pal)}
                size={64}
                selectedKey={selectedKey}
                onSelect={onSelect}
              />
            </span>
          ) : (
            <EmptySlot key={`party-${i}`} size={64} />
          ),
        )}
        {slots.length < PARTY_SIZE &&
          Array.from({ length: PARTY_SIZE - slots.length }, (_, i) => (
            <EmptySlot key={`pad-${i}`} size={64} />
          ))}
      </div>
    </div>
  );
}

/**
 * The paged box grid. `pages` is a list of PAGE_SIZE-cell arrays (physical
 * layout renders empty slots; compact/dimensional pages are gap-free). Shows a
 * "no matches" hint when a query hides everything.
 */
export function BoxGrid({
  pages,
  page,
  onPage,
  pagerLabel,
  nameOf,
  selectedKey,
  onSelect,
  emptyHint,
}: {
  pages: GridCell[][];
  page: number;
  onPage: (p: number) => void;
  pagerLabel: string;
  nameOf: (pal: OwnedPal) => string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
  emptyHint: string;
}) {
  if (pages.length === 0) {
    return (
      <div className="flex min-h-[20rem] items-center justify-center rounded-lg border border-line-soft bg-panel/40 text-sm text-ink-faint">
        {emptyHint}
      </div>
    );
  }
  const cells = pages[Math.min(page, pages.length - 1)] ?? [];
  return (
    <div className="flex flex-col items-center gap-4">
      <PalGrid
        cells={cells}
        nameOf={nameOf}
        selectedKey={selectedKey}
        onSelect={onSelect}
      />
      <Pager label={pagerLabel} page={page} total={pages.length} onPage={onPage} />
    </div>
  );
}

/** Base strip: all bases, one row each, player-independent. */
export function BaseStrip({
  bases,
  nameOf,
  selectedKey,
  onSelect,
}: {
  bases: BaseGroup[];
  nameOf: (pal: OwnedPal) => string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
}) {
  if (bases.length === 0) return null;
  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        Bases
      </div>
      <div className="flex flex-col gap-3">
        {bases.map((base) => (
          <div
            key={base.containerId}
            className="flex items-center gap-3 rounded-md border border-line-soft bg-panel/40 px-3 py-2"
          >
            <span className="w-16 shrink-0 font-mono text-[11px] uppercase tracking-wider text-ink-dim">
              {base.label}
            </span>
            <div className="flex flex-wrap gap-2.5">
              {base.pals.map((pal) => (
                <span key={palKey(pal)} data-pal={palKey(pal)}>
                  <SlotCell
                    pal={pal}
                    name={nameOf(pal)}
                    size={48}
                    selectedKey={selectedKey}
                    onSelect={onSelect}
                  />
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
