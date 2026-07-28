// Required-MOVES picker for the Solver. A search input that opens an anchored
// popover of active skills (waza) from `list_active_skills`, each row showing the
// element tile + name + faint INHERIT / FRUIT chips (from `can_inherit` /
// `has_skill_fruit`). Selected moves render as element-tinted chips with a remove
// ×, like the passive picker's chips. The popover is portaled to <body> so the
// Solver form column's overflow never clips it.
//
// The selected value is a `string[]` of stripped waza ids (e.g. "AirCanon",
// "Unique_SheepBall_Roll"), sent straight through as `SolveRequest.required_moves`.
// Sibling of components/passive-picker.tsx — same combobox/popover/chip anatomy,
// keyed by MOVE id + tinted by ELEMENT instead of passive rank.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadActiveSkills, humanizeWaza, type ActiveSkill } from "../lib/active-skills";
import { elementTokenKey } from "../lib/assets";
import { ElementIcon } from "./element";

/** One active skill paired with its stripped waza id (the map is keyed by id). */
interface MoveRow {
  id: string;
  skill: ActiveSkill;
}

/** Faint INHERIT / FRUIT chips — the pack's `can_inherit` / `has_skill_fruit`
 *  flags. The inherit RATE (~50%/egg) is community-measured, not code-verified. */
function MoveTags({ skill }: { skill: ActiveSkill }) {
  return (
    <>
      {skill.can_inherit && (
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wider text-ink-faint">
          Inherit
        </span>
      )}
      {skill.has_skill_fruit && (
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wider text-ink-faint">
          Fruit
        </span>
      )}
    </>
  );
}

/** A selected move as a compact element-tinted chip with an integrated remove ×. */
function MoveChipRemovable({
  row,
  value,
  onRemove,
}: {
  row: MoveRow | undefined;
  value: string;
  onRemove: (value: string) => void;
}) {
  const label = row?.skill.name ?? humanizeWaza(value);
  const key = row ? elementTokenKey(row.skill.element) : null;
  const accent = key ? `var(--color-el-${key})` : "var(--color-amber)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-raised py-0.5 pl-2 pr-1 text-[11px] font-semibold leading-tight text-ink"
      style={{ borderLeftWidth: 2, borderLeftColor: accent }}
      title={value}
    >
      {row && <ElementIcon element={row.skill.element} size={13} />}
      <span className="max-w-[13rem] truncate">{label}</span>
      <button
        type="button"
        className="ml-0.5 grid h-4 w-4 place-items-center rounded-sm text-ink-faint transition-colors hover:text-ink"
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

export function MovePicker({
  selected,
  onAdd,
  onRemove,
}: {
  /** Currently-selected move ids (stripped waza ids). */
  selected: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [entries, setEntries] = useState<MoveRow[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    loadActiveSkills()
      .then((map) =>
        setEntries(
          Object.entries(map)
            .map(([id, skill]) => ({ id, skill }))
            .sort((a, b) => a.skill.name.localeCompare(b.skill.name)),
        ),
      )
      .catch(() => {});
  }, []);

  // id → row, for coloring the selected chips.
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        !selectedSet.has(e.id) &&
        (!q || e.skill.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)),
    );
  }, [entries, selectedSet, query]);

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

  function add(e: MoveRow) {
    onAdd(e.id);
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
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
        Required moves
      </span>

      <div ref={anchorRef} className="relative">
        <input
          ref={inputRef}
          className="w-full min-w-0 rounded-md border border-line bg-abyss px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
          placeholder={"Search moves\u2026"}
          value={query}
          role="combobox"
          aria-expanded={open}
          aria-controls="move-picker-list"
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
            id="move-picker-list"
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
                  ? "Loading moves\u2026"
                  : query.trim()
                    ? `No moves match \u201c${query.trim()}\u201d`
                    : "All moves added"}
              </div>
            ) : (
              rows.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  title={e.id}
                  className={`flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left transition-colors ${
                    i === highlight ? "bg-hover" : "hover:bg-hover/60"
                  }`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => add(e)}
                >
                  <ElementIcon element={e.skill.element} size={16} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                    {e.skill.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <MoveTags skill={e.skill} />
                  </span>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}

      {selected.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {selected.map((value) => (
            <MoveChipRemovable
              key={value}
              value={value}
              row={byId.get(value)}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}
