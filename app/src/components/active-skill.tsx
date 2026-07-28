// In-game ACTIVE-SKILL row — the horizontal strip from Palworld's Pal Stats
// screen: a block-level, full-width dark bar with an element-colored left
// accent, the skill name pinned left in bold, and a right-pinned element segment
// (the white in-game glyph on the element's own tint) carrying the POWER
// numeral. A compact mono "CT Ns" chip sits beside the segment. The skill's
// description reveals as a collapsible line under the row — a real button with
// `aria-expanded`, so it is keyboard-reachable without leaving the page.
//
// Sibling of the passive STRIP (components/passive-strip.tsx): same block-strip
// anatomy (rounded-sm border, thick left accent, name left / stats right), but
// tinted by ELEMENT instead of passive rank. Every color is a `--color-*` token
// composed via color-mix — never a hardcoded hex.

import { useState } from "react";
import { humanizeWaza, type ActiveSkill } from "../lib/active-skills";
import { elementGlyphUrl, elementIconUrl, elementTokenKey } from "../lib/assets";

/**
 * One equipped active skill as the in-game strip. `skill` is the resolved
 * {@link ActiveSkill} (name + element/power/cool_time/description) or `null` for
 * a waza id absent from the `list_active_skills` map — in which case the name is
 * humanized from `id` and the row renders stats-less (no element segment, no
 * chips, no description).
 */
