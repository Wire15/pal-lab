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

/** Resolve the strip band. Sign wins first (any negative rank is a penalty),
 *  then the two special tiers — which the pack marks explicitly AND the rank
 *  magnitude implies: rank 4 is the rainbow (green→blue iridescent) pool, rank
 *  5 the World Tree (green→deep-purple) pool. Everything else is ordinary gold. */
export function stripBand(rank: number, tier?: PassiveTier): StripBand {
  if (rank < 0) return "negative";
  if (tier === "worldtree" || rank >= 5) return "worldtree";
  if (tier === "rainbow" || rank === 4) return "rainbow";
  return "positive";
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

/** The teal banner border both special tiers share — paldb's rgb(104,255,216),
 *  approximated from the ice+good tokens (no raw hex). */
const TEAL = "color-mix(in srgb, var(--color-el-ice) 58%, var(--color-good))";

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
      // rank-4 mutation pool. Ground truth (paldb): a bright teal border over a
      // GREEN→BLUE iridescent fill. Border teal ≈ rgb(104,255,216), mixed from
      // the ice+good tokens; fill sweeps good→ice→water over abyss.
      return {
        banner: {
          borderColor: TEAL,
          background: `linear-gradient(100deg, ${OVER_ABYSS("--color-good", 30)}, ${OVER_ABYSS("--color-el-ice", 34)}, ${OVER_ABYSS("--color-el-water", 34)})`,
        },
        nameColor: "var(--color-ink)",
        accent: "color-mix(in srgb, var(--color-el-ice) 65%, var(--color-ink))",
      };
    case "worldtree":
      // rank-5 World Tree pool. Same teal border, but a GREEN→DEEP-PURPLE fill
      // (good→el-dark over abyss). A pine glyph prefixes the chevron cluster.
      return {
        banner: {
          borderColor: TEAL,
          background: `linear-gradient(100deg, ${OVER_ABYSS("--color-good", 26)}, ${OVER_ABYSS("--color-el-dark", 48)})`,
        },
        nameColor: "var(--color-ink)",
        accent: "color-mix(in srgb, var(--color-el-dark) 45%, var(--color-ink))",
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
 * The stacked-chevron rank block: `min(|rank|, 3)` thin chevrons, pointing up
 * for positive tiers and down for negatives, drawn in `currentColor` so the
 * parent tints them. The game itself caps the chevron column at 3 and shows a
 * separate `+` marker for higher ranks (see {@link RankCluster}) — so we NEVER
 * draw 4–5 chevrons. Vector-drawn (not the bundled white rank PNGs, which read
 * as flat blobs at strip scale and can't be tinted per band). Rank 0 → nothing.
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
  const n = Math.min(Math.abs(rank), 3);
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

/** A small filled pine glyph in `currentColor`, prefixing the rank cluster on
 *  World Tree strips — mirrors paldb's [tree][chevrons] arrangement. */
function TreeGlyph({ size = "md" }: { size?: "sm" | "md" }) {
  const h = size === "sm" ? 11 : 13;
  const w = Math.round(h * (12 / 14));
  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 12 14"
      className="shrink-0"
      fill="currentColor"
      aria-hidden="true"
    >
      {/* three stacked canopy tiers + a short trunk */}
      <path d="M6 0.5 L9 4.4 H3 Z M6 3.3 L10 8 H2 Z M6 6.4 L10.6 11.4 H1.4 Z M5.1 11 H6.9 V13.6 H5.1 Z" />
    </svg>
  );
}

/** The `+` overflow marker in `currentColor`: shown when |rank| ≥ 4, where the
 *  game stops adding chevrons (capped at 3) and appends this instead. */
function PlusMark({ size = "md" }: { size?: "sm" | "md" }) {
  const s = size === "sm" ? 8 : 10;
  const stroke = size === "sm" ? 1.6 : 1.8;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 10 10"
      className="shrink-0"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 1.3 V8.7 M1.3 5 H8.7"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The right-edge rank cluster: an optional pine glyph (World Tree tier), the
 * `min(|rank|, 3)` chevron column, then a `+` marker when |rank| ≥ 4 — exactly
 * the game's anatomy. All in `currentColor`; the parent sets the tint.
 */
export function RankCluster({
  rank,
  band,
  size = "md",
  className = "",
}: {
  rank: number;
  band: StripBand;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center ${size === "sm" ? "gap-1" : "gap-1.5"} ${className}`}>
      {band === "worldtree" && <TreeGlyph size={size} />}
      <PassiveChevrons rank={rank} size={size} />
      {Math.abs(rank) >= 4 && <PlusMark size={size} />}
    </span>
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
 * A single passive as the in-game STRIP: a block-level, full-width horizontal
 * bar (clearly wider than tall, like Palworld's Pal Stats passive rows) with
 * the bold name pinned left and the rank cluster pinned right. `md` (~30px) for
 * detail/browser surfaces, `sm` (~22px) for dense contexts (solver tree, hover
 * card, roster, the PassiveChip alias). Callers lay strips out in a grid — this
 * strip fills its cell. Name resolves from the cached pack payload; coloring +
 * cluster anatomy from tier/rank.
 */
export function PassiveStrip({ id, size = "md" }: { id: string; size?: "sm" | "md" }) {
  const row = usePassiveRow(id);
  const { name, rank, tier } = resolvePassive(id, row);
  const band = stripBand(rank, tier);
  const tint = stripTint(band);
  const sm = size === "sm";
  return (
    <div
      title={id}
      className={`flex w-full min-w-0 items-center justify-between rounded-sm border font-semibold leading-tight ${
        sm ? "min-h-[22px] gap-2 px-2 text-[11px]" : "min-h-[30px] gap-2.5 px-3 text-[13px] tracking-wide"
      }`}
      style={{
        ...tint.banner,
        color: tint.nameColor,
        borderLeftWidth: sm ? 2 : 3,
      }}
    >
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0" style={{ color: tint.accent }}>
        <RankCluster rank={rank} band={band} size={size} />
      </span>
    </div>
  );
}
