// Paldb-style passive-skill card: the in-game passive STRIP as the card header
// (name + stacked rank chevrons on a tier-colored banner) over structured
// effect lines and, when the pack carries one, the authored in-game
// description. Banner tint + chevrons are shared with PassiveStrip so the
// coloring rules live in one place; rainbow/worldtree passives read as special
// here too.

import type { PassiveEntry } from "../lib/types";
import { effectLabel, effectTarget, formatEffectValue } from "../lib/ui";
import { PassiveChevrons, stripBand, stripTint, type PassiveTier } from "./passive-strip";

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
 * A single passive skill as a paldb-style card. The header is the in-game strip
 * (tier/rank-colored banner: negative red, positive gold, rainbow iridescent,
 * world-tree green→violet); the body lists every effect and the authored
 * description when present.
 */
export function PassiveCard({ passive }: { passive: PassiveEntry }) {
  const tier = (passive as PassiveEntry & { tier?: PassiveTier }).tier;
  const tint = stripTint(stripBand(passive.rank, tier));
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-line bg-panel">
      <header
        className="flex items-center justify-between gap-2 border-b px-3 py-2"
        style={{ ...tint.banner, borderLeftWidth: 4 }}
      >
        <span
          className="min-w-0 truncate font-display text-[14px] font-semibold tracking-wide"
          style={{ color: tint.nameColor }}
        >
          {passive.name}
        </span>
        <span className="shrink-0" style={{ color: tint.accent }}>
          <PassiveChevrons rank={passive.rank} size="md" />
        </span>
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
