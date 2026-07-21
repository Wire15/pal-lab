// Shared visual primitives built on the index.css token system. These are the
// reusable building blocks the design contract (UI-DESIGN.md) commits to; round
// 2 (pal-dex, breeding tree) composes the same set.

import { useState } from "react";
import { palIconUrl, UNKNOWN_ICON } from "../lib/assets";
import { passiveView, PASSIVE_TONE, ROMAN } from "../lib/ui";

/** Cel-shaded pal portrait keyed by internal species id, with icon fallback. */
export function PalIcon({
  id,
  name,
  size = 32,
  className = "",
}: {
  id: string | null;
  name?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = id && !failed ? palIconUrl(id) : UNKNOWN_ICON;
  return (
    <img
      src={src}
      alt={name ?? id ?? "unknown pal"}
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md bg-abyss/60 object-contain ring-1 ring-line/70 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** A single passive as a tier-colored chip (green up / red down / gold rare). */
export function PassiveChip({ id }: { id: string }) {
  const { label, tone, tier, dir } = passiveView(id);
  return (
    <span
      title={id}
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] leading-none ${PASSIVE_TONE[tone]}`}
    >
      {dir && (
        <span className="text-[9px] leading-none opacity-90">
          {dir === "up" ? "\u25b2" : "\u25bc"}
        </span>
      )}
      <span className="max-w-[14ch] truncate">{label}</span>
      {tier > 0 && (
        <span className="font-mono text-[9px] font-semibold opacity-80">
          {ROMAN[tier] ?? tier}
        </span>
      )}
    </span>
  );
}

/** Neutral outline badge for categorical metadata (containers, cake, counts). */
export function Tag({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "amber" | "boss";
  className?: string;
}) {
  const tones = {
    neutral: "border-line bg-raised text-ink-dim",
    amber: "border-amber/40 bg-amber/10 text-amber",
    boss: "border-el-dragon/50 bg-el-dragon/12 text-el-dragon",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-none ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
