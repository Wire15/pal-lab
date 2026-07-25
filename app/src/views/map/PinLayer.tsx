// The POI pin overlay: a screen-space DOM layer above the map canvas. Pins are
// positioned in *content* px (`worldToPx · k`) inside a container that carries
// only the pan translate, so a pan updates one transform (GPU-composited) and
// never re-lays-out the pins — 150+ pins stay smooth while panning. The visible
// set is culled to the viewport (plus a margin) and only recomputed when the
// pan crosses a coarse bucket, so the cull never costs per-frame work.
//
// Pin anatomy v3 (Map Wave 3 — polish):
//   • Mono tint pipeline — the in-game compass glyphs (fast_travel, tower,
//     dungeon, unknown, marker_*) are WHITE silhouettes the game tints at render
//     time, so as-is <img>s vanish over terrain. `mono` icons (contract X1/X2)
//     are drawn as a CSS mask filled with a token tint; colored art (effigy,
//     bounty, base, tower, alpha badge) renders as-is. Either way each glyph sits
//     on a dark rounded chip so it reads over ANY terrain (mirrors the backing).
//   • Sizes approach in-game proportions: fast_travel 30, tower 34 (major
//     landmark), effigy/bounty 28, base 26, markers 22; alpha portrait 34.
//   • Screen-scale model (T2): pins are BASE size at k <= 1 (constant when zoomed
//     out) and grow SUB-linearly above 100% (`pinZoomScale` = k^0.45, cap 1.5x),
//     emitted as ONE inherited container var `--pin-zoom-scale` — zero per-pin JS.
//   • Alpha pins are Palbox-style circular ring-clipped portraits with the rich
//     PalHoverCard (species + an "Alpha Pal · Lv N" context strip) on hover.
//   • Effigies read via a dark chip + color/dim state (no checkmark badge); a
//     spoiler modifier (`hideUnfoundEffigies`) hides the unfound ones entirely.
//   • Towers are always-`known` (fog-exempt) crimson landmarks; reached = grayscale
//     + dim (join on `towers_defeated`), not-reached = full color + crimson glow.
//   • Low-zoom de-emphasis fades non-lead pins via a container var, so alpha
//     portraits, towers, and player pins lead when zoomed out — zero per-pin JS.
//
// The gesture-zoom transform on the positioning container is owned by MapView
// (MapPerf): it writes `containerRef.current.style.transform` imperatively
// during a wheel gesture so no prop changes and this layer never re-renders;
// on settle MapView commits `k` and our normal render restores translate-only.

import { memo, useMemo, useState, type CSSProperties, type RefObject } from "react";
import { worldToPx, worldInBounds, type MapEntry } from "../../lib/map-coords";
import { PalHoverCard } from "../../components/pal-hover-card";
import { isRevealed, type FogMask } from "./fog";
import {
  fallbackIcon,
  iconUrl,
  isMonoIcon,
  markerFallback,
  type IconManifest,
} from "./icons";
import { alphaIconUrl, palIconUrl, UNKNOWN_ICON } from "../../lib/assets";
import type { PoiPin } from "./pins";

/** Per-layer visibility toggles (persisted by MapView). `hideUnfoundEffigies`
 *  is a spoiler modifier on the effigy layer, not a layer of its own. */
export interface LayerFilters {
  fastTravel: boolean;
  alpha: boolean;
  effigies: boolean;
  bounties: boolean;
  towers: boolean;
  spawns: boolean;
  players: boolean;
  markers: boolean;
  bases: boolean;
  /** When true, only collected effigies render (spoiler protection). */
  hideUnfoundEffigies: boolean;
}

/** A player pin resolved to world coords + label (built by MapView). */
export interface PlayerPin {
  uid: string;
  label: string | null;
  x: number;
  y: number;
}

/** Content-margin the cull keeps beyond the viewport, and the pan-bucket step
 *  (both in screen px) — panning within a bucket reuses the memoized set. */
const CULL_MARGIN = 200;
const CULL_STEP = 160;

/** Below this zoom factor the non-alpha pins de-emphasize (a touch smaller +
 *  softer) so the alpha portraits and player markers lead a crowded overview.
 *  Fit lands near k≈0.15, so the default view reads as an overview. */
const LOW_ZOOM_K = 0.28;

/** Token hexes (index.css) used for pin tints — kept in code (not Tailwind
 *  classes) because they drive the CSS-mask fill, inline SVG fills + glows. */
