// Detail panel for a captured human NPC (merchant / hunter / villager). Humans
// are presentation-only — they carry no species, gender, or breeding role — so
// this card intentionally has NO species lookup, IVs, or Pal-dex link. It shows
// the frontend-owned humans.json profile (portrait, faction, work, stats) plus
// the live per-instance bits off the save (level, nickname, Alpha/bounty).
//
// Follows the app's modal pattern (see ScopeModal in App.tsx): a fixed backdrop
// that closes on mousedown, an inner dialog that stops propagation, and Escape
// to dismiss. Renders nothing when `pal` is null.

import { useEffect } from "react";
import type { OwnedPal } from "../lib/types";
import { getHuman, humanIconUrl } from "../lib/humans";
import { Tag } from "./primitives";
import { HumanGlyph } from "./palbox/slot";
import { WORK_META } from "./work-suit";
import { humanCardModel } from "./human-card-model";

/** work-suitability key -> display label, reusing the pal work-kind labels;
 *  falls back to the raw key for any human-only key not in the canonical set. */
const WORK_LABEL: Record<string, string> = Object.fromEntries(
  WORK_META.map((m) => [m.kind, m.label]),
);

/**
 * A framed human portrait: the real art when we have a profile, falling back to
 * the neutral silhouette glyph on a missing profile or a failed image load.
 * `size` is the pixel edge; `shape` picks the corner rounding (circular for the
 * card header, square-ish for roster rows to match {@link PalIcon}).
 */
export function HumanPortrait({
  id,
  size = 64,
  shape = "circle",
}: {
  id: string;
  size?: number;
  shape?: "circle" | "rounded";
}) {
  const info = getHuman(id);
  const round = shape === "circle" ? "rounded-full" : "rounded-md";
  return (
    <span
      className={`relative flex shrink-0 overflow-hidden bg-abyss/60 ring-1 ring-line/70 ${round}`}
      style={{ width: size, height: size }}
    >
      {info ? (
        <img
          src={humanIconUrl(info)}
          alt=""
          width={size}
          height={size}
          draggable={false}
          className="h-full w-full object-cover"
          onError={(e) => {
            // Swap to the silhouette without a re-render: hide the broken <img>
            // and reveal the sibling glyph underneath.
            (e.currentTarget as HTMLImageElement).style.display = "none";
            const glyph = e.currentTarget.nextElementSibling as HTMLElement | null;
            if (glyph) glyph.style.display = "flex";
          }}
        />
      ) : null}
      <span
        className="h-full w-full items-center justify-center"
        style={{ display: info ? "none" : "flex" }}
      >
        <HumanGlyph />
      </span>
    </span>
  );
}

/** One work-suitability row: label + a compact "Lv N" numeral (icon-free). */
function WorkRow({ kind, level }: { kind: string; level: number }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[13px] text-ink-dim">{WORK_LABEL[kind] ?? kind}</span>
      <span className="font-mono text-[12px] font-semibold tabular-nums text-amber">
        Lv {level}
      </span>
    </div>
  );
}

/** One stat cell (HP / ATK / DEF). */
function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      <span className="font-mono text-[15px] font-semibold tabular-nums text-ink">
        {value}
      </span>
    </div>
  );
}

/**
 * The captured-human detail card. Shown in place of the Pal-dex when a human
 * roster row / palbox slot is opened. `pal` is the clicked instance; `onClose`
 * dismisses the modal. Unknown ids (no humans.json profile) degrade to name =
 * raw CharacterID, faction "Unknown", and no stats/work sections.
 */
export function HumanCard({
  pal,
  onClose,
}: {
  pal: OwnedPal | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!pal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pal, onClose]);

  if (!pal) return null;

  const { info, name, faction, work } = humanCardModel(pal);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="human-card-title"
        className="w-full max-w-sm overflow-hidden rounded-lg border border-line bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header: portrait + name + faction + badges */}
        <div className="flex items-start gap-4 border-b border-line px-5 py-4">
          <HumanPortrait id={pal.character_id} size={64} />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
              Captured human
            </div>
            <h2
              id="human-card-title"
              className="mt-0.5 truncate font-display text-lg font-bold tracking-wide text-ink"
            >
              {name}
            </h2>
            <div className="mt-0.5 truncate text-[12px] text-ink-dim">{faction}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Tag>Lv {pal.level}</Tag>
              {info?.bounty && <Tag tone="amber">Bounty</Tag>}
              {info?.bounty && info.price != null && (
                <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                  {info.price.toLocaleString()}g
                </span>
              )}
              {pal.nickname && (
                <span className="truncate font-mono text-[11px] text-ink-faint">
                  &ldquo;{pal.nickname}&rdquo;
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Stats — omitted entirely for an unknown human (honest empty). */}
        {info && (
          <div className="grid grid-cols-3 gap-2 border-b border-line px-5 py-3">
            <StatCell label="HP" value={info.stats.hp} />
            <StatCell label="ATK" value={info.stats.attack} />
            <StatCell label="DEF" value={info.stats.defense} />
          </div>
        )}

        {/* Work suitability — nonzero rows only; omitted when none. */}
        {work.length > 0 && (
          <div className="px-5 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
              Work suitability
            </div>
            <div className="mt-1.5">
              {work.map(([kind, lv]) => (
                <WorkRow key={kind} kind={kind} level={lv} />
              ))}
            </div>
          </div>
        )}

        {/* Footer: the load-bearing reminder that humans never breed. */}
        <div className="border-t border-line bg-raised/40 px-5 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          Captured human — cannot breed
        </div>
      </div>
    </div>
  );
}
