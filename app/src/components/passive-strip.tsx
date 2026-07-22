// In-game passive-skill STRIP — the horizontal banner from Palworld's Pal Stats
// screen: bold name on the left, a stacked-chevron rank block on the right edge,
// a tier-colored border + dark fill. Positive passives read gold, negatives red
// (downward chevrons), and the two special lottery-pool tiers get their own
// treatment: `rainbow` (mutation pool) an iridescent green→blue→magenta→violet
// shimmer, `worldtree` a sacred green→violet duotone — mirroring how paldb.cc
// tints the game's rank-4/rank-5 banners.
//
// CONTRACT FILE: every surface imports { PassiveStrip } from here with the exact
// prop shape `({ id, size = "md" })`. This file owns the shared tint + chevron
// logic (also consumed by the passive-browser card); it must NOT import
// PassiveChip (primitives.tsx imports us — the reverse would cycle).

import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "../lib/tauri";
import type { PassiveEntry } from "../lib/types";
import { passiveView } from "../lib/ui";

// --- tier + band ------------------------------------------------------------

/** Special lottery-pool tier a passive may carry (from the pack; optional). */
export type PassiveTier = "rainbow" | "worldtree" | null | undefined;

/** Visual band a strip renders in. Positive/negative fall out of the signed
 *  rank; the two special tiers override coloring entirely. */
export type StripBand = "positive" | "negative" | "rainbow" | "worldtree";

/** Resolve the strip band: tier wins when present, else sign of the rank. */
export function stripBand(rank: number, tier?: PassiveTier): StripBand {
  if (tier === "worldtree") return "worldtree";
  if (tier === "rainbow") return "rainbow";
  return rank < 0 ? "negative" : "positive";
}

/** Banner surface (border + fill), name text color, and chevron accent per
 *  band. All colors are `--color-*` design tokens composed via `color-mix`
 *  (never a hardcoded hex); the tokens used — amber, bad, good, abyss, and the
 *  el-leaf/water/dragon/dark element accents — are all emitted as utilities
 *  elsewhere, so the raw `var()`s resolve. */
export interface StripTint {
  banner: CSSProperties;
  nameColor: string;
  accent: string;
}

const OVER_ABYSS = (token: string, pct: number) =>
  `color-mix(in srgb, var(${token}) ${pct}%, var(--color-abyss))`;

export function stripTint(band: StripBand): StripTint {
  switch (band) {
    case "negative":
      return {
        banner: {
          borderColor: "color-mix(in srgb, var(--color-bad) 50%, transparent)",
          background: `linear-gradient(90deg, ${OVER_ABYSS("--color-bad", 16)}, ${OVER_ABYSS("--color-bad", 5)})`,
        },
        nameColor: "var(--color-bad)",
        accent: "var(--color-bad)",
      };
    case "rainbow":
      return {
        banner: {
          borderColor: "color-mix(in srgb, var(--color-el-water) 60%, transparent)",
          background: `linear-gradient(100deg, ${OVER_ABYSS("--color-el-leaf", 30)}, ${OVER_ABYSS("--color-el-water", 32)}, ${OVER_ABYSS("--color-el-dragon", 32)}, ${OVER_ABYSS("--color-el-dark", 36)})`,
        },
        nameColor: "var(--color-ink)",
        accent: "var(--color-el-water)",
      };
    case "worldtree":
      return {
        banner: {
          borderColor: "color-mix(in srgb, var(--color-el-dark) 65%, var(--color-good))",
          background: `linear-gradient(100deg, ${OVER_ABYSS("--color-good", 26)}, ${OVER_ABYSS("--color-el-dark", 44)})`,
        },
        nameColor: "var(--color-ink)",
        accent: "var(--color-el-dark)",
      };
    default: // positive
      return {
        banner: {
          borderColor: "color-mix(in srgb, var(--color-amber) 52%, transparent)",
          background: `linear-gradient(90deg, ${OVER_ABYSS("--color-amber", 17)}, ${OVER_ABYSS("--color-amber", 6)})`,
        },
        nameColor: "var(--color-amber-bright)",
        accent: "var(--color-amber)",
      };
  }
}

// --- rank chevron block ------------------------------------------------------

