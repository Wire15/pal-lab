// Required-passives picker for the Solver. A search input that opens an
// anchored popover of **pal-facing** passives (the only ones a pal can roll),
// each rendered in its in-game STRIP band so rarity reads at a glance — the
// exact tint/chevron rules PassiveStrip owns, reused here (rows) and in the
// selected chips (compact band pill + remove ×). The popover is portaled to
// <body> so the Solver form column's overflow never clips it.
//
// The selected value is a `string[]` keyed by `valueMode`: passive NAMES
// (default — the Solver/IV Lab freeze it and send it straight through as
// `required_passives`) or passive IDs (`valueMode="id"`, the Palbox filter,
// which AND-matches ids against a pal's `passives`). Either way the picker maps
// value↔entry off the `list_passives` payload for coloring.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../lib/tauri";
import type { PassiveEntry } from "../lib/types";
import { effectLabel, formatEffectValue } from "../lib/ui";
import {
  PassiveStrip,
  RankCluster,
  stripBand,
  stripTint,
  type PassiveTier,
} from "./passive-strip";

type PassiveRow = PassiveEntry & { tier?: PassiveTier };

/** Sort weight so the two special lottery tiers and high ranks float to the
 *  top, penalties sink; ties break alphabetically. Mirrors the browser's
 *  strongest-first ordering while guaranteeing worldtree > rainbow > gold. */
function sortWeight(p: PassiveRow): number {
  if (p.tier === "worldtree") return 100;
  if (p.tier === "rainbow") return 99;
  return p.rank;
}

/** One-line, dim effect gloss under a row: humanized effect labels + signed
 *  values (or the first description line for flag-only passives). */
function effectSummary(p: PassiveRow): string {
  if (p.effects.length > 0) {
    return p.effects
      .map((e) => {
        const v = formatEffectValue(e.type, e.value);
        return v ? `${effectLabel(e.type)} ${v}` : effectLabel(e.type);
      })
      .join(" \u00b7 ");
  }
  return p.description?.split("\n")[0]?.trim() ?? "";
}

/** A selected passive as a compact band-tinted chip with an integrated remove
 *  ×. Same tint tokens + rank cluster as the strip, sized for a chip row. */
function PassiveChipRemovable({
  row,
  value,
  onRemove,
}: {
  row: PassiveRow | undefined;
  /** The selected key (name or id, per the picker's valueMode). */
  value: string;
  onRemove: (value: string) => void;
}) {
  const rank = row?.rank ?? 1;
  const band = stripBand(rank, row?.tier);
  const tint = stripTint(band);
  const label = row?.name ?? value;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm border py-0.5 pl-2 pr-1 text-[11px] font-semibold leading-tight"
      style={{ ...tint.banner, color: tint.nameColor, borderLeftWidth: 2 }}
      title={row?.id ?? value}
    >
      <span className="max-w-[13rem] truncate">{label}</span>
      <span style={{ color: tint.accent }}>
        <RankCluster rank={rank} band={band} size="sm" />
      </span>
      <button
        type="button"
        className="ml-0.5 grid h-4 w-4 place-items-center rounded-sm text-current opacity-60 transition-opacity hover:opacity-100"
        onClick={() => onRemove(value)}
        aria-label={`Remove ${label}`}
      >
        &times;
      </button>
    </span>
  );
}

interface PopoverPos {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

export function PassivePicker({
  selected,
  onAdd,
  onRemove,
  label = "Required passives",
  placeholder = "Search passives\u2026",
  valueMode = "name",
}: {
  /** Currently-selected passive keys (NAMES by default, IDs when valueMode="id"). */
  selected: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  /** Field caption; falsy hides it (the Palbox toolbar wants no stacked label). */
  label?: string;
  placeholder?: string;
  /** What each selected value is keyed on: "name" (Solver contract) or "id". */
  valueMode?: "name" | "id";
}) {
  const [entries, setEntries] = useState<PassiveRow[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    invoke<PassiveRow[]>("list_passives").then(setEntries).catch(() => {});
  }, []);

  // value key → entry, for coloring the selected chips.
  const byKey = useMemo(
    () => new Map(entries.map((e) => [valueMode === "id" ? e.id : e.name, e])),
    [entries, valueMode],
  );

  // Pal-facing only, tier/high-rank first, then alphabetical. Base list is
  // stable; query + selected filter it per keystroke.
  const palFacing = useMemo(
    () =>
      entries
        .filter((p) => p.pal_facing)
        .sort((a, b) => sortWeight(b) - sortWeight(a) || a.name.localeCompare(b.name)),
    [entries],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return palFacing.filter(
      (p) =>
        !selectedSet.has(valueMode === "id" ? p.id : p.name) &&
        (!q || p.name.toLowerCase().includes(q)),
    );
  }, [palFacing, selectedSet, query, valueMode]);

  // Keep the highlight in-bounds as the list shrinks/grows.
  useEffect(() => {
    setHighlight((h) => (rows.length === 0 ? 0 : Math.min(h, rows.length - 1)));
  }, [rows.length]);

  // --- popover positioning (portaled to body; escapes the form's overflow) ---
  const reposition = () => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    const spaceBelow = window.innerHeight - r.bottom - gap;
    const spaceAbove = r.top - gap;
    const above = spaceBelow < 200 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, Math.min(380, (above ? spaceAbove : spaceBelow) - 8));
    setPos({ left: r.left, top: above ? r.top - gap : r.bottom + gap, width: r.width, maxHeight, above });
  };

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Outside-click closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Scroll the highlighted row into view as it moves.
  useEffect(() => {
    if (!open) return;
    rowRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function add(p: PassiveRow) {
    onAdd(valueMode === "id" ? p.id : p.name);
    setQuery("");
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlight((h) => Math.min(h + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = rows[highlight];
      if (pick) add(pick);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {label}
        </span>
      )}

      <div ref={anchorRef} className="relative">
        <input
          ref={inputRef}
          className="w-full min-w-0 rounded-md border border-line bg-abyss px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
          placeholder={placeholder}
          value={query}
          role="combobox"
          aria-expanded={open}
          aria-controls="passive-picker-list"
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setHighlight(0);
            if (!open) setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            id="passive-picker-list"
            role="listbox"
            className="overflow-auto rounded-md border border-line bg-panel/98 p-1 shadow-lg shadow-abyss/60 ring-1 ring-abyss/60 backdrop-blur-sm"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              width: pos.width,
              maxHeight: pos.maxHeight,
              transform: pos.above ? "translateY(-100%)" : undefined,
              zIndex: 70,
            }}
          >
            {rows.length === 0 ? (
              <div className="px-2 py-3 text-center text-[12px] text-ink-faint">
                {entries.length === 0
                  ? "Loading passives\u2026"
                  : query.trim()
                    ? `No passives match \u201c${query.trim()}\u201d`
                    : "All pal passives added"}
              </div>
            ) : (
              rows.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  className={`flex w-full flex-col gap-0.5 rounded-sm px-1 py-1 text-left transition-colors ${
                    i === highlight ? "bg-hover" : "hover:bg-hover/60"
                  }`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => add(p)}
                >
                  <PassiveStrip id={p.id} size="sm" />
                  {effectSummary(p) && (
                    <span className="truncate px-0.5 text-[10.5px] leading-tight text-ink-faint">
                      {effectSummary(p)}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>,
          document.body,
        )}

      {selected.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {selected.map((value) => (
            <PassiveChipRemovable
              key={value}
              value={value}
              row={byKey.get(value)}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}