const CYAN = "#74d3e6"; // el-ice — unlocked fast travel, tower/dungeon
const GREEN = "#6ec25a"; // el-leaf — unfound effigy (actionable)
const PURPLE = "#8a68d6"; // el-dark — bounty
const AMBER = "#f0a94a"; // player / base
const DIM = "#63717f"; // ink-faint — locked / found-and-done
const MARKER = "#dcc19a"; // warm neutral — custom map markers
const TOWER = "#e06a5e"; // soft crimson (el-fire family) — syndicate tower landmark

/** The alpha portrait size — non-pal glyphs now render full-bleed at this scale. */
const ALPHA_SIZE = 34;

/** Pin screen-scale curve (Map Wave 3 / contract T2). Pins render at BASE size
 *  for k <= 1 (100%) and below — constant screen size when zoomed out, so a
 *  100% pin never shrinks in the overview — then grow SUB-linearly above 100%
 *  (k^0.45, capped ~1.5x) so pixel-peeping enlarges landmarks gently instead of
 *  linearly. Emitted as ONE inherited container CSS var; never per-pin JS. */
export function pinZoomScale(k: number): number {
  if (k <= 1) return 1;
  return Math.min(Math.pow(k, 0.45), 1.5);
}

/** Low-zoom de-emphasis + zoom growth for the dimmable pins (markers / POIs),
 *  driven by the container's `--pin-*` custom props (set once on the positioning
 *  container, inherited by every pin — no per-pin state). The `var()` fallbacks
 *  keep it a no-op if the props are unset. The transition eases the settle snap
 *  from the mid-gesture container scale to the sub-linear s(k). */
const DIM_STYLE: CSSProperties = {
  transform: "scale(calc(var(--pin-dim-scale, 1) * var(--pin-zoom-scale, 1)))",
  opacity: "var(--pin-dim-op, 1)",
};

/** Zoom growth only (no low-zoom de-emphasis) for the lead pins — alpha
 *  portraits, towers, bases — that should stay full strength in the overview. */
const ZOOM_STYLE: CSSProperties = {
  transform: "scale(var(--pin-zoom-scale, 1))",
};

/** A single icon glyph: a `mono` silhouette painted as a CSS mask filled with
 *  `tint` (alpha-only, so it tints regardless of the source's own color), or
 *  colored art rendered as-is. The heart of the mono tint pipeline (contract X2). */
function Glyph({
  src,
  mono,
  tint,
  size,
  dim = 1,
  grayscale = false,
}: {
  src: string;
  mono: boolean;
  tint: string;
  size: number;
  dim?: number;
  grayscale?: boolean;
}) {
  if (mono) {
    return (
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          opacity: dim,
          backgroundColor: tint,
          WebkitMaskImage: `url("${src}")`,
          maskImage: `url("${src}")`,
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
        }}
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      width={size}
      height={size}
      className={`pointer-events-none select-none object-contain ${grayscale ? "grayscale" : ""}`}
      style={{
        width: size,
        height: size,
        opacity: dim,
      }}
    />
  );
}

/** A full-bleed icon glyph (no chip backing — the art fills the pin footprint,
 *  matching the pal-portrait size). Legibility over any terrain comes from a
 *  stacked drop-shadow on the WRAPPER: filters apply before masks, so the
 *  shadow must sit outside the masked mono glyph to shadow the silhouette.
 *  `glow` adds a soft colored halo (unfound effigy / unreached tower). */
function GlyphChip({
  src,
  mono,
  tint,
  size,
  dim = 1,
  grayscale = false,
  glow,
  title,
}: {
  src: string | null;
  mono: boolean;
  tint: string;
  size: number;
  dim?: number;
  grayscale?: boolean;
  glow?: string;
  title?: string;
}) {
  if (!src) return null;
  const shadow =
    "drop-shadow(0 1px 1.5px rgba(0,0,0,0.9)) drop-shadow(0 0 1px rgba(0,0,0,0.85))";
  return (
    <span
      title={title}
      className="relative flex items-center justify-center"
      style={{
        width: size,
        height: size,
        filter: glow ? `${shadow} drop-shadow(0 0 6px ${glow})` : shadow,
      }}
    >
      <Glyph src={src} mono={mono} tint={tint} size={size} dim={dim} grayscale={grayscale} />
    </span>
  );
}

/** Resolve a POI-type pin to its chip glyph (manifest PNG, else tinted vector),
 *  honoring the mono tint pipeline + per-kind found/unfound state. */
