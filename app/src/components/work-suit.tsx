import { t, tr, useLocale } from "../i18n";
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
  { kind: "Kindling", get label() { return t("Kindling"); }, code: "KI" },
  { kind: "Watering", get label() { return t("Watering"); }, code: "WA" },
  { kind: "Planting", get label() { return t("Planting"); }, code: "PL" },
  { kind: "GenerateElectricity", get label() { return t("GenerateElectricity"); }, code: "EL" },
  { kind: "Handiwork", get label() { return t("Handiwork"); }, code: "HW" },
  { kind: "Gathering", get label() { return t("Gathering"); }, code: "GA" },
  { kind: "Lumbering", get label() { return t("Lumbering"); }, code: "LU" },
  { kind: "Mining", get label() { return t("Mining"); }, code: "MI" },
  { kind: "MedicineProduction", get label() { return t("Medicine"); }, code: "MD" },
  { kind: "Cooling", get label() { return t("Cooling"); }, code: "CO" },
  { kind: "Transporting", get label() { return t("Transporting"); }, code: "TR" },
  { kind: "Farming", get label() { return t("Farming"); }, code: "FA" },
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
  return WORK_META.map((m, i) => ({ kind: m.kind, code: m.code,
    get label() { return m.label; }, level: work[i] ?? 0 }))
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
  useLocale();
  const [failed, setFailed] = useState(false);
  const meta = WORK_META.find((m) => m.kind === kind);

  if (failed || !meta) {
    return (
      <span
        title={tr(meta?.label ?? kind)}
        aria-label={tr(meta?.label ?? kind)}
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
      alt={tr(meta.label)}
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
  useLocale();
  const items = nonzeroWork(work);
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((it) => (
        <span
          key={it.kind}
          title={t("{0} Lv {1}", [it.label, it.level])}
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
