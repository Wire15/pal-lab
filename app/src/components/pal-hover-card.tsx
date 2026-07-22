// A paldb-inspired pal info tooltip in the Pal Calc theme. Hand-rolled
// positioning (fixed + measured, flips to stay in the viewport, no portal lib),
// opens after a short hover, never captures the pointer, and closes on
// leave/scroll. Wrap any single DOM-element trigger:
//
//   <PalHoverCard speciesId={id}><button>…</button></PalHoverCard>
//
// Two variants share one card:
//   • species-only (dex cards, breeding cells) — pass just `speciesId`.
//   • owned-instance (palbox slots, party rail, base strips) — also pass the
//     `pal`, and the card grows a per-instance strip (level, gender, alpha,
//     condensation, IVs, passives, nickname) above the species sections.
//
// The species data is looked up from a module-cached `paldex_species` fetch, so
// the card is self-sufficient anywhere a species id is known; the instance data
// rides in directly on the optional `pal` prop.

import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "../lib/tauri";
import type { IvSet, OwnedPal, SpeciesEntry } from "../lib/types";
import { PalIcon, PassiveChip } from "./primitives";
import { nonzeroWork, WorkGlyph } from "./work-suit";
import { ElementBadges } from "./element";
import { PartnerIcon } from "./partner";
import { genderView, ivBand, QUALITY_TEXT, rarityTier, type RarityTier } from "../lib/ui";
import { alphaIconUrl } from "../lib/assets";

const CARD_W = 268;
const OPEN_DELAY = 250;
const GAP = 10;
const MARGIN = 8;

// Rarity tier -> text-color utility. Referencing the tokens through literal
// Tailwind classes (not a raw `var()`) is REQUIRED: Tailwind v4 only emits a
// `@theme` color var to `:root` when a generated utility uses it, so listing
// all four here both colors the tier label AND makes `var(--color-rarity-*)`
// resolve for the inline glow/text-shadow below.
const RARITY_TEXT: Record<RarityTier["tokenKey"], string> = {
  common: "text-rarity-common",
  rare: "text-rarity-rare",
  epic: "text-rarity-epic",
  legendary: "text-rarity-legendary",
};

// --- module-cached species lookup (one fetch, shared by every card) ----------

let speciesMapPromise: Promise<Map<string, SpeciesEntry>> | null = null;

function speciesMap(): Promise<Map<string, SpeciesEntry>> {
  if (!speciesMapPromise) {
    speciesMapPromise = invoke<SpeciesEntry[]>("paldex_species")
      .then((list) => new Map(list.map((s) => [s.id, s])))
      .catch((e) => {
        speciesMapPromise = null; // allow retry on the next hover
        throw e;
      });
  }
  return speciesMapPromise;
}

interface Point {
  left: number;
  top: number;
}

/** Place the card beside the anchor: right if it fits, else flipped left, then
 *  clamped into the viewport vertically. */
function place(anchor: DOMRect, w: number, h: number): Point {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.right + GAP;
  if (left + w > vw - MARGIN) {
    left = anchor.left - GAP - w;
    if (left < MARGIN) {
      left = Math.min(Math.max(MARGIN, anchor.left), vw - w - MARGIN);
    }
  }
  let top = anchor.top;
  if (top + h > vh - MARGIN) top = vh - h - MARGIN;
  if (top < MARGIN) top = MARGIN;
  return { left, top };
}

