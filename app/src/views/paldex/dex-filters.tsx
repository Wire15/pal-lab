// Deeper pal-dex filters (work suitability, rarity tier, guaranteed passive,
// nocturnal), collapsed behind a single FILTERS button + popover so the index
// toolbar stays legible at 1280. State + the pure predicate live here; the
// index view owns search/sort/element/owned and composes this AND-wise with
// them. Every value is a `--color-*` token (no hardcoded hex), matching the
// element-chip pattern and §2 rarity tints.

import { useEffect, useRef, useState } from "react";
import type { SpeciesEntry } from "../../lib/types";
import { rarityTier, type RarityTierName } from "../../lib/ui";
import { WORK_META, WorkGlyph } from "../../components/work-suit";
import { PassiveStrip } from "../../components/passive-strip";

/** Selected deeper filters. `work` maps a work kind → its minimum level (1-5);
 *  `rarities`/`passives` are OR sets; `nocturnal` is a flag. */
export interface DexFilterState {
  /** work kind (WORK_META.kind) → min level required (1-5), AND across keys. */
  work: Record<string, number>;
  /** rarity tier names, OR. */
  rarities: Set<RarityTierName>;
  /** guaranteed-passive display names, OR. */
  passives: Set<string>;
  /** only nocturnal species. */
  nocturnal: boolean;
}

export const EMPTY_DEX_FILTERS: DexFilterState = {
  work: {},
  rarities: new Set(),
  passives: new Set(),
  nocturnal: false,
};

/** Number of active deeper-filter selections (for the badge). */
export function dexFilterCount(f: DexFilterState): number {
  return (
    Object.keys(f.work).length + f.rarities.size + f.passives.size + (f.nocturnal ? 1 : 0)
  );
}

/** work kind → its index in the `work_suitability` array (static table). */
const WORK_INDEX: Record<string, number> = Object.fromEntries(
  WORK_META.map((m, i) => [m.kind, i]),
);

const WORK_MIN = 1;
const WORK_MAX = 5;

/** True when `s` passes every active deeper filter (groups ANDed; within work
 *  every chosen kind must clear its level; rarity/passive are OR within-group). */
export function matchesDexFilters(s: SpeciesEntry, f: DexFilterState): boolean {
  for (const [kind, min] of Object.entries(f.work)) {
    const i = WORK_INDEX[kind];
    if (i === undefined || (s.work_suitability[i] ?? 0) < min) return false;
  }
  if (f.rarities.size > 0 && !f.rarities.has(rarityTier(s.stats.rarity).name)) return false;
  if (f.passives.size > 0 && !s.guaranteed_passives.some((p) => f.passives.has(p.name)))
    return false;
  if (f.nocturnal && !s.nocturnal) return false;
  return true;
}

/** A guaranteed passive present somewhere in the dataset (filter option). */
export interface PassiveOption {
  id: string;
  name: string;
  rank: number;
}

const RARITY_TIERS: { name: RarityTierName; key: string }[] = [
  { name: "Common", key: "common" },
  { name: "Rare", key: "rare" },
  { name: "Epic", key: "epic" },
  { name: "Legendary", key: "legendary" },
];

const MOON = "\u263E";

