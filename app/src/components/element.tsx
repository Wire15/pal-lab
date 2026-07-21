// Element-type rendering: the 9 canonical Palworld types as compact,
// self-tinted badge chips. The bundled icons (public/elements/<Kind>.png) are
// already full-color type tiles, so the icon carries the categorical color; the
// optional label is tinted with the matching `el-*` design token (§2) via the
// `--color-el-<key>` custom property, never a hardcoded hex.

import { elementGlyphUrl, elementIconUrl, elementTokenKey } from "../lib/assets";

/** The colored type tile for one element, keyed case-insensitively. */
export function ElementIcon({
  element,
  size = 16,
  className = "",
}: {
  element: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={elementIconUrl(element)}
      alt={element}
      title={element}
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      className={`shrink-0 rounded-sm object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * A single element badge: the colored type icon and, when `label` is set, the
 * element name tinted with its `el-*` token on a quiet `abyss` chip (matching
 * the work-badge treatment so the two badge families read as siblings).
 */
export function ElementChip({
  element,
  label = false,
  size = 14,
}: {
  element: string;
  /** Show the element name beside the icon. */
  label?: boolean;
  size?: number;
}) {
  if (!label) return <ElementIcon element={element} size={size} />;
  const key = elementTokenKey(element);
  const color = key ? `var(--color-el-${key})` : "var(--color-ink-dim)";
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-abyss/70 py-0.5 pl-0.5 pr-1.5">
      <ElementIcon element={element} size={size} />
      <span
        className="font-mono text-[10px] font-semibold uppercase leading-none tracking-wider"
        style={{ color }}
      >
        {element}
      </span>
    </span>
  );
}

/**
 * The element list for a species (1–2 types, primary then secondary). Renders
 * nothing when empty. Icon-only by default for dense card/hover contexts; pass
 * `label` for the detail header.
 */
export function ElementBadges({
  elements,
  label = false,
  size = 14,
  className = "",
}: {
  elements: string[] | undefined;
  label?: boolean;
  size?: number;
  className?: string;
}) {
  if (!elements || elements.length === 0) return null;
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {elements.map((e) => (
        <ElementChip key={e} element={e} label={label} size={size} />
      ))}
    </div>
  );
}

/**
 * A paldb/in-game-style element **banner** for the detail header: the flat
 * **white in-game glyph** on a chip whose background is the element's own `el-*`
 * token tinted down over `abyss` and whose border is the same token (both via
 * `color-mix`, never a hardcoded hex) — the loud, dark-tinted banner look the
 * game uses. Falls back to the full-color {@link ElementIcon} tile when no glyph
 * exists for the type (unknown element or a missing asset). Larger and louder
 * than {@link ElementChip} — one per type, sized for the hero header.
 */
export function ElementBanner({
  element,
  size = 20,
}: {
  element: string;
  size?: number;
}) {
  const key = elementTokenKey(element);
  const color = key ? `var(--color-el-${key})` : "var(--color-ink-dim)";
  const glyph = elementGlyphUrl(element);
  return (
    <span
      className="inline-flex items-center gap-2 rounded-md border py-1 pl-2 pr-3"
      style={{
        borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 22%, var(--color-abyss))`,
      }}
    >
      {glyph ? (
        <img
          src={glyph}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          draggable={false}
          className="shrink-0 object-contain"
          style={{ width: size, height: size }}
          onError={(e) => {
            const img = e.currentTarget;
            img.onerror = null;
            img.src = elementIconUrl(element);
          }}
        />
      ) : (
        <ElementIcon element={element} size={size} />
      )}
      <span
        className="font-display text-[12px] font-semibold uppercase tracking-[0.12em]"
        style={{ color }}
      >
        {element}
      </span>
    </span>
  );
}

/** The 1–2 element banners for a species, primary then secondary; null when empty. */
export function ElementBanners({
  elements,
  size = 20,
  className = "",
}: {
  elements: string[] | undefined;
  size?: number;
  className?: string;
}) {
  if (!elements || elements.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {elements.map((e) => (
        <ElementBanner key={e} element={e} size={size} />
      ))}
    </div>
  );
}