export function PalHoverCard({
  speciesId,
  pal,
  children,
}: {
  speciesId: string;
  /** When present, the card also renders this owned instance's data. */
  pal?: OwnedPal;
  children: ReactElement;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [entry, setEntry] = useState<SpeciesEntry | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Point | null>(null);

  const close = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setOpen(false);
    setPos(null);
  }, []);

  const scheduleOpen = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setOpen(true);
      speciesMap()
        .then((m) => {
          const e = m.get(speciesId);
          if (e) setEntry(e);
        })
        .catch(() => {});
    }, OPEN_DELAY);
  }, [speciesId]);

  // Measure once mounted, then position (and flip) against the anchor. Content
  // is ready as soon as we have either the species entry or the instance data.
  useLayoutEffect(() => {
    if (!open || !(entry || pal)) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (!anchor || !card) return;
    setPos(place(anchor, card.width, card.height));
  }, [open, entry, pal]);

  // A transient tooltip should not linger over stale layout: close on any
  // scroll (capture, to catch inner scrollers) or resize.
  useEffect(() => {
    if (!open) return;
    const onDismiss = () => close();
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [open, close]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const childProps = children.props as {
    onPointerEnter?: (e: ReactPointerEvent) => void;
    onPointerLeave?: (e: ReactPointerEvent) => void;
  };

  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: triggerRef,
    onPointerEnter: (e: ReactPointerEvent) => {
      childProps.onPointerEnter?.(e);
      scheduleOpen();
    },
    onPointerLeave: (e: ReactPointerEvent) => {
      childProps.onPointerLeave?.(e);
      close();
    },
  });

  // Rarity accent: Epic/Legendary species get a tinted ring + soft outer glow
  // in their token color, mirroring the game's rarity treatment. Common/Rare
  // keep the quiet default ring.
  const tier = entry ? rarityTier(entry.stats.rarity) : null;
  const prized = tier?.tokenKey === "epic" || tier?.tokenKey === "legendary";
  const glow = prized
    ? {
        boxShadow: `0 0 0 1px var(--color-rarity-${tier!.tokenKey}), 0 0 22px -6px var(--color-rarity-${tier!.tokenKey})`,
      }
    : undefined;

  return (
    <>
      {trigger}
      {open && (entry || pal) && (
        <div
          ref={cardRef}
          role="tooltip"
          style={{
            position: "fixed",
            left: pos ? pos.left : -9999,
            top: pos ? pos.top : -9999,
            width: CARD_W,
            pointerEvents: "none",
            zIndex: 60,
            visibility: pos ? "visible" : "hidden",
            ...glow,
          }}
          className={`overflow-hidden rounded-md border bg-panel/95 text-left ${
            prized ? "border-transparent" : "border-line ring-1 ring-abyss/70"
          }`}
        >
          <HoverCardBody entry={entry} pal={pal} tier={tier} />
        </div>
      )}
    </>
  );
}

