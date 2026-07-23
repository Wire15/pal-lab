// Circular game-style Palbox slot: a cel-shaded portrait clipped to a circle
// with a level pill, gender dot, alpha marker, condensation stars, and an amber
// selection ring. Empty slots render as a faint dashed circle (physical layout
// only). The occupied slot forwards `ref` + pointer handlers so it can be the
// direct trigger child of <PalHoverCard>.

import type { Ref, PointerEventHandler } from "react";
import { isAlpha, type OwnedPal } from "../../lib/types";
import { genderView } from "../../lib/ui";
import { alphaIconUrl, palIconUrl, UNKNOWN_ICON } from "../../lib/assets";
import { isHuman } from "./selectors";
import { useState } from "react";

/** An empty slot: faint dashed circle, non-interactive. */
export function EmptySlot({ size = 60 }: { size?: number }) {
  return (
    <div
      aria-hidden
      className="rounded-full border border-dashed border-line-soft bg-abyss/30"
      style={{ width: size, height: size }}
    />
  );
}

/** Neutral humanoid silhouette for a captured human entity (not a pal). */
function HumanGlyph() {
  return (
    <span className="flex h-full w-full items-center justify-center text-ink-faint">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-[52%] w-[52%]">
        <circle cx="12" cy="7.5" r="4.2" />
        <path d="M12 13.5c-4.4 0-8 2.9-8 6.5v.5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-.5c0-3.6-3.6-6.5-8-6.5z" />
      </svg>
    </span>
  );
}

export interface SlotProps {
  pal: OwnedPal;
  name: string;
  selected?: boolean;
  size?: number;
  onClick?: () => void;
  ref?: Ref<HTMLButtonElement>;
  onPointerEnter?: PointerEventHandler<HTMLButtonElement>;
  onPointerLeave?: PointerEventHandler<HTMLButtonElement>;
}

export function Slot({
  pal,
  name,
  selected = false,
  size = 60,
  onClick,
  ref,
  onPointerEnter,
  onPointerLeave,
}: SlotProps) {
  const [failed, setFailed] = useState(false);
  const g = genderView(pal.gender);
  const human = isHuman(pal);
  const src = !failed ? palIconUrl(pal.character_id) : UNKNOWN_ICON;

  // Badges scale with the fluid slot so glyphs stay legible from ~56px to ~96px.
  const genderBadge = Math.max(15, Math.round(size * 0.3));
  const genderFont = Math.max(10, Math.round(size * 0.22));

  return (
    <button
      ref={ref}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-pressed={selected}
      aria-label={`${human ? "Human" : name}, level ${pal.level}${isAlpha(pal) ? ", alpha" : ""}`}
      className="group relative shrink-0 rounded-full"
      style={{ width: size, height: size }}
    >
      {/* Portrait, clipped to a circle. Captured humans render as a muted neutral
          silhouette (intentional) — distinct from the '?' unknown-pal fallback. */}
      <span
        className={`block h-full w-full overflow-hidden rounded-full ring-1 transition-[box-shadow,transform] group-hover:-translate-y-0.5 ${
          human ? "bg-abyss/50" : "bg-abyss/70"
        } ${
          selected
            ? "ring-2 ring-amber"
            : human
              ? "ring-line-soft group-hover:ring-amber/40"
              : "ring-line/70 group-hover:ring-amber/50"
        }`}
      >
        {human ? (
          <HumanGlyph />
        ) : (
          <img
            src={src}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
            className="h-full w-full object-contain"
          />
        )}
      </span>

      {/* Alpha marker — top-left. Real in-game horned-alpha badge (GameAssets),
          transparent PNG dropped onto the slot corner. */}
      {isAlpha(pal) && (
        <img
          src={alphaIconUrl}
          alt=""
          title="Alpha"
          draggable={false}
          className="absolute -left-1 -top-1 h-[30%] max-h-6 min-h-4 w-[30%] max-w-6 min-w-4 object-contain drop-shadow"
        />
      )}

      {/* Condensation stars — top-right. */}
      {pal.rank > 0 && (
        <span
          title={`Condensation rank ${pal.rank}`}
          className="absolute -right-1 -top-1 rounded-full border border-line bg-abyss px-1 py-px font-mono text-[9px] font-semibold leading-none text-amber"
        >
          {"\u2605"}
          {pal.rank}
        </span>
      )}

      {/* Level pill — bottom-center. */}
      <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full border border-line bg-raised px-1.5 py-px font-mono text-[9px] font-semibold leading-none tabular-nums text-ink-dim">
        {pal.level}
      </span>

      {/* Gender glyph badge — bottom-right. Colored Mars/Venus glyph on a dark
          circular chip for contrast; omitted for genderless entities. */}
      {pal.gender && (
        <span
          title={g.label}
          style={{ width: genderBadge, height: genderBadge, fontSize: genderFont }}
          className={`absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border border-abyss bg-raised font-semibold leading-none ${g.className}`}
        >
          {g.glyph}
        </span>
      )}
    </button>
  );
}
