// Icon asset resolution. Pal icons live in `app/public/pals/<InternalName>.png`
// (keyed by the internal species id — the same `characterId` used everywhere
// else in the app). Element/passive-rank icons live in `app/public/elements/`.
// Sourced from palcalc (MIT); see crates/pal-data/vendor/NOTICE for provenance.

/**
 * Neutral placeholder shown when a pal has no bundled icon (unknown/new
 * species). Inline SVG data URL so it needs no network round-trip and can be
 * dropped straight into an <img src> or a CSS background.
 */
export const UNKNOWN_ICON: string =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="12" fill="#2a2d34"/>' +
      '<text x="32" y="42" font-family="sans-serif" font-size="34" font-weight="700" ' +
      'text-anchor="middle" fill="#6b7280">?</text>' +
      "</svg>",
  );

/**
 * URL for a pal's icon by internal species id (`characterId`). Points at the
 * bundled asset; callers should fall back to {@link UNKNOWN_ICON} on an
 * `<img onerror>` for ids we don't have art for.
 */
export function palIconUrl(characterId: string): string {
  return `/pals/${characterId}.png`;
}

/**
 * URL for the in-game alpha (field-boss) marker — the red horned icon shown on
 * alpha pals. Bundled at `app/public/ui/alpha.png`; sourced from
 * palworld-save-pal (MIT), see crates/pal-data/vendor/NOTICE.
 */
export const alphaIconUrl: string = "/ui/alpha.png";

/**
 * URL for an element-type icon. Element names are matched case-insensitively
 * against the bundled set; unknown elements resolve to {@link UNKNOWN_ICON}.
 */
export function elementIconUrl(element: string): string {
  const key = ELEMENT_ICONS[element.toLowerCase()];
  return key ? `/elements/${key}.png` : UNKNOWN_ICON;
}

/**
 * URL for an element type's in-game **white glyph** — the flat monochrome
 * symbol used on the loud detail-header {@link ElementBanner}
 * (`public/elements/glyph/<Kind>_glyph.png`). Matched case-insensitively with
 * the same aliases as {@link elementIconUrl}; returns `null` for unknown
 * elements so callers fall back to the full-color tile.
 */
export function elementGlyphUrl(element: string): string | null {
  const key = ELEMENT_ICONS[element.toLowerCase()];
  return key ? `/elements/glyph/${key}_glyph.png` : null;
}

/**
 * Design-token suffix for an element type — the `el-*` color key used both as
 * a Tailwind utility (`text-el-fire`) and as the CSS custom property
 * `--color-el-<key>`. Matched case-insensitively with the same aliases as
 * {@link elementIconUrl}; returns `null` for unknown elements.
 */
export function elementTokenKey(element: string): string | null {
  const key = ELEMENT_ICONS[element.toLowerCase()];
  return key ? key.toLowerCase() : null;
}

const ELEMENT_ICONS: Record<string, string> = {
  dark: "Dark",
  dragon: "Dragon",
  earth: "Earth",
  ground: "Earth",
  electricity: "Electricity",
  electric: "Electricity",
  fire: "Fire",
  ice: "Ice",
  leaf: "Leaf",
  grass: "Leaf",
  normal: "Normal",
  neutral: "Normal",
  water: "Water",
};

/**
 * URL for a passive-skill **rank chevron** icon (palcalc's Passive_Positive_N /
 * Passive_Negative_N glyphs, bundled under `public/elements/`). Positive ranks
 * 1-5 and negative ranks 1-3 have art; rank 0 (no icon) returns null so callers
 * fall back to a CSS chevron. See crates/pal-data/vendor/NOTICE.
 */
export function passiveRankIconUrl(rank: number): string | null {
  if (rank > 0) return `/elements/Passive_Positive_${Math.min(rank, 5)}_icon.png`;
  if (rank < 0) return `/elements/Passive_Negative_${Math.min(-rank, 3)}_icon.png`;
  return null;
}

/**
 * URL for a species' partner-skill icon (`public/partner/<textureId>.png`),
 * keyed by the numeric texture id string the pack carries. Returns null when
 * the species has no resolved icon, so callers render {@link PARTNER_FALLBACK_ICON}.
 */
export function partnerIconUrl(iconId: string | null): string | null {
  return iconId ? `/partner/${iconId}.png` : null;
}

/**
 * Neutral generic partner-skill glyph — a minimal inline-SVG paw/bond mark on a
 * dark tile — shown when a species has no resolved partner icon (or one fails to
 * load). Inline data URL so it needs no network round-trip; never a broken img.
 */
export const PARTNER_FALLBACK_ICON: string =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
      '<rect width="48" height="48" rx="10" fill="#1d2733"/>' +
      '<path d="M24 14c4.4 0 8 3.6 8 8 0 5-4 8-8 12-4-4-8-7-8-12 0-4.4 3.6-8 8-8z" ' +
      'fill="none" stroke="#63717f" stroke-width="2.4" stroke-linejoin="round"/>' +
      "</svg>",
  );