export function ActiveSkillRow({
  id,
  skill,
  level,
  onOpenMove,
  showMoveTags = false,
}: {
  id: string;
  skill: ActiveSkill | null;
  /** Optional level-up condition — renders a mono "Lv N" chip prefixing the
   *  name (matches the CT chip style). Used by the pal-dex LEARNABLE MOVES
   *  list; equipped-skill call sites omit it so their rows are unchanged. */
  level?: number;
  /** When set, the move NAME becomes a link calling `onOpenMove(id)` (the
   *  pal-dex LEARNABLE MOVES cross-link into the MOVES tab). The description
   *  caret stays its own toggle so both coexist without nesting buttons. Call
   *  sites that omit it render the row exactly as before. */
  onOpenMove?: (id: string) => void;
  /** When true, render faint INHERIT / FRUIT chips (from `skill.can_inherit` /
   *  `skill.has_skill_fruit`) in the right cluster. Used by the pal-dex MOVES
   *  tab; other call sites omit it so their rows are unchanged. */
  showMoveTags?: boolean;
}) {
  const name = skill?.name ?? humanizeWaza(id);
  const key = skill ? elementTokenKey(skill.element) : null;
  // Element color when known, else the neutral brand accent (amber) so the left
  // rail never disappears on unknown/unlocalized ("None") skills.
  const accent = key ? `var(--color-el-${key})` : "var(--color-amber)";
  const element = skill?.element ?? "";
  const power = skill?.power ?? null;
  const cool_time = skill?.cool_time ?? null;
  const hasElement = key !== null;
  const hasPower = power !== null;
  const hasCt = cool_time !== null;
  const description = skill?.description?.trim() || null;

  const [open, setOpen] = useState(false);

  const levelChip =
    level !== undefined ? (
      <span className="shrink-0 rounded-sm bg-abyss/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none tabular-nums text-ink-dim">
        Lv {level}
      </span>
    ) : null;

  // Right cluster: the CT chip + element/power segment — identical across the
  // plain row and the linked (onOpenMove) row, so it is shared.
  const rightCluster = (
    <span className="flex shrink-0 items-center gap-1.5">
      {showMoveTags && skill?.can_inherit && (
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wider text-ink-faint">
          Inherit
        </span>
      )}
      {showMoveTags && skill?.has_skill_fruit && (
        <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wider text-ink-faint">
          Fruit
        </span>
      )}
      {hasCt && (
        <span className="rounded-sm bg-abyss/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none tabular-nums text-ink-dim">
          CT {cool_time}s
        </span>
      )}
      {hasElement && (
        <span
          className="flex items-center gap-1.5 self-stretch rounded-sm py-1 pl-1.5 pr-2"
          style={{
            backgroundColor: `color-mix(in srgb, ${accent} 72%, var(--color-abyss))`,
          }}
        >
          <ElementMark element={element} />
          {hasPower && (
            <span className="font-display text-[13px] font-bold leading-none tabular-nums text-ink">
              {power}
            </span>
          )}
        </span>
      )}
    </span>
  );

  const header = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {description && (
          <span
            aria-hidden
            className="shrink-0 text-[9px] leading-none text-ink-faint transition-transform duration-150"
            style={{ transform: open ? "rotate(90deg)" : "none" }}
          >
            {"\u25B8"}
          </span>
        )}
        {levelChip}
        <span className="min-w-0 truncate font-display font-semibold tracking-wide text-ink">
          {name}
        </span>
      </span>
      {rightCluster}
    </>
  );

  const rowClass =
    "flex w-full min-h-[30px] items-center justify-between gap-2.5 rounded-sm border border-line bg-raised pl-2.5 pr-1 py-1 text-left text-[13px] leading-tight transition-colors";

  const descriptionPanel = description && open && (
    <p className="mt-1 rounded-sm border border-line-soft bg-abyss/40 px-2.5 py-1.5 text-[12px] leading-snug text-ink-dim">
      {description}
    </p>
  );

  // Linked variant (pal-dex LEARNABLE MOVES): the move NAME is a link jumping to
  // the MOVES tab focused on this skill. The row is a plain div so the name link
  // and the description caret are sibling buttons — never nested.
  if (onOpenMove) {
    return (
      <div className="flex flex-col">
        <div
          title={id}
          className={rowClass}
          style={{ borderLeftWidth: 3, borderLeftColor: accent }}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {description && (
              <button
                type="button"
                aria-expanded={open}
                aria-label={open ? "Hide description" : "Show description"}
                onClick={() => setOpen((v) => !v)}
                className="shrink-0 rounded-sm text-[9px] leading-none text-ink-faint transition-transform duration-150 hover:text-ink-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber/70"
                style={{ transform: open ? "rotate(90deg)" : "none" }}
              >
                {"\u25B8"}
              </button>
            )}
            {levelChip}
            <button
              type="button"
              title={`View pals that learn ${name}`}
              onClick={() => onOpenMove(id)}
              className="min-w-0 truncate rounded-sm text-left font-display font-semibold tracking-wide text-ink transition-colors hover:text-amber hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber/70"
            >
              {name}
            </button>
          </span>
          {rightCluster}
        </div>
        {descriptionPanel}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {description ? (
        <button
          type="button"
          title={id}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`${rowClass} hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber/70`}
          style={{ borderLeftWidth: 3, borderLeftColor: accent }}
        >
          {header}
        </button>
      ) : (
        <div
          title={id}
          className={rowClass}
          style={{ borderLeftWidth: 3, borderLeftColor: accent }}
        >
          {header}
        </div>
      )}

      {descriptionPanel}
    </div>
  );
}

/**
 * The element glyph inside the right segment: the flat **white in-game glyph**
 * (already white-on-alpha, so it reads white on the tinted block), falling back
 * to the full-color type tile when no glyph asset exists for the type.
 */
function ElementMark({ element }: { element: string }) {
  const glyph = elementGlyphUrl(element);
  if (!glyph) {
    return (
      <img
        src={elementIconUrl(element)}
        alt={element}
        title={element}
        width={15}
        height={15}
        loading="lazy"
        draggable={false}
        className="shrink-0 rounded-[2px] object-contain"
        style={{ width: 15, height: 15 }}
      />
    );
  }
  return (
    <img
      src={glyph}
      alt={element}
      title={element}
      width={15}
      height={15}
      loading="lazy"
      draggable={false}
      className="shrink-0 object-contain"
      style={{ width: 15, height: 15 }}
      onError={(e) => {
        const img = e.currentTarget;
        img.onerror = null;
        img.src = elementIconUrl(element);
      }}
    />
  );
}