function PinTypeIcon({
  pin,
  icons,
}: {
  pin: PoiPin;
  icons: IconManifest | null;
}) {
  if (pin.kind === "fast_travel") {
    const tint = pin.found ? CYAN : DIM;
    const entry = icons?.fast_travel ?? null;
    return (
      <GlyphChip
        src={entry ? iconUrl(entry) : fallbackIcon("fast_travel", tint)}
        mono={isMonoIcon(icons, "fast_travel")}
        tint={tint}
        size={56}
        dim={pin.found ? 1 : 0.7}
        grayscale={!pin.found}
        title={pin.found ? "Fast travel · unlocked" : "Fast travel · locked"}
      />
    );
  }
  if (pin.kind === "effigy") {
    // Real green Lifmunk statuette (colored art) on a chip: unfound = full color
    // + faint green glow (actionable); found = grayscale + dimmed, NO badge (the
    // dimming + tooltip carry the state; a ✓ badge read as "the icon is a check").
    const entry = icons?.effigy ?? null;
    return (
      <GlyphChip
        src={entry ? iconUrl(entry) : fallbackIcon("effigy", pin.found ? DIM : GREEN)}
        mono={isMonoIcon(icons, "effigy")}
        tint={GREEN}
        size={ALPHA_SIZE}
        grayscale={pin.found}
        dim={pin.found ? 0.45 : 1}
        glow={pin.found ? undefined : GREEN}
        title={pin.found ? "Lifmunk Effigy · collected" : "Lifmunk Effigy"}
      />
    );
  }
  if (pin.kind === "tower") {
    // Syndicate tower — a major landmark. Colored compass-tower art on a large
    // chip: not-reached = full color + faint crimson glow (a boss target);
    // reached = grayscale + dimmed (mirrors the found-effigy done treatment).
    // "Reached" (not "conquered") is honest: the save's only per-tower flag is
    // the FindAreaFlagMap `Tower_<Region>` area-reached boolean (TowerData/T1),
    // not a boss-defeat flag.
    const entry = icons?.tower ?? null;
    return (
      <GlyphChip
        src={entry ? iconUrl(entry) : fallbackIcon("tower", pin.found ? DIM : TOWER)}
        mono={isMonoIcon(icons, "tower")}
        tint={TOWER}
        size={60}
        grayscale={pin.found}
        dim={pin.found ? 0.8 : 1}
        glow={pin.found ? undefined : TOWER}
        title={
          pin.found
            ? `Tower · reached${pin.name ? ` · ${pin.name}` : ""}`
            : pin.name
              ? `Tower · ${pin.name}`
              : "Syndicate Tower"
        }
      />
    );
  }
  // bounty — purple-hooded colored art on a chip; name tooltip handled by caller.
  const entry = icons?.bounty ?? null;
  return (
    <GlyphChip
      src={entry ? iconUrl(entry) : fallbackIcon("bounty", PURPLE)}
      mono={isMonoIcon(icons, "bounty")}
      tint={PURPLE}
      size={56}
      title={pin.name ? `Bounty · ${pin.name}` : "Bounty"}
    />
  );
}

/** Palbox-style circular ring-clipped alpha portrait (abyss ring, amber on
 *  hover), with the pal-icon fallback the rest of the app uses. */
function AlphaPortrait({
  speciesId,
  size,
}: {
  speciesId: string | null;
  size: number;
}) {
  const [failed, setFailed] = useState(false);
  const src = speciesId && !failed ? palIconUrl(speciesId) : UNKNOWN_ICON;
  return (
    <span
      className="block overflow-hidden rounded-full bg-abyss/70 ring-2 ring-abyss shadow-[0_1px_4px_rgba(0,0,0,0.6)] transition-[box-shadow,transform] group-hover:-translate-y-0.5 group-hover:ring-amber/80"
      style={{ width: size, height: size }}
    >
      <img
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-contain"
      />
    </span>
  );
}

/** The species-mode PalHoverCard context strip for an alpha pin. */
function AlphaNote({ level }: { level?: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <img
        src={alphaIconUrl}
        alt=""
        aria-hidden
        draggable={false}
        width={13}
        height={13}
        className="h-[13px] w-[13px] shrink-0 object-contain"
      />
      <span className="font-semibold text-amber-bright">Alpha Pal</span>
      {level != null && (
        <>
          <span className="text-ink-faint">·</span>
          <span className="tabular-nums text-ink">Lv {level}</span>
        </>
      )}
    </span>
  );
}

/** One alpha (field-boss) pin: a circular portrait + alpha badge, wrapped in the
 *  rich PalHoverCard (species info + alpha context). Click opens the dex. */