function WorkStepper({
  kind,
  label,
  level,
  onSet,
}: {
  kind: string;
  label: string;
  level: number;
  onSet: (level: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-sm bg-abyss/60 px-1.5 py-1">
      <WorkGlyph kind={kind} size={15} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-dim">{label}</span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Decrease ${label} minimum level`}
          disabled={level <= WORK_MIN}
          onClick={() => onSet(Math.max(WORK_MIN, level - 1))}
          className="flex h-5 w-5 items-center justify-center rounded-xs border border-line bg-panel font-mono text-[13px] leading-none text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {"\u2212"}
        </button>
        <span className="w-8 text-center font-mono text-[11px] leading-none tabular-nums text-amber">
          Lv {level}
        </span>
        <button
          type="button"
          aria-label={`Increase ${label} minimum level`}
          disabled={level >= WORK_MAX}
          onClick={() => onSet(Math.min(WORK_MAX, level + 1))}
          className="flex h-5 w-5 items-center justify-center rounded-xs border border-line bg-panel font-mono text-[13px] leading-none text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          +
        </button>
      </span>
    </div>
  );
}

/** The FILTERS trigger button (with active-count badge) plus its popover panel
 *  holding the work / rarity / passive / nocturnal groups. Owns only the
 *  open/close + outside-click; the filter state is lifted to the index view. */
export function DexFilterButton({
  filters,
  onChange,
  passiveOptions,
}: {
  filters: DexFilterState;
  onChange: (next: DexFilterState) => void;
  passiveOptions: PassiveOption[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const count = dexFilterCount(filters);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleWork = (kind: string) => {
    const next = { ...filters.work };
    if (kind in next) delete next[kind];
    else next[kind] = WORK_MIN;
    onChange({ ...filters, work: next });
  };
  const setWorkLevel = (kind: string, level: number) =>
    onChange({ ...filters, work: { ...filters.work, [kind]: level } });

  const toggleRarity = (name: RarityTierName) => {
    const next = new Set(filters.rarities);
    next.has(name) ? next.delete(name) : next.add(name);
    onChange({ ...filters, rarities: next });
  };
  const togglePassive = (name: string) => {
    const next = new Set(filters.passives);
    next.has(name) ? next.delete(name) : next.add(name);
    onChange({ ...filters, passives: next });
  };

  const selectedWork = WORK_META.filter((m) => m.kind in filters.work);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex select-none items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
          count > 0 || open
            ? "border-amber/60 bg-amber/15 text-amber"
            : "border-line bg-panel text-ink-dim hover:bg-hover hover:text-ink"
        }`}
      >
        <span aria-hidden className="text-[12px] leading-none">
          {"\u25a4"}
        </span>
        Filters
        {count > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber px-1 font-mono text-[10px] font-semibold leading-none text-abyss tabular-nums">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Dex filters"
          className="absolute right-0 top-full z-50 mt-2 w-[344px] rounded-md border border-line bg-panel p-3 shadow-lg shadow-abyss/60 ring-1 ring-abyss/50"
        >
          {/* WORK */}
          <section>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                Work
              </span>
              {selectedWork.length > 1 && (
                <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                  all required
                </span>
              )}
            </div>
            <div className="grid grid-cols-6 gap-1">
              {WORK_META.map((m) => {
                const active = m.kind in filters.work;
                return (
                  <button
                    key={m.kind}
                    type="button"
                    onClick={() => toggleWork(m.kind)}
                    title={m.label}
                    aria-pressed={active}
                    className={`group flex items-center justify-center rounded-sm border p-1 transition-colors ${
                      active
                        ? "border-amber/70 bg-raised"
                        : "border-line/60 bg-abyss/50 hover:border-line hover:bg-hover"
                    }`}
                  >
                    <WorkGlyph
                      kind={m.kind}
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
            {selectedWork.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {selectedWork.map((m) => (
                  <WorkStepper
                    key={m.kind}
                    kind={m.kind}
                    label={m.label}
                    level={filters.work[m.kind]}
                    onSet={(lvl) => setWorkLevel(m.kind, lvl)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* RARITY */}
          <section className="mt-3 border-t border-line-soft pt-3">
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              Rarity
            </span>
            <div className="flex flex-wrap gap-1.5">
              {RARITY_TIERS.map((t) => {
                const active = filters.rarities.has(t.name);
                return (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => toggleRarity(t.name)}
                    aria-pressed={active}
                    style={
                      active
                        ? {
                            borderColor: `var(--color-rarity-${t.key})`,
                            color: `var(--color-rarity-${t.key})`,
                            backgroundColor: `color-mix(in srgb, var(--color-rarity-${t.key}) 16%, transparent)`,
                          }
                        : undefined
                    }
                    className={`rounded-sm border px-2 py-1 text-[12px] leading-none transition-colors ${
                      active
                        ? "font-medium"
                        : "border-line bg-abyss/50 text-ink-dim hover:bg-hover hover:text-ink"
                    }`}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </section>

          {/* PASSIVE */}
          {passiveOptions.length > 0 && (
            <section className="mt-3 border-t border-line-soft pt-3">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  Guaranteed passive
                </span>
                {filters.passives.size > 1 && (
                  <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                    any of
                  </span>
                )}
              </div>
              <div className="flex max-h-44 flex-col gap-1 overflow-auto pr-0.5">
                {passiveOptions.map((p) => {
                  const active = filters.passives.has(p.name);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => togglePassive(p.name)}
                      aria-pressed={active}
                      className={`rounded-sm p-0.5 text-left transition-colors ${
                        active ? "bg-amber/15 ring-1 ring-amber/60" : "hover:bg-hover/60"
                      }`}
                    >
                      <PassiveStrip id={p.id} size="sm" />
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* NIGHT */}
          <section className="mt-3 border-t border-line-soft pt-3">
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              Time
            </span>
            <button
              type="button"
              onClick={() => onChange({ ...filters, nocturnal: !filters.nocturnal })}
              aria-pressed={filters.nocturnal}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] leading-none transition-colors ${
                filters.nocturnal
                  ? "border-amber/60 bg-amber/15 text-amber"
                  : "border-line bg-abyss/50 text-ink-dim hover:bg-hover hover:text-ink"
              }`}
            >
              <span aria-hidden className="text-[13px] leading-none">
                {MOON}
              </span>
              Nocturnal only
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
