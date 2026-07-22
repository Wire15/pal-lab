// Paldb-style passive-skill card: a rank-tinted banner (name + rank chevrons)
// over structured effect lines and, when the pack carries one, the authored
// in-game description. Tints and labels come from lib/ui.ts so the color rules
// live in one place; the rank chevron art is palcalc's (see vendor/NOTICE).

import { useState } from "react";
import type { PassiveEntry } from "../lib/types";
import { passiveRankIconUrl } from "../lib/assets";
import {
  effectLabel,
  effectTarget,
  formatEffectValue,
  rankBand,
  RANK_TINT,
} from "../lib/ui";

/** Rank chevrons: the bundled Positive/Negative glyph, or a CSS chevron stack
 *  fallback tinted by `currentColor` (the banner's rank tint). */
function PassiveRankIcon({ rank }: { rank: number }) {
  const [failed, setFailed] = useState(false);
  const url = passiveRankIconUrl(rank);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className="h-[18px] w-auto shrink-0"
      />
    );
  }
  const n = Math.min(Math.abs(rank), 5);
  const glyph = rank < 0 ? "\u25bc" : "\u25b2";
  return (
    <span className="shrink-0 text-[10px] leading-none tracking-[-0.15em]" aria-hidden="true">
      {glyph.repeat(Math.max(1, n))}
    </span>
  );
}

/** One structured effect line: humanized label, signed value, quiet scope. The
 *  value is neutral bright ink — the +/- sign carries direction and the rank
 *  banner carries good/bad valence, so a "lower is better" effect (e.g. SAN Loss
 *  -20% on a beneficial passive) never reads as a red penalty. */
function EffectLine({ type, value, target }: { type: string; value: number; target: string }) {
  const val = formatEffectValue(type, value);
  const scope = effectTarget(target);
  return (
    <div className="flex items-baseline gap-1.5 text-[12px] leading-snug">
      <span className="text-ink-dim">{effectLabel(type)}</span>
      {val && (
        <span className="font-mono font-medium tabular-nums text-ink">{val}</span>
      )}
      {scope && <span className="text-[10px] text-ink-faint">({scope})</span>}
    </div>
  );
}

/**
 * A single passive skill as a paldb-style card. The banner tint reads the rank
 * band (negative = danger red, 1-2 = cool silver, 3+ = gold); the body lists
 * every effect and the authored description when present.
 */
export function PassiveCard({ passive }: { passive: PassiveEntry }) {
  const band = rankBand(passive.rank);
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-md border border-line bg-panel ${RANK_TINT[band]}`}
    >
      <header
        className="flex items-center justify-between gap-2 border-b px-3 py-2"
        style={{
          background:
            "linear-gradient(90deg, color-mix(in srgb, currentColor 30%, transparent), color-mix(in srgb, currentColor 8%, transparent))",
          borderColor: "color-mix(in srgb, currentColor 42%, transparent)",
        }}
      >
        <span className="min-w-0 truncate font-display text-[14px] font-semibold tracking-wide text-ink">
          {passive.name}
        </span>
        <PassiveRankIcon rank={passive.rank} />
      </header>
      <div className="flex flex-1 flex-col gap-1 px-3 py-2.5">
        {passive.effects.length > 0 ? (
          passive.effects.map((e, i) => (
            <EffectLine key={i} type={e.type} value={e.value} target={e.target} />
          ))
        ) : (
          <div className="text-[12px] italic leading-snug text-ink-faint">No stat effects</div>
        )}
        {passive.description && (
          <p className="mt-1.5 whitespace-pre-line border-t border-line-soft pt-1.5 text-[11px] leading-relaxed text-ink-faint">
            {passive.description}
          </p>
        )}
      </div>
    </div>
  );
}
