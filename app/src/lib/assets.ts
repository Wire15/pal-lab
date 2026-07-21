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
 * URL for an element-type icon. Element names are matched case-insensitively
 * against the bundled set; unknown elements resolve to {@link UNKNOWN_ICON}.
 */
export function elementIconUrl(element: string): string {
  const key = ELEMENT_ICONS[element.toLowerCase()];
  return key ? `/elements/${key}.png` : UNKNOWN_ICON;
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
