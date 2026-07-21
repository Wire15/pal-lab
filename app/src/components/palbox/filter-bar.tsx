// Shared sort / search / filter bar, applied to BOTH the grid and list modes
// (PALBOX-SORT-SPEC). Reproduces every real in-game Palbox sort (Slot order,
// Paldeck No., Level, Name, Rarity, Element, Alpha-first) and the name search,
// and exceeds the game with element / gender / alpha / passive filters. The
// "Expedition Power" sort is omitted deliberately (spec: not honestly derivable).

import { ElementIcon } from "../element";
import {
  ELEMENT_ORDER,
  type GenderFilter,
  type PalboxQuery,
  type SortKey,
} from "./selectors";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "slot", label: "Slot order" },
  { key: "paldex", label: "Paldeck No." },
  { key: "level", label: "Level" },
  { key: "name", label: "Name" },
  { key: "rarity", label: "Rarity" },
  { key: "element", label: "Element" },
  { key: "alpha", label: "Alpha-first" },
];

const GENDERS: { value: GenderFilter; glyph: string; label: string }[] = [
  { value: "any", glyph: "\u2015", label: "Any gender" },
  { value: "Male", glyph: "\u2642", label: "Male" },
  { value: "Female", glyph: "\u2640", label: "Female" },
];

export function FilterBar({
  query,
  onChange,
  shown,
  total,
}: {
  query: PalboxQuery;
  onChange: (patch: Partial<PalboxQuery>) => void;
  shown: number;
  total: number;
}) {
  const toggleElement = (el: string) => {
    const has = query.elements.includes(el);
    onChange({
      elements: has
        ? query.elements.filter((e) => e !== el)
        : [...query.elements, el],
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-raised/70 px-6 py-2.5">
      {/* Text search */}
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query.search}
          onChange={(e) => onChange({ search: e.currentTarget.value })}
          placeholder="Search name or nickname..."
          aria-label="Search pals by name"
          className="w-52 rounded-md border border-line bg-abyss px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
        />
        <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-ink-faint">
          <span className="text-amber">{shown}</span>
          <span className="mx-0.5">/</span>
          {total}
        </span>
      </div>

      {/* Sort key + direction */}
      <div className="flex items-center gap-1.5">
        <label className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          Sort
        </label>
        <select
          value={query.sortKey}
          onChange={(e) => onChange({ sortKey: e.currentTarget.value as SortKey })}
          aria-label="Sort by"
          className="rounded-md border border-line bg-abyss px-2 py-1.5 text-[13px] text-ink focus:border-amber/60"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => onChange({ sortDir: query.sortDir === "asc" ? "desc" : "asc" })}
          aria-label={`Sort ${query.sortDir === "asc" ? "ascending" : "descending"}`}
          title={query.sortDir === "asc" ? "Ascending" : "Descending"}
          className="rounded-md border border-line bg-abyss px-2 py-1.5 font-mono text-[12px] leading-none text-amber transition-colors hover:bg-hover"
        >
          {query.sortDir === "asc" ? "\u25b2" : "\u25bc"}
        </button>
      </div>

      {/* Element toggles */}
      <div className="flex items-center gap-1" role="group" aria-label="Filter by element">
        {ELEMENT_ORDER.map((el) => {
          const active = query.elements.includes(el);
          return (
            <button
              key={el}
              onClick={() => toggleElement(el)}
              aria-pressed={active}
              title={el}
              className={`group flex items-center rounded-md border p-0.5 transition-colors ${
                active
                  ? "border-amber/70 bg-raised"
                  : "border-transparent hover:bg-hover"
              }`}
            >
              <ElementIcon
                element={el}
                size={18}
                className={
                  active
                    ? ""
                    : "opacity-45 grayscale group-hover:opacity-90 group-hover:grayscale-0"
                }
              />
            </button>
          );
        })}
      </div>

      {/* Gender segmented control */}
      <div
        className="flex items-center overflow-hidden rounded-md border border-line"
        role="group"
        aria-label="Filter by gender"
      >
        {GENDERS.map((ggg) => {
          const active = query.gender === ggg.value;
          const tint =
            ggg.value === "Male"
              ? "text-el-water"
              : ggg.value === "Female"
                ? "text-el-dragon"
                : "text-ink-dim";
          return (
            <button
              key={ggg.value}
              onClick={() => onChange({ gender: ggg.value })}
              aria-pressed={active}
              title={ggg.label}
              className={`px-2 py-1.5 text-[13px] leading-none transition-colors ${
                active ? "bg-amber/15 text-amber" : `bg-abyss ${tint} hover:bg-hover`
              }`}
            >
              {ggg.glyph}
            </button>
          );
        })}
      </div>

      {/* Alpha-only */}
      <button
        onClick={() => onChange({ alphaOnly: !query.alphaOnly })}
        aria-pressed={query.alphaOnly}
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[12px] leading-none transition-colors ${
          query.alphaOnly
            ? "border-amber/60 bg-amber/15 text-amber"
            : "border-line bg-abyss text-ink-dim hover:bg-hover"
        }`}
      >
        <span aria-hidden>{"\u2726"}</span>
        Alpha
      </button>

      {/* Passive text filter */}
      <input
        type="search"
        value={query.passive}
        onChange={(e) => onChange({ passive: e.currentTarget.value })}
        placeholder="Passive..."
        aria-label="Filter by passive"
        className="w-32 rounded-md border border-line bg-abyss px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
      />
    </div>
  );
}
