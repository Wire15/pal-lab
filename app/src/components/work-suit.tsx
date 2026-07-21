// Work-suitability rendering: the 12 kinds in canonical order (matching
// pal_data::gamedata::WORK_KINDS and the SpeciesEntry.work_suitability array),
// the bundled palcalc glyphs in /public/work, and the compact card/tooltip
// pieces that consume them. Icons fall back to a mono two-letter code chip
// (never an emoji) if a glyph fails to load.

import { useState } from "react";

/** One work kind: its pack key, display label, and 2-letter fallback code. */
interface WorkMeta {
  kind: string;
  label: string;
  code: string;
}

/**
 * Canonical order — MUST match `pal_data::gamedata::WORK_KINDS` and the order
 * of the `work_suitability` array served by `paldex_species`.
 */
export const WORK_META: WorkMeta[] = [
  { kind: "Kindling", label: "Kindling", code: "KI" },
  { kind: "Watering", label: "Watering", code: "WA" },
  { kind: "Planting", label: "Planting", code: "PL" },
  { kind: "GenerateElectricity", label: "Electricity", code: "EL" },
  { kind: "Handiwork", label: "Handiwork", code: "HW" },
  { kind: "Gathering", label: "Gathering", code: "GA" },
  { kind: "Lumbering", label: "Lumbering", code: "LU" },
  { kind: "Mining", label: "Mining", code: "MI" },
  { kind: "MedicineProduction", label: "Medicine", code: "MD" },
  { kind: "Cooling", label: "Cooling", code: "CO" },
  { kind: "Transporting", label: "Transporting", code: "TR" },
  { kind: "Farming", label: "Farming", code: "FA" },
];

/** Bundled work-suitability glyph URL (palcalc art; see vendor/NOTICE). */
export function workIconUrl(kind: string): string {
  return `/work/${kind}.png`;
}

/** A nonzero work suitability, resolved for display. */
export interface WorkLevel extends WorkMeta {
  level: number;
}

/**
 * Nonzero work suitabilities from a `work_suitability` array (12 ints in
 * canonical order), highest level first, ties keeping canonical order.
 */
export function nonzeroWork(work: number[] | undefined): WorkLevel[] {
  if (!work) return [];
  return WORK_META.map((m, i) => ({ ...m, level: work[i] ?? 0 }))
    .filter((w) => w.level > 0)
    .sort((a, b) => b.level - a.level);
}

/**
 * A single work glyph. Loads the bundled icon; on error (or unknown kind) it
 * degrades to a tinted mono two-letter code chip so the row still reads.
 */
export function WorkGlyph({
  kind,
  size = 16,
  className = "",
}: {
  kind: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const meta = WORK_META.find((m) => m.kind === kind);

  if (failed || !meta) {
    return (
      <span
        title={meta?.label ?? kind}
        aria-label={meta?.label ?? kind}
        className={`inline-flex shrink-0 items-center justify-center rounded-xs bg-raised font-mono font-semibold leading-none text-ink-dim ${className}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      >
        {meta?.code ?? "??"}
      </span>
    );
  }
  return (
    <img
      src={workIconUrl(kind)}
      alt={meta.label}
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={`shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Dex-card work badges: up to `max` nonzero suitabilities (glyph + level) as
 * compact chips, with a faint `+n` when more exist. Renders nothing when the
 * species has no work suitability. Deliberately dense but capped so the card
 * face stays scannable.
 */
export function CardWorkBadges({
  work,
  max = 4,
}: {
  work: number[] | undefined;
  max?: number;
}) {
  const items = nonzeroWork(work);
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((it) => (
        <span
          key={it.kind}
          title={`${it.label} Lv ${it.level}`}
          className="inline-flex items-center gap-0.5 rounded-sm bg-abyss/70 px-1 py-0.5"
        >
          <WorkGlyph kind={it.kind} size={13} />
          <span className="font-mono text-[9px] font-semibold leading-none tabular-nums text-ink-dim">
            {it.level}
          </span>
        </span>
      ))}
      {extra > 0 && (
        <span className="font-mono text-[9px] leading-none tabular-nums text-ink-faint">
          +{extra}
        </span>
      )}
    </div>
  );
}
