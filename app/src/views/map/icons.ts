// In-game POI icon resolution (contract C1). IconExtract publishes
// `public/map/icons/<key>.png` (transparent, native size) plus a manifest at
// `public/map/icons.json`: `Record<key, { file, px:[w,h], source }>`. The art is
// extracted from the user's own paks, so it may not exist yet (IconExtract runs
// in parallel) — every consumer degrades to a tasteful inline-SVG vector glyph
// keyed the same way, so a missing manifest or missing key is never a broken
// image, only a slightly plainer pin.

/** One manifest entry: the icon's public filename, native px size, and the pak
 *  asset path it was extracted from (provenance, unused by the UI). */
export interface IconEntry {
  file: string;
  px: [number, number];
  source: string;
  /** True when the source art is a white/gray silhouette meant to be tinted at
   *  render time (the game colors these client-side). Contract X1: stamped by
   *  the exporter when opaque pixels are ≥95% near-white/neutral. The pin layer
   *  renders `mono` icons through a CSS mask (so they read over any terrain);
   *  colored art (bounty, effigy, base, alpha badge) omits it and renders as-is. */
  mono?: boolean;
}

export type IconManifest = Record<string, IconEntry>;

let iconsPromise: Promise<IconManifest> | null = null;

/** Fetch (and cache) the icon manifest. A missing file (404) or parse error
 *  resolves to `{}` — the consumer then uses vector fallbacks for every key. */
export function loadMapIcons(): Promise<IconManifest> {
  if (!iconsPromise) {
    iconsPromise = fetch("/map/icons.json")
      .then((r) => (r.ok ? (r.json() as Promise<IconManifest>) : {}))
      .catch(() => ({}));
  }
  return iconsPromise;
}

/** Public URL for a manifest entry's PNG (`/map/icons/<file>`). */
export function iconUrl(entry: IconEntry): string {
  return `/map/icons/${entry.file}`;
}

/** Compass-glyph keys that are tint-me silhouettes even before the exporter
 *  stamps `mono` (contract X2 fallback): the game colors these client-side.
 *  `marker_*` (the custom-marker palette) match by prefix. An explicit manifest
 *  `mono` always wins over this heuristic. */
const MONO_DEFAULT: Record<string, true> = {
  fast_travel: true,
  tower: true,
  dungeon: true,
  unknown: true,
};

/** Whether icon `key` should render as a tinted CSS mask (a mono silhouette the
 *  game tints at runtime) rather than as-is art. Honors an explicit manifest
 *  `mono`; otherwise falls back to the compass-glyph heuristic so pins stay
 *  legible before the regenerated manifest lands. */
export function isMonoIcon(icons: IconManifest | null, key: string): boolean {
  const mono = icons?.[key]?.mono;
  if (mono !== undefined) return mono;
  return MONO_DEFAULT[key] === true || key.startsWith("marker_");
}

// --- Vector fallbacks -----------------------------------------------------
// One inline-SVG data URL per semantic key, tuned to read at ~28px on the map.
// `c` is the accent color so a locked/found variant can recolor the same glyph.
// These are deliberately simple silhouettes (never a fake pak-art facsimile):
// a designed placeholder, not a fabricated in-game icon.

function svg(inner: string, size = 32): string {
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${inner}</svg>`,
    )
  );
}

/** Fallback glyph builders keyed by the C1 icon key. `c` tints the mark. */
const FALLBACKS: Record<string, (c: string) => string> = {
  // Fast-travel: a stylized eagle statue reduced to spread wings over a base.
  fast_travel: (c) =>
    svg(
      `<path d="M16 6 L22 12 L18 12 L16 10 L14 12 L10 12 Z" fill="${c}"/>` +
        `<path d="M6 15 L16 12 L26 15 L16 18 Z" fill="${c}"/>` +
        `<rect x="14" y="18" width="4" height="7" rx="1" fill="${c}"/>` +
        `<rect x="10" y="24" width="12" height="2.5" rx="1.2" fill="${c}"/>`,
    ),
  // Alpha badge: a small filled diamond (the lower-right boss badge).
  alpha_badge: (c) => svg(`<path d="M16 4 L28 16 L16 28 L4 16 Z" fill="${c}"/>`, 20),
  // Bounty: a hooded-figure silhouette.
  bounty: (c) =>
    svg(
      `<path d="M16 5 C11 5 8 9 8 15 L8 27 L24 27 L24 15 C24 9 21 5 16 5 Z" fill="${c}"/>` +
        `<ellipse cx="16" cy="14" rx="4.5" ry="5" fill="#0d1117" opacity="0.55"/>`,
    ),
  // Dungeon: a cyan diamond fortress.
  dungeon: (c) =>
    svg(
      `<path d="M16 4 L28 16 L16 28 L4 16 Z" fill="none" stroke="${c}" stroke-width="2.4"/>` +
        `<rect x="12" y="12" width="8" height="8" fill="${c}"/>`,
    ),
  // Tower: a broadcast/ruin spire.
  tower: (c) =>
    svg(
      `<path d="M13 6 L19 6 L17 26 L15 26 Z" fill="${c}"/>` +
        `<path d="M9 10 L23 10" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`,
    ),
  // Base: a simple home mark.
  base: (c) =>
    svg(
      `<path d="M6 16 L16 7 L26 16 L23 16 L23 26 L9 26 L9 16 Z" fill="${c}"/>`,
    ),
  // Effigy: a totem pillar.
  effigy: (c) =>
    svg(
      `<rect x="12" y="6" width="8" height="20" rx="2" fill="${c}"/>` +
        `<circle cx="16" cy="12" r="2.4" fill="#0d1117" opacity="0.6"/>` +
        `<path d="M12 18 L20 18" stroke="#0d1117" stroke-width="1.6" opacity="0.5"/>`,
    ),
  // Unknown POI: a question mark tile.
  unknown: (c) =>
    svg(
      `<circle cx="16" cy="16" r="11" fill="none" stroke="${c}" stroke-width="2.2"/>` +
        `<text x="16" y="22" font-family="sans-serif" font-size="16" font-weight="700" text-anchor="middle" fill="${c}">?</text>`,
    ),
};

/** A tinted inline-SVG data URL for icon `key`, or null when there is no vector
 *  design for it (custom-marker enum values with no bundled art). */
export function fallbackIcon(key: string, color: string): string | null {
  const build = FALLBACKS[key];
  return build ? build(color) : null;
}

/** Neutral diamond marker for a custom map marker with no resolvable icon —
 *  the current neutral-dot fallback, upgraded to a small outlined diamond so it
 *  reads as an intentional map mark, not a stray pixel. */
export function markerFallback(color: string): string {
  return svg(
    `<path d="M16 5 L27 16 L16 27 L5 16 Z" fill="${color}" opacity="0.9" stroke="#0d1117" stroke-width="1.5"/>`,
    24,
  );
}
