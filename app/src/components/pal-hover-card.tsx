// A paldb-inspired species info tooltip in the Pal Calc theme. Hand-rolled
// positioning (fixed + measured, flips to stay in the viewport, no portal lib),
// opens after a short hover, never captures the pointer, and closes on
// leave/scroll. Wrap any single DOM-element trigger:
//
//   <PalHoverCard speciesId={id}><button>…</button></PalHoverCard>
//
// The species data is looked up from a module-cached `paldex_species` fetch, so
// the card is self-sufficient and can attach anywhere a species id is known.

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
import type { SpeciesEntry } from "../lib/types";
import { PalIcon } from "./primitives";
import { nonzeroWork, WorkGlyph } from "./work-suit";

const CARD_W = 268;
const OPEN_DELAY = 250;
const GAP = 10;
const MARGIN = 8;

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
  children,
}: {
  speciesId: string;
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

  // Measure once mounted, then position (and flip) against the anchor.
  useLayoutEffect(() => {
    if (!open || !entry) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (!anchor || !card) return;
    setPos(place(anchor, card.width, card.height));
  }, [open, entry]);

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

  return (
    <>
      {trigger}
      {open && entry && (
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
          }}
          className="overflow-hidden rounded-md border border-line bg-panel/95 text-left ring-1 ring-abyss/70"
        >
          <HoverCardBody entry={entry} />
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

function HoverCardBody({ entry }: { entry: SpeciesEntry }) {
  const work = nonzeroWork(entry.work_suitability);
  const twoCol = work.length > 6;
  const [minLv, maxLv] = entry.wild_levels;

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2.5">
        <PalIcon id={entry.id} name={entry.name} size={40} />
        <div className="min-w-0">
          <div className="truncate font-display text-[14px] font-semibold leading-tight text-ink">
            {entry.name}
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] leading-none tabular-nums">
            <span className="text-amber">#{String(entry.paldex_no).padStart(3, "0")}</span>
            <span className="text-ink-faint">Rarity {entry.stats.rarity}</span>
            {entry.is_variant && <span className="text-el-dragon">Variant</span>}
          </div>
        </div>
      </div>

      {/* Partner skill (omitted gracefully when the pack has none) */}
      {entry.partner_skill && (
        <div className="border-b border-line-soft px-3 py-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
            Partner skill
          </div>
          <div className="mt-1 text-[12px] leading-snug text-amber-bright">
            {entry.partner_skill}
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

      {/* Footer meta */}
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
    </>
  );
}
