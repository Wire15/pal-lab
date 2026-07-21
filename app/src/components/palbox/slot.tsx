// Circular game-style Palbox slot: a cel-shaded portrait clipped to a circle
// with a level pill, gender dot, alpha marker, condensation stars, and an amber
// selection ring. Empty slots render as a faint dashed circle (physical layout
// only). The occupied slot forwards `ref` + pointer handlers so it can be the
// direct trigger child of <PalHoverCard>.

import type { Ref, PointerEventHandler } from "react";
import type { OwnedPal } from "../../lib/types";
import { genderView } from "../../lib/ui";
import { palIconUrl, UNKNOWN_ICON } from "../../lib/assets";
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
  const src = !failed ? palIconUrl(pal.character_id) : UNKNOWN_ICON;

  return (
    <button
      ref={ref}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-pressed={selected}
      aria-label={`${name}, level ${pal.level}${pal.is_boss ? ", alpha" : ""}`}
      className="group relative shrink-0 rounded-full outline-none"
      style={{ width: size, height: size }}
    >
      {/* Portrait, clipped to a circle. */}
      <span
        className={`block h-full w-full overflow-hidden rounded-full bg-abyss/70 ring-1 transition-[box-shadow,transform] group-hover:-translate-y-0.5 ${
          selected
            ? "ring-2 ring-amber"
            : "ring-line/70 group-hover:ring-amber/50"
        }`}
      >
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
      </span>

      {/* Alpha marker — top-left. Amber (brand "special") to stay clear of the
          el-dragon female dot; distinct from the full amber ring by shape. */}
      {pal.is_boss && (
        <span
          title="Alpha"
          className="absolute -left-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-amber/50 bg-abyss text-[10px] leading-none text-amber"
        >
          {"\u2726"}
        </span>
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

      {/* Level pill — bottom-left. */}
      <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full border border-line bg-raised px-1.5 py-px font-mono text-[9px] font-semibold leading-none tabular-nums text-ink-dim">
        {pal.level}
      </span>

      {/* Gender dot — bottom-right. */}
      <span
        title={g.label}
        className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border border-abyss ${
          pal.gender === "Male"
            ? "bg-el-water"
            : pal.gender === "Female"
              ? "bg-el-dragon"
              : "bg-ink-faint"
        }`}
      />
    </button>
  );
}
