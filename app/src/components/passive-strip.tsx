// In-game passive-skill STRIP — the horizontal banner from Palworld's Pal Stats
// screen: bold name on the left, the game's own rank-glyph texture (masked in
// currentColor) on the right edge, a tier-colored border + dark fill. Rank 1
// reads plain silver/white (like the game's lone chevron), ranks 2-3 gold,
// negatives red (downward chevrons), and the two special lottery-pool tiers get
// their own treatment: `rainbow` (mutation pool) an iridescent
// green→blue→magenta→violet shimmer, `worldtree` a sacred green→violet duotone —
// mirroring how paldb.cc tints the game's rank-4/rank-5 banners.
//
// CONTRACT FILE: every surface imports { PassiveStrip } from here with the exact
// prop shape `({ id, size = "md" })`. This file owns the shared tint + chevron
// logic (also consumed by the passive-browser card); it must NOT import
// PassiveChip (primitives.tsx imports us — the reverse would cycle).

import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "../lib/tauri";
import type { PassiveEntry } from "../lib/types";
import { passiveView } from "../lib/ui";
import { passiveRankGlyphUrl } from "../lib/assets";

// --- tier + band ------------------------------------------------------------

/** Special lottery-pool tier a passive may carry (from the pack; optional). */
export type PassiveTier = "rainbow" | "worldtree" | null | undefined;

/** Visual band a strip renders in. Positive/negative fall out of the signed
 *  rank; the two special tiers override coloring entirely. */
export type StripBand = "positive" | "neutral" | "negative" | "rainbow" | "worldtree";

/** Resolve the strip band. Sign wins first (any negative rank is a penalty),
 *  then the two special tiers — rank 4 the rainbow (green→blue iridescent) pool,
 *  rank 5 the World Tree (green→deep-purple) pool. Rank 1 is `neutral` (a plain
 *  silver/white chevron like the game — NOT gold); ranks 2-3 are ordinary gold. */
export function stripBand(rank: number, tier?: PassiveTier): StripBand {
  if (rank < 0) return "negative";
  if (tier === "worldtree" || rank >= 5) return "worldtree";
  if (tier === "rainbow" || rank === 4) return "rainbow";
  if (rank === 1) return "neutral";
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
    case "neutral":
      // rank-1 (single chevron). The game shows a plain WHITE chevron on a dark
      // banner — never gold. Silvery ink border over a barely-there cool fill,
      // off-white name, bright-ink glyph; distinct from the gold rank-2/3 tier.
      return {
        banner: {
          borderColor: "color-mix(in srgb, var(--color-ink-dim) 42%, transparent)",
          background: `linear-gradient(90deg, ${OVER_ABYSS("--color-ink-dim", 14)}, ${OVER_ABYSS("--color-ink-dim", 5)})`,
        },
        nameColor: "var(--color-ink)",
        accent: "color-mix(in srgb, var(--color-ink) 88%, var(--color-ink-dim))",
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

// --- rank glyph block --------------------------------------------------------

/**
 * The right-edge rank glyph: the GAME's own white-on-alpha rank texture
 * (Passive_Positive_1..5 / Passive_Negative_1..3, bundled under
 * `public/elements/`), painted as a CSS mask over `backgroundColor:
 * currentColor` so it tints with the band accent the parent sets — and reads
 * crisply at any size, unlike the flat white PNG dropped in directly. The 24px
 * source is a chevron stack capped at 3, with the `+` (rank 4) and star (rank 5)
 * fused in and negatives pointing down, so we draw ONE element, no extra marks.
 * Rank 0 → nothing.
 */
function RankGlyph({ rank, size = "md" }: { rank: number; size?: "sm" | "md" }) {
  if (rank === 0) return null;
  const px = size === "sm" ? 14 : 17;
  const url = passiveRankGlyphUrl(rank);
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0"
      style={{
        width: px,
        height: px,
        backgroundColor: "currentColor",
        WebkitMaskImage: `url(${url})`,
        maskImage: `url(${url})`,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
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

/**
 * The right-edge rank cluster: an optional pine glyph (World Tree tier) then the
 * masked rank texture — paldb's [tree][chevrons(+star)] arrangement. In
 * `currentColor`; the parent sets the tint.
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
      <RankGlyph rank={rank} size={size} />
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
  // When the shared payload is already cached (the common case once any strip
  // has loaded it), resolve synchronously and skip the effect entirely — a
  // passive-heavy list (the 637-row roster mounts ~2k strips) otherwise pays a
  // redundant promise + setState per strip on every mount.
  const cached = passivesCache?.get(id) ?? null;
  const [row, setRow] = useState<PassiveRow | null>(cached);
  useEffect(() => {
    if (passivesCache) return;
    let live = true;
    loadPassives().then((m) => {
      if (live) setRow(m.get(id) ?? null);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return passivesCache ? cached : row;
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
