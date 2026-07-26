// The "what must this child be" briefing for a BRED pal node in the plan graph.
// The junction chip's BreedHoverCard already covers HOW likely a step is (odds,
// eggs, IV gate, parent pool); this card is the complement — it opens off the
// bred CIRCLE and states only WHAT this child has to carry forward for the rest
// of the chain to work: the passives it must inherit, the gender it must hatch,
// and the inherited-IV floor. It also flags same-species steps (the child's
// species matches a parent's) as gender/passive consolidation.
//
// Positioning machinery mirrors BreedHoverCard / PalHoverCard verbatim — a
// measured `position: fixed` card PORTALED to document.body (to escape the
// plan-graph translate+scale containing block), viewport-edge flipping, 250ms
// open delay, keyboard focus/blur parity, closes on scroll/resize, and never
// captures the pointer so neighboring nodes stay interactive.

import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import type { PlanNode } from "../lib/types";
import { PassiveStrip } from "./passive-strip";
import { genderView } from "../lib/ui";

const CARD_W = 268;
const OPEN_DELAY = 250;
const GAP = 10;
const MARGIN = 8;

const PLACEHOLDER = "(random)";

interface Point {
  left: number;
  top: number;
}

/** Place the card beside the anchor: right if it fits, else flipped left, then
 *  clamped into the viewport vertically. Identical rule to BreedHoverCard. */
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

/** Mono uppercase section label — the shared card row heading idiom. */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
      {children}
    </div>
  );
}

const IV_STATS: [string, 0 | 1 | 2][] = [
  ["HP", 0],
  ["ATK", 1],
  ["DEF", 2],
];

export function BredHoverCard({
  node,
  children,
}: {
  /** The BRED node this circle renders; `children` are its two parents. */
  node: PlanNode;
  children: ReactElement;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
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
    timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (!anchor || !card) return;
    setPos(place(anchor, card.width, card.height));
  }, [open]);

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
    onFocus?: (e: ReactFocusEvent) => void;
    onBlur?: (e: ReactFocusEvent) => void;
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
    onFocus: (e: ReactFocusEvent) => {
      childProps.onFocus?.(e);
      scheduleOpen();
    },
    onBlur: (e: ReactFocusEvent) => {
      childProps.onBlur?.(e);
      close();
    },
  });

  // WHAT this child must carry, straight off the node payload.
  const required = node.passives.filter((p) => p && p !== PLACEHOLDER);
  const randomCount = node.passives.filter((p) => p === PLACEHOLDER).length;
  const hasPassives = required.length > 0 || randomCount > 0;

  const g = genderView(node.gender);
  const hasGender = node.gender !== null;

  const ivTargets = node.iv_targets;
  const hasIvFloor = !!ivTargets && ivTargets.some((v) => v > 0);

  // Same-species step: the child's species equals one of its parents' — the step
  // exists to flip gender / consolidate passives within the species, not to
  // change species. Data-driven off the tree, no hardcoded species.
  const sameSpecies = node.children.some((c) => c.species === node.species);

  return (
    <>
      {trigger}
      {open &&
        createPortal(
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
            {/* Header — BRED + species + "child must carry" */}
            <div className="border-b border-line-soft px-3 py-2.5">
              <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-amber">
                <svg
                  width="9"
                  height="11"
                  viewBox="0 0 20 24"
                  className="shrink-0"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M10 1C6 1 2 8 2 14a8 8 0 0 0 16 0C18 8 14 1 10 1z" />
                </svg>
                Bred
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[13px] leading-tight">
                <span
                  className="min-w-0 truncate font-semibold text-ink"
                  title={node.species_name}
                >
                  {node.species_name}
                </span>
                {hasGender && (
                  <span className={`shrink-0 font-semibold ${g.className}`}>{g.glyph}</span>
                )}
              </div>
              <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
                child must carry
              </div>
            </div>

            {/* GENDER — the gender this child must hatch */}
            {hasGender && (
              <div className="border-b border-line-soft px-3 py-2">
                <Label>Gender</Label>
                <div className="mt-1.5 font-mono text-[11px] leading-none text-ink-dim">
                  must be <span className={`font-semibold ${g.className}`}>{g.glyph}</span>
                </div>
              </div>
            )}

            {/* PASS ON — required passives as chips + a random-slot count */}
            {hasPassives && (
              <div className="border-b border-line-soft px-3 py-2">
                <Label>Pass on</Label>
                <div className="mt-1.5 grid grid-cols-1 gap-1">
                  {required.map((p, i) => (
                    <PassiveStrip key={`${p}-${i}`} id={p} size="sm" />
                  ))}
                </div>
                {randomCount > 0 && (
                  <div className="mt-1.5 inline-flex items-center rounded-sm border border-line bg-abyss/40 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                    {randomCount} random
                  </div>
                )}
              </div>
            )}

            {/* IV FLOOR — inherited-IV minimums this child must carry */}
            {hasIvFloor && (
              <div className="border-b border-line-soft px-3 py-2">
                <Label>IV floor</Label>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[11px] leading-none tabular-nums text-ink-dim">
                  {IV_STATS.map(([label, i]) =>
                    ivTargets![i] > 0 ? (
                      <span key={label}>
                        {label}
                        {"\u2265"}
                        <span className="font-semibold text-ink">{ivTargets![i]}</span>
                      </span>
                    ) : null,
                  )}
                </div>
              </div>
            )}

            {/* SAME-SPECIES — flip/consolidation note, data-driven off the tree */}
            {sameSpecies && (
              <div className="px-3 py-2">
                <div className="font-mono text-[10px] leading-snug text-ink-faint">
                  {hasGender ? (
                    <>
                      same-species step &mdash; bred to get a{" "}
                      <span className={`font-semibold ${g.className}`}>{g.glyph}</span>{" "}
                      {node.species_name} (parents can&apos;t pair otherwise)
                    </>
                  ) : (
                    <>same-species step &mdash; gender/passive consolidation</>
                  )}
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