/**
 * The stacked-chevron rank block on a strip's right edge: `min(|rank|, 5)`
 * thin chevrons, pointing up for positive tiers and down for negatives, drawn
 * in `currentColor` so the parent tints them. Vector-drawn (not the bundled
 * white rank PNGs, which read as flat blobs at strip scale and can't be tinted
 * per band). Rank 0 renders nothing.
 */
export function PassiveChevrons({
  rank,
  size = "md",
  className = "",
}: {
  rank: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const n = Math.min(Math.abs(rank), 5);
  if (n === 0) return null;
  const down = rank < 0;
  const w = size === "sm" ? 9 : 11;
  const stroke = size === "sm" ? 1.4 : 1.6;
  const arm = size === "sm" ? 3 : 3.6; // chevron rise
  const step = size === "sm" ? 3.4 : 4.2; // vertical advance per chevron
  const pad = stroke;
  const totalH = pad * 2 + arm + (n - 1) * step;
  const x0 = 0.6;
  const xMid = w / 2;
  const x1 = w - 0.6;
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const top = pad + i * step;
    const outer = down ? top : top + arm;
    const inner = down ? top + arm : top;
    paths.push(`M${x0} ${outer.toFixed(2)} L${xMid} ${inner.toFixed(2)} L${x1} ${outer.toFixed(2)}`);
  }
  return (
    <svg
      width={w}
      height={Number(totalH.toFixed(2))}
      viewBox={`0 0 ${w} ${totalH.toFixed(2)}`}
      className={`shrink-0 ${className}`}
      fill="none"
      aria-hidden="true"
    >
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

// --- cached passives payload -------------------------------------------------
// One shared `list_passives` fetch (module-level, deduped) backs every strip on
// screen, so the real localized name + signed rank + tier come from the pack
// rather than being re-parsed out of the id. Falls back to id-humanization
// (passiveView) before the fetch resolves or for ids the pack lacks.

type PassiveRow = PassiveEntry & { tier?: PassiveTier };
let passivesCache: Map<string, PassiveRow> | null = null;
let passivesPromise: Promise<Map<string, PassiveRow>> | null = null;

function loadPassives(): Promise<Map<string, PassiveRow>> {
  if (!passivesPromise) {
    passivesPromise = invoke<PassiveRow[]>("list_passives")
      .then((list) => {
        passivesCache = new Map(list.map((p) => [p.id, p]));
        return passivesCache;
      })
      .catch(() => {
        passivesCache = new Map();
        return passivesCache;
      });
  }
  return passivesPromise;
}

function usePassiveRow(id: string): PassiveRow | null {
  const [row, setRow] = useState<PassiveRow | null>(() => passivesCache?.get(id) ?? null);
  useEffect(() => {
    let live = true;
    loadPassives().then((m) => {
      if (live) setRow(m.get(id) ?? null);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return row;
}

/** Resolved name + signed rank + tier for a passive id — pack data when known,
 *  else id-humanized (label + rank derived from direction/tier). */
export function resolvePassive(
  id: string,
  row: PassiveRow | null,
): { name: string; rank: number; tier: PassiveTier } {
  if (row) return { name: row.name, rank: row.rank, tier: row.tier ?? null };
  const v = passiveView(id);
  const mag = v.tier || 1;
  const rank = v.dir === "down" ? -mag : mag;
  return { name: v.label, rank, tier: null };
}

// --- the strip ---------------------------------------------------------------

/**
 * A single passive rendered as the in-game strip. `md` for detail/browser
 * surfaces, `sm` for dense contexts (solver tree, hover card, the PassiveChip
 * alias). Name resolves from the cached pack payload; coloring from tier/rank.
 */
export function PassiveStrip({ id, size = "md" }: { id: string; size?: "sm" | "md" }) {
  const row = usePassiveRow(id);
  const { name, rank, tier } = resolvePassive(id, row);
  const tint = stripTint(stripBand(rank, tier));
  const sm = size === "sm";
  return (
    <span
      title={id}
      className={`inline-flex max-w-full min-w-0 items-center justify-between rounded-sm border font-semibold leading-tight ${
        sm ? "gap-1.5 px-2 py-0.5 text-[11px]" : "gap-2 px-2.5 py-1 text-[13px] tracking-wide"
      }`}
      style={{
        ...tint.banner,
        color: tint.nameColor,
        borderLeftWidth: sm ? 2 : 3,
      }}
    >
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0" style={{ color: tint.accent }}>
        <PassiveChevrons rank={rank} size={size} />
      </span>
    </span>
  );
}