/** Food-meter dots (filled amber up to `amount`, faint remainder) over 10. */
function FoodDots({ amount }: { amount: number }) {
  const n = Math.max(0, Math.min(10, amount));
  return (
    <span className="inline-flex items-center gap-[2px]" title={`Food ${amount}/10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          className={`h-[5px] w-[5px] rounded-full ${i < n ? "bg-amber" : "bg-line"}`}
        />
      ))}
    </span>
  );
}

function HoverCardBody({
  entry,
  pal,
  tier,
}: {
  entry: SpeciesEntry | null;
  pal?: OwnedPal;
  tier: RarityTier | null;
}) {
  const work = entry ? nonzeroWork(entry.work_suitability) : [];
  const twoCol = work.length > 6;
  const [minLv, maxLv] = entry?.wild_levels ?? [0, 0];
  const speciesName = entry?.name ?? pal?.character_id ?? "Unknown";
  const nickname = pal?.nickname?.trim() || null;
  const title = nickname ?? speciesName;
  const iconId = entry?.id ?? pal?.character_id ?? "";
  const g = pal ? genderView(pal.gender) : null;
  const rarityColor = tier ? `var(--color-rarity-${tier.tokenKey})` : undefined;
  const prized = tier?.tokenKey === "epic" || tier?.tokenKey === "legendary";

  return (
    <>
      {/* Header — nickname wins the title line, species name drops to a subtitle */}
      <div className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2.5">
        <PalIcon id={iconId} name={speciesName} size={40} />
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-display text-[14px] font-semibold leading-tight text-ink"
            style={prized ? { textShadow: `0 0 10px ${rarityColor}` } : undefined}
          >
            {title}
          </div>
          {nickname && (
            <div className="truncate text-[10px] leading-tight text-ink-faint">
              {speciesName}
            </div>
          )}
          {entry && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] leading-none tabular-nums">
              <span className="text-amber">
                #{String(entry.paldex_no).padStart(3, "0")}
              </span>
              {tier && (
                <span
                  className={`font-semibold uppercase tracking-wide ${RARITY_TEXT[tier.tokenKey]}`}
                >
                  {tier.name}
                </span>
              )}
              {entry.is_variant && <span className="text-el-dragon">Variant</span>}
            </div>
          )}
        </div>
        {entry && (
          <ElementBadges
            elements={entry.elements}
            size={16}
            className="ml-auto self-start"
          />
        )}
      </div>

      {/* Instance strip — owned pals only (level, gender, alpha, condensation,
          IVs, then passives). Absent for species-only (dex/breeding) cards. */}
      {pal && (
        <div className="space-y-2 border-b border-line-soft bg-abyss/30 px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] leading-none">
            <span className="rounded-full border border-line bg-raised px-2 py-1 font-semibold tabular-nums text-ink">
              Lv {pal.level}
            </span>
            {pal.gender && g && (
              <span className={`flex items-center gap-1 font-semibold ${g.className}`}>
                <span className="text-[12px] leading-none">{g.glyph}</span>
                {g.label}
              </span>
            )}
            {pal.is_boss && (
              <span className="flex items-center gap-1 font-semibold text-amber-bright">
                <img
                  src={alphaIconUrl}
                  alt=""
                  width={13}
                  height={13}
                  draggable={false}
                  className="h-[13px] w-[13px] object-contain"
                />
                Alpha
              </span>
            )}
            {pal.rank > 0 && (
              <span className="text-amber" title={`Condensation rank ${pal.rank}`}>
                {"\u2605"}
                {pal.rank}
              </span>
            )}
            <IvRow ivs={pal.ivs} />
          </div>
          {pal.passives.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pal.passives.map((p, i) => (
                <PassiveChip key={`${p}-${i}`} id={p} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Partner skill (omitted gracefully when the pack has none) */}
      {entry?.partner_skill && (
        <div className="border-b border-line-soft px-3 py-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
            Partner skill
          </div>
          <div className="mt-1 flex items-start gap-2">
            <PartnerIcon iconId={entry.partner_skill_icon} size={26} />
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-snug text-amber-bright">
                {entry.partner_skill}
              </div>
              {entry.partner_skill_desc && (
                <div className="mt-0.5 line-clamp-2 whitespace-pre-line text-[11px] leading-snug text-ink-dim">
                  {entry.partner_skill_desc}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Work suitability — nonzero only, two columns when dense */}
      {work.length > 0 && (
        <div className="px-3 py-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
            Work suitability
          </div>
          <div
            className={`mt-1.5 grid gap-x-4 gap-y-1 ${twoCol ? "grid-cols-2" : "grid-cols-1"}`}
          >
            {work.map((it) => (
              <div key={it.kind} className="flex items-center gap-1.5">
                <WorkGlyph kind={it.kind} size={16} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-dim">
                  {it.label}
                </span>
                <span className="font-mono text-[10px] font-semibold leading-none tabular-nums text-ink">
                  Lv{it.level}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer meta (species-level) */}
      {entry && (
        <div className="flex items-center justify-between gap-3 border-t border-line-soft bg-abyss/40 px-3 py-2 font-mono text-[10px] leading-none text-ink-faint">
          <span className="flex items-center gap-1.5">
            <span className="uppercase tracking-wider">Food</span>
            <FoodDots amount={entry.food_amount} />
          </span>
          <span className="flex items-center gap-3">
            {entry.nocturnal && (
              <span className="flex items-center gap-1 text-el-dark" title="Nocturnal">
                <span className="text-[12px] leading-none">{"\u263e"}</span>
                Nocturnal
              </span>
            )}
            {maxLv > 0 && (
              <span className="tabular-nums text-ink-dim">
                Lv {minLv}
                {"\u2013"}
                {maxLv}
              </span>
            )}
          </span>
        </div>
      )}
    </>
  );
}

/** Instance IV readout (talent 0-100), quality-colored; hidden when all zero. */
function IvRow({ ivs }: { ivs: IvSet }) {
  const stats: [string, number][] = [
    ["HP", ivs.hp],
    ["ATK", ivs.attack],
    ["DEF", ivs.defense],
  ];
  if (stats.every(([, v]) => v <= 0)) return null;
  return (
    <span className="ml-auto flex items-center gap-2" title="IVs (talent)">
      {stats.map(([label, v]) => (
        <span key={label} className="flex items-center gap-1">
          <span className="text-ink-faint">{label}</span>
          <span className={`font-semibold tabular-nums ${QUALITY_TEXT[ivBand(v)]}`}>
            {v}
          </span>
        </span>
      ))}
    </span>
  );
}
