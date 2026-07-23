// The breeding-step briefing card that opens off a plan-graph junction chip:
// the "what does this one breed step actually take" tooltip. Mirrors
// PalHoverCard's positioning machinery verbatim — a `position: fixed`, measured,
// viewport-edge-flipping card PORTALED to document.body so it escapes the
// plan-graph translate+scale containing block (a fixed element resolves against
// the nearest transformed ancestor, not the viewport, so an inline card would
// offset by the canvas transform) — and adds keyboard focus/blur triggering on
// top of hover, since the junction chip is focusable. 250ms open delay matches
// PalHoverCard.
//
// Anatomy (top -> bottom): header (parents -> child), ODDS split (passives /
// IVs / combined per-egg), STEP (total time + eggs · time/egg), IV GATE (the
// inherited-IV floor this node must carry), and the parents' combined PASSIVE
// POOL as PassiveStrip rows with the child's must-inherit passives amber-ringed.
//
// Every field beyond `probability`/`est_time_secs` is a StepData addition that
// is OPTIONAL (legacy localStorage plans and owned/wild nodes lack them); the
// card degrades to showing only what exists.

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
import type { Guid, OwnedPal, PlanNode, PlanSource } from "../lib/types";
import { PassiveStrip } from "./passive-strip";
import { formatDuration, ivBand, probBand, QUALITY_FILL, QUALITY_TEXT } from "../lib/ui";

const CARD_W = 268;
const OPEN_DELAY = 250;
const GAP = 10;
const MARGIN = 8;

interface Point {
  left: number;
  top: number;
}

/** Place the card beside the anchor: right if it fits, else flipped left, then
 *  clamped into the viewport vertically. Identical rule to PalHoverCard. */
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

const PLACEHOLDER = "(random)";

/** The owned-instance GUID a plan source carries, or null for wild/bred/legacy
 *  (no `instance_id`). Read defensively via `in` narrowing so it compiles even
 *  where the field is absent on the type. */
function ownedInstanceId(source: PlanSource): Guid | null {
  if (typeof source === "object" && "Owned" in source) {
    const o = source.Owned;
    if ("instance_id" in o && Array.isArray(o.instance_id) && o.instance_id.length > 0)
      return o.instance_id;
  }
  return null;
}

/** A parent's real passive pool: the resolved OWNED instance's passives when the
 *  save can join its `instance_id`, else the node's own passives (bred parents,
 *  synthetic queue seeds, legacy plans, no save). Placeholders dropped. */
function poolFor(
  parent: PlanNode,
  resolvePal: (id?: Guid | null) => OwnedPal | undefined,
): string[] {
  const inst = resolvePal(ownedInstanceId(parent.source));
  const list = inst ? inst.passives : parent.passives;
  return list.filter((p) => p && p !== PLACEHOLDER);
}

/** Mono uppercase section label — the card's shared row heading idiom. */
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