function AlphaPin({
  pin,
  left,
  top,
  icons,
  onOpenSpecies,
}: {
  pin: PoiPin;
  left: number;
  top: number;
  icons: IconManifest | null;
  onOpenSpecies: (id: string) => void;
}) {
  const badgeSrc = icons?.alpha_badge
    ? iconUrl(icons.alpha_badge)
    : fallbackIcon("alpha_badge", AMBER);
  const button = (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => pin.speciesId && onOpenSpecies(pin.speciesId)}
      className="group pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
      style={{ left, top }}
      aria-label={`Alpha Pal${pin.level != null ? `, level ${pin.level}` : ""}`}
    >
      <span className="relative block transition-transform duration-150 ease-out" style={ZOOM_STYLE}>
        <AlphaPortrait speciesId={pin.speciesId ?? null} size={ALPHA_SIZE} />
        {badgeSrc && (
          <span
            aria-hidden
            className="pointer-events-none absolute -left-1 -top-1 block"
          >
            <Glyph
              src={badgeSrc}
              mono={isMonoIcon(icons, "alpha_badge")}
              tint={AMBER}
              size={15}
            />
          </span>
        )}
      </span>
    </button>
  );
  // PalHoverCard needs a species id; every field boss has one, but degrade to a
  // bare (still clickable) pin if it is somehow missing rather than crash.
  if (!pin.speciesId) return button;
  return (
    <PalHoverCard speciesId={pin.speciesId} note={<AlphaNote level={pin.level} />}>
      {button}
    </PalHoverCard>
  );
}

