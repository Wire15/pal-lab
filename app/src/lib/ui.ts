// Presentation helpers shared across views: quality color bands, passive
// tiering, gender glyphs, duration/format. Pure functions returning Tailwind
// class fragments (defined against the tokens in index.css) or small data
// records, so components stay declarative and the color rules live in one place.

import type { ContainerKind, Gender } from "./types";

/** Compact human-readable duration: 2h05m, 9m30s, 45s, or the infinity glyph. */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs)) return "\u221e";
  const total = Math.round(secs);
  if (total <= 0) return "instant";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export interface GenderView {
  glyph: string;
  className: string;
  label: string;
}

/** Mars/Venus glyph + accent color; neutral dash for unresolved gender. */
export function genderView(gender: Gender | null): GenderView {
  if (gender === "Male")
    return { glyph: "\u2642", className: "text-el-water", label: "Male" };
  if (gender === "Female")
    return { glyph: "\u2640", className: "text-el-dragon", label: "Female" };
  return { glyph: "\u2015", className: "text-ink-faint", label: "Any" };
}

export type Quality = "good" | "fair" | "mid" | "low";

/** IV talent band (0-100). Thresholds mirror in-game "good roll" intuition. */
export function ivBand(v: number): Quality {
  if (v >= 90) return "good";
  if (v >= 70) return "fair";
  if (v >= 50) return "mid";
  return "low";
}

/** Text color for a quality band. */
export const QUALITY_TEXT: Record<Quality, string> = {
  good: "text-good",
  fair: "text-fair",
  mid: "text-ink-dim",
  low: "text-ink-faint",
};

/** Bar fill color for a quality band. */
export const QUALITY_FILL: Record<Quality, string> = {
  good: "bg-good",
  fair: "bg-fair",
  mid: "bg-ink-faint",
  low: "bg-bad/70",
};

/** Success-rate band for a breeding step probability (0-1). */
export function probBand(p: number): { text: string; ring: string; label: string } {
  const pct = p * 100;
  if (pct >= 75)
    return { text: "text-good", ring: "border-good/40 bg-good/10", label: "high" };
  if (pct >= 50)
    return { text: "text-fair", ring: "border-fair/40 bg-fair/10", label: "even" };
  if (pct >= 25)
    return { text: "text-warn", ring: "border-warn/40 bg-warn/10", label: "long" };
  return { text: "text-bad", ring: "border-bad/40 bg-bad/12", label: "rare" };
}

export type PassiveTone = "good" | "bad" | "special" | "neutral";

export interface PassiveView {
  label: string;
  tone: PassiveTone;
  tier: number; // 0 = no tier
  dir: "up" | "down" | null;
}

/** Tier -> roman numeral for passive rank badges. */
export const ROMAN = ["", "I", "II", "III", "IV", "V"];

/**
 * Parse a passive id into a display label, direction, tone, and rank tier.
 * Ids encode direction (up/down, any casing, with or without a separator:
 * "MoveSpeed_up_2", "CraftSpeed_down1", "PAL_Sanity_Up_1") and a rank digit.
 * "Rare"/"Legend" are prized specials; the rest are flavor traits. Localized
 * names live elsewhere but are absent in dev fixtures, so we humanize the id.
 */
export function passiveView(id: string): PassiveView {
  const raw = id.trim();
  if (raw === "(random)" || raw.toLowerCase() === "random")
    return { label: "random roll", tone: "neutral", tier: 0, dir: null };

  const dir: "up" | "down" | null = /_up/i.test(raw)
    ? "up"
    : /_down/i.test(raw)
      ? "down"
      : null;
  const tier = Number(raw.match(/[1-5]/)?.[0] ?? 0);

  let tone: PassiveTone = "neutral";
  if (/legend|rare|lucky|divine/i.test(raw)) tone = "special";
  else if (dir === "up") tone = "good";
  else if (dir === "down") tone = "bad";

  // Humanize: drop PAL_/`_PAL` affixes, up/down and rank tokens, split camelCase.
  const label = raw
    .replace(/^PAL_/i, "")
    .replace(/_PAL$/i, "")
    .split("_")
    .filter((t) => t && !/^\d+$/.test(t) && !/^(up|down)\d*$/i.test(t))
    .map((t) => t.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .join(" ")
    .trim();

  return { label: label || raw, tone, tier, dir };
}

export const PASSIVE_TONE: Record<PassiveTone, string> = {
  good: "border-good/35 bg-good/10 text-good",
  bad: "border-bad/35 bg-bad/10 text-bad",
  special: "border-amber/45 bg-amber/12 text-amber-bright",
  neutral: "border-line bg-raised text-ink-dim",
};

/** Short, human label for a container kind. */
export function containerLabel(kind: ContainerKind): string {
  switch (kind) {
    case "Palbox":
      return "Palbox";
    case "Party":
      return "Party";
    case "Base":
      return "Base";
    case "ViewingCage":
      return "Cage";
    case "GlobalPalStorage":
      return "Global";
    case "DimensionalPalStorage":
      return "Dimensional";
    default:
      return "Unknown";
  }
}