export function BreedHoverCard({
  child,
  resolvePal,
  children,
}: {
  /** The BRED node this junction produces; its `children` are the two parents. */
  child: PlanNode;
  resolvePal: (id?: Guid | null) => OwnedPal | undefined;
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

  // Measure once open, then position (and flip) against the anchor rect. The
  // rect is viewport-space even inside the transformed canvas, so this stays
  // correct at every pan/zoom.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (!anchor || !card) return;
    setPos(place(anchor, card.width, card.height));
  }, [open]);

  // A transient tooltip should not linger over stale layout: close on any scroll
  // (capture, to catch inner scrollers) or resize.
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
    // Keyboard parity: focusing the chip (Tab) opens after the same delay,
    // blurring closes. Focus is instant to the eye but the delay keeps rapid
    // tab-throughs from strobing cards.
    onFocus: (e: ReactFocusEvent) => {
      childProps.onFocus?.(e);
      scheduleOpen();
    },
    onBlur: (e: ReactFocusEvent) => {
      childProps.onBlur?.(e);
      close();
    },
  });

  const parents = child.children;

  // Odds split — shown only when StepData's per-egg factors are present.
  const hasSplit =
    typeof child.prob_passives === "number" && typeof child.prob_ivs === "number";
  const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
  const comboBand = probBand(child.probability);

  // Eggs — authoritative per-step count; time/egg = self step effort / eggs.
  const eggs = typeof child.expected_eggs === "number" ? child.expected_eggs : null;
  const timePerEgg = eggs && eggs > 0 ? child.est_time_secs / eggs : null;

  // IV gate — only when some stat carries a nonzero floor.
  const ivTargets = child.iv_targets;
  const hasIvGate = !!ivTargets && ivTargets.some((v) => v > 0);

  // Passive pool + must-inherit set.
  const parentA = parents[0];
  const parentB = parents[1];
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const p of [
    ...(parentA ? poolFor(parentA, resolvePal) : []),
    ...(parentB ? poolFor(parentB, resolvePal) : []),
  ]) {
    if (!seen.has(p)) {
      seen.add(p);
      pool.push(p);
    }
  }
  const desired = new Set(child.passives.filter((p) => p && p !== PLACEHOLDER));
  const desiredInPool = pool.some((p) => desired.has(p));

  const parentNames = parents.map((p) => p.species_name).join(" \u00d7 ");

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
            {/* Header — BREED STEP + parents -> child */}
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
                Breed step
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[13px] leading-tight">
                <span className="min-w-0 truncate text-ink-dim" title={parentNames}>
                  {parentNames || "\u2014"}
                </span>
                <span className="shrink-0 text-amber" aria-hidden>
                  {"\u2192"}
                </span>
                <span
                  className="min-w-0 truncate font-semibold text-ink"
                  title={child.species_name}
                >
                  {child.species_name}
                </span>
              </div>
            </div>

            {/* ODDS — per-egg success split; degrades to combined only */}
            <div className="border-b border-line-soft px-3 py-2">
              <Label>Odds per egg</Label>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[11px] leading-none tabular-nums">
                {hasSplit && (
                  <>
                    <span className="text-ink-dim">
                      passives{" "}
                      <span className="font-semibold text-ink">
                        {pct(child.prob_passives!)}
                      </span>
                    </span>
                    <span className="text-line">{"\u00b7"}</span>
                    <span className="text-ink-dim">
                      IVs{" "}
                      <span className="font-semibold text-ink">{pct(child.prob_ivs!)}</span>
                    </span>
                    <span className="text-line">{"\u00b7"}</span>
                  </>
                )}
                <span className="text-ink-dim">
                  ={" "}
                  <span className={`font-semibold ${comboBand.text}`}>
                    {pct(child.probability)}
                  </span>
                </span>
              </div>
            </div>

            {/* STEP — total self effort always; eggs + time/egg when known */}
            <div className="border-b border-line-soft px-3 py-2">
              <Label>Step</Label>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[11px] leading-none tabular-nums text-ink-dim">
                {eggs !== null && (
                  <>
                    <span>
                      ~<span className="font-semibold text-ink">{eggs}</span> egg
                      {eggs === 1 ? "" : "s"}
                    </span>
                    {timePerEgg !== null && (
                      <>
                        <span className="text-line">{"\u00b7"}</span>
                        <span>{formatDuration(timePerEgg)}/egg</span>
                      </>
                    )}
                    <span className="text-line">{"\u00b7"}</span>
                  </>
                )}
                <span>
                  {formatDuration(child.est_time_secs)}{" "}
                  <span className="text-ink-faint">total</span>
                </span>
              </div>
            </div>

            {/* IV GATE — the inherited-IV floor this node must carry */}
            {hasIvGate && (
              <div className="border-b border-line-soft px-3 py-2">
                <Label>IV gate</Label>
                <div className="mt-1.5 space-y-1.5">
                  {IV_STATS.map(([label, i]) => {
                    const target = ivTargets![i];
                    if (target <= 0) return null;
                    const band = ivBand(target);
                    return (
                      <div key={label} className="flex items-center gap-2">
                        <span className="w-7 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                          {label}
                        </span>
                        <span className="font-mono text-[11px] leading-none text-ink-dim">
                          {"\u2265"}
                        </span>
                        <span
                          className={`font-mono text-[12px] font-semibold tabular-nums ${QUALITY_TEXT[band]}`}
                        >
                          {target}
                        </span>
                        <span className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-abyss">
                          <span
                            className={`block h-full rounded-full ${QUALITY_FILL[band]}`}
                            style={{ width: `${Math.min(100, target)}%` }}
                          />
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* PASSIVE POOL — parents' combined pool; must-inherit amber-ringed */}
            {pool.length > 0 && (
              <div className="px-3 py-2">
                <Label>Passive pool</Label>
                <div className="mt-1.5 grid grid-cols-1 gap-1">
                  {pool.map((p, i) =>
                    desired.has(p) ? (
                      <div
                        key={`${p}-${i}`}
                        className="rounded-sm ring-1 ring-amber"
                        title="Must be inherited by the child"
                      >
                        <PassiveStrip id={p} size="sm" />
                      </div>
                    ) : (
                      <PassiveStrip key={`${p}-${i}`} id={p} size="sm" />
                    ),
                  )}
                </div>
                {hasSplit && desiredInPool && (
                  <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] leading-none text-ink-faint">
                    <span className="h-2 w-2 shrink-0 rounded-sm ring-1 ring-amber" aria-hidden />
                    <span>
                      these must all pass:{" "}
                      <span className="font-semibold text-amber">
                        {pct(child.prob_passives!)}
                      </span>{" "}
                      per egg
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
