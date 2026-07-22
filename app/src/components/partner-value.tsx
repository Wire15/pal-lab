// Per-level partner-skill values. The pack ships partner-skill descriptions as
// a template with `{0}`..`{N}` slots wherever a number varies across the five
// partner-skill ranks (constants stay baked into the template text), plus a
// `values[slot][rank]` matrix of display strings (rank 1 first). We render each
// slot as the Lv 1 value in a quiet water-tinted token; hovering or focusing it
// reveals the full Lv 1..Lv N progression in a small tooltip.
//
//   <PartnerSkillDescription template={t} values={v} />          // detail page
//   <PartnerSkillDescription template={t} values={v} interactive={false} />  // hover card
//
// When `interactive` is false the tokens still highlight the Lv 1 value but grow
// no tooltip — used inside the pal hover card, which is itself a pointer-inert
// tooltip (a nested one would be unreachable and visually noisy).

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const OPEN_DELAY = 250;
const GAP = 8;
const MARGIN = 8;
const TIP_W = 156;

interface Point {
  left: number;
  top: number;
}

/** The optional per-level partner-skill payload, once resolved off an entry. */
export interface PartnerLevels {
  template: string;
  values: string[][];
}

/**
 * Read the per-level partner fields off a species entry/detail. Structural cast
 * (not a typed field access) so this compiles before DataRank widens the shared
 * `SpeciesEntry` type. Returns null when the pack ships no template — the ~130
 * templateless species then fall back to the plain resolved description.
 */
export function partnerLevels(entry: unknown): PartnerLevels | null {
  const e = entry as
    | { partner_skill_template?: string | null; partner_skill_values?: string[][] }
    | null
    | undefined;
  const template = e?.partner_skill_template;
  if (typeof template !== "string" || template.length === 0) return null;
  const values = Array.isArray(e?.partner_skill_values) ? e.partner_skill_values : [];
  return { template, values };
}

/** A parsed template chunk: literal text, or a `{slot}` reference. */
type Chunk = { text: string } | { slot: number };

const SLOT_RE = /\{(\d+)\}/g;

/** Split a template into literal-text and slot chunks, preserving order and
 *  any interleaving newlines (rendered under `white-space: pre-line`). */
function parseTemplate(template: string): Chunk[] {
  const chunks: Chunk[] = [];
  let last = 0;
  for (const m of template.matchAll(SLOT_RE)) {
    const at = m.index ?? 0;
    if (at > last) chunks.push({ text: template.slice(last, at) });
    chunks.push({ slot: Number(m[1]) });
    last = at + m[0].length;
  }
  if (last < template.length) chunks.push({ text: template.slice(last) });
  return chunks;
}

/** Place the tooltip below the token if it fits, else flipped above; clamped
 *  horizontally into the viewport. Centered on the token. */
function place(anchor: DOMRect, w: number, h: number): Point {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.left + anchor.width / 2 - w / 2;
  left = Math.min(Math.max(MARGIN, left), vw - w - MARGIN);
  let top = anchor.bottom + GAP;
  if (top + h > vh - MARGIN) top = anchor.top - GAP - h;
  if (top < MARGIN) top = MARGIN;
  return { left, top };
}

/** One template slot: the Lv 1 value as a water-tinted token, optionally
 *  wired to a per-level progression tooltip on hover/focus. */
function PartnerValue({
  levels,
  interactive,
}: {
  levels: string[];
  interactive: boolean;
}) {
  const tipId = useId();
  const tokenRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Point | null>(null);

  const lv1 = levels[0] ?? "";

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

  // Keyboard focus is a deliberate act — open immediately, no hover delay.
  const openNow = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setOpen(true);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = tokenRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!anchor || !tip) return;
    setPos(place(anchor, tip.width, tip.height));
  }, [open]);

  // A transient tooltip must not linger over stale layout.
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

  // Non-interactive (hover card): a static highlighted token, no tooltip.
  if (!interactive || levels.length <= 1) {
    return (
      <span
        className="mx-px inline-flex items-baseline rounded-sm px-1 font-mono font-medium text-el-water"
        style={{
          backgroundColor: "color-mix(in srgb, var(--color-el-water) 14%, transparent)",
        }}
      >
        {lv1}
      </span>
    );
  }

  return (
    <>
      <span
        ref={tokenRef}
        tabIndex={0}
        role="button"
        aria-describedby={open ? tipId : undefined}
        aria-label={`Value at level 1: ${lv1}. Scales to ${levels[levels.length - 1]} at level ${levels.length}.`}
        className="mx-px inline-flex cursor-help items-baseline rounded-sm px-1 font-mono font-medium text-el-water outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--color-el-water)_24%,transparent)] focus-visible:ring-1 focus-visible:ring-el-water/70"
        style={{
          backgroundColor: "color-mix(in srgb, var(--color-el-water) 14%, transparent)",
        }}
        onPointerEnter={scheduleOpen}
        onPointerLeave={close}
        onFocus={openNow}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            close();
            tokenRef.current?.blur();
          }
        }}
      >
        {lv1}
      </span>
      {open && (
        <div
          ref={tipRef}
          id={tipId}
          role="tooltip"
          style={{
            position: "fixed",
            left: pos ? pos.left : -9999,
            top: pos ? pos.top : -9999,
            width: TIP_W,
            pointerEvents: "none",
            zIndex: 70,
            visibility: pos ? "visible" : "hidden",
          }}
          className="overflow-hidden rounded-md border border-line bg-panel/95 ring-1 ring-abyss/70"
        >
          <div className="border-b border-line-soft px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
            Per level
          </div>
          <div className="flex flex-col py-1">
            {levels.map((v, i) => {
              const current = i === 0;
              return (
                <div
                  key={i}
                  className={`flex items-baseline justify-between gap-3 px-2.5 py-0.5 text-[11px] ${
                    current ? "bg-[color-mix(in_srgb,var(--color-el-water)_12%,transparent)]" : ""
                  }`}
                >
                  <span
                    className={`font-mono uppercase tracking-wide ${
                      current ? "text-el-water" : "text-ink-faint"
                    }`}
                  >
                    Lv {i + 1}
                  </span>
                  <span
                    className={`font-mono tabular-nums ${
                      current ? "font-semibold text-el-water" : "text-ink-dim"
                    }`}
                  >
                    {v}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * A partner-skill description rendered from its pack template + per-level value
 * matrix. Slots become {@link PartnerValue} tokens (Lv 1 value, water-tinted);
 * literal text (including newlines) renders under `white-space: pre-line`.
 */
export function PartnerSkillDescription({
  template,
  values,
  interactive = true,
  className = "",
}: {
  template: string;
  values: string[][];
  interactive?: boolean;
  className?: string;
}) {
  const chunks = parseTemplate(template);
  return (
    <p className={`whitespace-pre-line ${className}`}>
      {chunks.map((c, i) =>
        "text" in c ? (
          <span key={i}>{c.text}</span>
        ) : (
          <PartnerValue key={i} levels={values[c.slot] ?? []} interactive={interactive} />
        ),
      )}
    </p>
  );
}