function PinLayer({
  entry,
  layer,
  k,
  tx,
  ty,
  vw,
  vh,
  pois,
  players,
  markers,
  bases,
  fog,
  fogOn,
  showHidden,
  filters,
  icons,
  onOpenSpecies,
  containerRef,
}: {
  entry: MapEntry;
  layer: string;
  k: number;
  tx: number;
  ty: number;
  vw: number;
  vh: number;
  pois: PoiPin[];
  players: PlayerPin[];
  markers: { x: number; y: number; icon_type: number }[];
  bases: { x: number; y: number }[];
  fog: FogMask | null;
  fogOn: boolean;
  showHidden: boolean;
  filters: LayerFilters;
  icons: IconManifest | null;
  onOpenSpecies: (id: string) => void;
  /** MapView-owned handle on the positioning container: MapView writes its
   *  `style.transform` imperatively during a wheel gesture (scale-about-focal)
   *  so this layer never re-renders per tick. Optional/additive. */
  containerRef?: RefObject<HTMLDivElement | null>;
}) {
  const [W, H] = entry.px;
  // Coarse pan bucket: the cull set only recomputes when the pan crosses a
  // bucket boundary; within a bucket the container transform does the work.
  const bx = Math.round(tx / CULL_STEP);
  const by = Math.round(ty / CULL_STEP);
  const lowZoom = k < LOW_ZOOM_K;

  // Fog spoiler test: a pin in an unrevealed cell is hidden unless it is already
  // known to the player (unlocked fast travel / found effigy) or the override.
  const spoilerHidden = (worldX: number, worldY: number, known: boolean) => {
    if (!fogOn || !fog || known || showHidden) return false;
    const [u, v] = worldToPx(entry, worldX, worldY);
    return !isRevealed(fog, u / W, v / H);
  };

  // Visible POI pins for the active layer, culled to the viewport + margin.
  const visiblePois = useMemo(() => {
    const minU = (-tx - CULL_MARGIN) / k;
    const minV = (-ty - CULL_MARGIN) / k;
    const maxU = (vw - tx + CULL_MARGIN) / k;
    const maxV = (vh - ty + CULL_MARGIN) / k;
    const out: { pin: PoiPin; left: number; top: number }[] = [];
    for (const pin of pois) {
      if (pin.map !== layer) continue;
      if (pin.kind === "fast_travel" && !filters.fastTravel) continue;
      if (pin.kind === "alpha" && !filters.alpha) continue;
      if (pin.kind === "effigy" && !filters.effigies) continue;
      // Spoiler modifier: hide effigies the scoped player hasn't collected, even
      // in revealed terrain (the location itself is the spoiler).
      if (pin.kind === "effigy" && filters.hideUnfoundEffigies && !pin.found)
        continue;
      if (pin.kind === "bounty" && !filters.bounties) continue;
      if (pin.kind === "tower" && !filters.towers) continue;
      const [u, v] = worldToPx(entry, pin.x, pin.y);
      if (u < minU || u > maxU || v < minV || v > maxV) continue;
      if (spoilerHidden(pin.x, pin.y, pin.known)) continue;
      out.push({ pin, left: u * k, top: v * k });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pois, layer, k, bx, by, vw, vh, filters, fog, fogOn, showHidden, entry]);

  // Players + markers (few) — same coordinate + spoiler rules; always known.
  const visiblePlayers = useMemo(() => {
    if (!filters.players) return [];
    return players
      .filter((p) => worldInBounds(entry, p.x, p.y))
      .map((p) => {
        const [u, v] = worldToPx(entry, p.x, p.y);
        return { p, left: u * k, top: v * k };
      });
  }, [players, filters.players, k, entry]);

  const visibleMarkers = useMemo(() => {
    if (!filters.markers) return [];
    return markers
      .filter((m) => worldInBounds(entry, m.x, m.y))
      .map((m, i) => {
        const [u, v] = worldToPx(entry, m.x, m.y);
        return { m, i, left: u * k, top: v * k };
      });
  }, [markers, filters.markers, k, entry]);

  // Player base camps — the player's OWN bases, so never fog-gated (no spoiler
  // to hide): shown whenever the Bases layer is on and the coord lands in the
  // active layer's world bounds (base coords are overworld / MainMap).
  const visibleBases = useMemo(() => {
    if (!filters.bases) return [];
    return bases
      .filter((b) => worldInBounds(entry, b.x, b.y))
      .map((b, i) => {
        const [u, v] = worldToPx(entry, b.x, b.y);
        return { i, left: u * k, top: v * k };
      });
  }, [bases, filters.bases, k, entry]);

  const containerStyle = {
    transform: `translate(${tx}px, ${ty}px)`,
    "--pin-dim-scale": lowZoom ? "0.8" : "1",
    "--pin-dim-op": lowZoom ? "0.85" : "1",
    // Pin screen-scale (T2): 1 at/below 100%, sub-linear growth above. Committed
    // on render (settle/fit/layer-switch/zoom-button); inherited by every pin.
    "--pin-zoom-scale": String(pinZoomScale(k)),
  } as CSSProperties;

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    >
      <div
        ref={containerRef}
        className="absolute left-0 top-0 origin-top-left"
        style={containerStyle}
      >
        {visibleMarkers.map(({ m, i, left, top }) => {
          const key = `marker_${m.icon_type}`;
          const entryIcon = icons?.[key] ?? null;
          return (
            <div
              key={`mk${i}`}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
            >
              <span className="block transition-[transform,opacity] duration-150 ease-out" style={DIM_STYLE}>
                <GlyphChip
                  src={entryIcon ? iconUrl(entryIcon) : markerFallback(MARKER)}
                  mono={entryIcon ? isMonoIcon(icons, key) : false}
                  tint={MARKER}
                  size={28}
                  title="Custom marker"
                />
              </span>
            </div>
          );
        })}

        {visibleBases.map(({ i, left, top }) => {
          const entryIcon = icons?.base ?? null;
          return (
            <div
              key={`bs${i}`}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
            >
              <span className="block transition-transform duration-150 ease-out" style={ZOOM_STYLE}>
                <GlyphChip
                  src={entryIcon ? iconUrl(entryIcon) : fallbackIcon("base", AMBER)}
                  mono={isMonoIcon(icons, "base")}
                  tint={AMBER}
                  size={32}
                  title="Base camp"
                />
              </span>
            </div>
          );
        })}

        {visiblePois.map(({ pin, left, top }) =>
          pin.kind === "alpha" ? (
            <AlphaPin
              key={pin.key}
              pin={pin}
              left={left}
              top={top}
              icons={icons}
              onOpenSpecies={onOpenSpecies}
            />
          ) : (
            <div
              key={pin.key}
              className="group pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
            >
              <span
                className="block transition-[transform,opacity] duration-150 ease-out"
                style={pin.kind === "tower" ? ZOOM_STYLE : DIM_STYLE}
              >
                <PinTypeIcon pin={pin} icons={icons} />
              </span>
              {pin.name && (
                <span className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-xs border border-line bg-panel/90 px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-ink opacity-0 transition-opacity group-hover:opacity-100">
                  {pin.name}
                </span>
              )}
            </div>
          ),
        )}

        {visiblePlayers.map(({ p, left, top }) => (
          <div
            key={p.uid}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
            style={{ left, top }}
          >
            <span
              className="h-3 w-3 rounded-full border-2 border-abyss"
              style={{ background: AMBER, boxShadow: `0 0 0 1px ${AMBER}80` }}
            />
            {p.label && (
              <span className="mt-1 whitespace-nowrap rounded-xs border border-line bg-panel/90 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-ink">
                {p.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Memoized: MapView re-renders on every mousemove (coordinate readout) and
// spawnHover; with a stable onOpenSpecies (useCallback) + memoized pin arrays,
// none of those touch the 360 pins. It also hardens MapPerf's gesture — a stray
// re-render can't clobber the imperatively-written container transform.
export default memo(PinLayer);
