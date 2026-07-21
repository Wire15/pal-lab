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
  isHuman,
  type BaseGroup,
  type GridCell,
} from "./selectors";

/** One occupied slot wrapped in its hover card. Pals get the full species +
 *  instance card; captured humans have no species row, so they render bare
 *  (never a broken species lookup). */
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
  const slot = (
    <Slot
      pal={pal}
      name={name}
      size={size}
      selected={key === selectedKey}
      onClick={() => onSelect(pal)}
    />
  );
  if (isHuman(pal)) return slot;
  return (
    <PalHoverCard speciesId={pal.character_id} pal={pal}>
      {slot}
    </PalHoverCard>
  );
}

/** A GRID_COLS-wide grid of fluid cells (pals or empty slots), data-tagged for
 *  scroll-into. `size` is the measured, clamped slot edge; the gap scales with
 *  it so the grid keeps its rhythm from the smallest to the largest slot. */
function PalGrid({
  cells,
  nameOf,
  selectedKey,
  onSelect,
  size,
}: {
  cells: GridCell[];
  nameOf: (pal: OwnedPal) => string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
  size: number;
}) {
  const gap = 12;
  return (
    <div
      className="grid justify-start"
      style={{ gridTemplateColumns: `repeat(${GRID_COLS}, ${size}px)`, gap }}
    >
      {cells.map((c, i) =>
        c.pal ? (
          <span key={palKey(c.pal)} data-pal={palKey(c.pal)}>
            <SlotCell
              pal={c.pal}
              name={nameOf(c.pal)}
              size={size}
              selectedKey={selectedKey}
              onSelect={onSelect}
            />
          </span>
        ) : (
          <EmptySlot key={`empty-${i}`} size={size} />
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

/** Party rail: a vertical column of PARTY_SIZE fluid slots down the left of the
 *  box grid, mirroring the in-game palbox screen. */
export function PartyRail({
  slots,
  nameOf,
  selectedKey,
  onSelect,
  size,
}: {
  slots: (OwnedPal | null)[];
  nameOf: (pal: OwnedPal) => string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
  size: number;
}) {
  const gap = 12;
  const padCount = Math.max(0, PARTY_SIZE - slots.length);
  return (
    <div className="shrink-0">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        Party
      </div>
      <div className="flex flex-col" style={{ gap }}>
        {slots.map((pal, i) =>
          pal ? (
            <span key={palKey(pal)} data-pal={palKey(pal)}>
              <SlotCell
                pal={pal}
                name={nameOf(pal)}
                size={size}
                selectedKey={selectedKey}
                onSelect={onSelect}
              />
            </span>
          ) : (
            <EmptySlot key={`party-${i}`} size={size} />
          ),
        )}
        {Array.from({ length: padCount }, (_, i) => (
          <EmptySlot key={`pad-${i}`} size={size} />
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
  size,
}: {
  pages: GridCell[][];
  page: number;
  onPage: (p: number) => void;
  pagerLabel: string;
  nameOf: (pal: OwnedPal) => string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
  emptyHint: string;
  size: number;
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
    <div className="flex flex-col items-start gap-4">
      <PalGrid
        cells={cells}
        nameOf={nameOf}
        selectedKey={selectedKey}
        onSelect={onSelect}
        size={size}
      />
      <Pager label={pagerLabel} page={page} total={pages.length} onPage={onPage} />
    </div>
  );
}

/** Base strip: the selected player's guild bases, one row each. `size` follows
 *  the box grid; base slots stay a touch more compact so many pals fit a row. */
export function BaseStrip({
  bases,
  nameOf,
  selectedKey,
  onSelect,
  size,
}: {
  bases: BaseGroup[];
  nameOf: (pal: OwnedPal) => string;
  selectedKey: string | null;
  onSelect: (pal: OwnedPal) => void;
  size: number;
}) {
  if (bases.length === 0) return null;
  const baseSize = Math.max(44, Math.min(size, 56));
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
            <span className="w-28 shrink-0 truncate font-mono text-[11px] uppercase tracking-wider text-ink-dim" title={base.label}>
              {base.label}
            </span>
            <div className="flex flex-wrap gap-2.5">
              {base.pals.map((pal) => (
                <span key={palKey(pal)} data-pal={palKey(pal)}>
                  <SlotCell
                    pal={pal}
                    name={nameOf(pal)}
                    size={baseSize}
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
