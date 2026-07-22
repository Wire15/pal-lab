// Shared visual primitives built on the index.css token system. These are the
// reusable building blocks the design contract (UI-DESIGN.md) commits to; round
// 2 (pal-dex, breeding tree) composes the same set.

import { useState } from "react";
import { palIconUrl, UNKNOWN_ICON } from "../lib/assets";
import { PassiveStrip } from "./passive-strip";

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

/** A single passive. Thin alias of the in-game {@link PassiveStrip} (dense
 *  `sm` size) so every legacy callsite renders the new strip look. */
export function PassiveChip({ id }: { id: string }) {
  return <PassiveStrip id={id} size="sm" />;
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
