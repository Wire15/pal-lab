// The POI pin overlay: a screen-space DOM layer above the map canvas. Pins are
// positioned in *content* px (`worldToPx · k`) inside a container that carries
// only the pan translate, so a pan updates one transform (GPU-composited) and
// never re-lays-out the pins — 150+ pins stay smooth while panning. The visible
// set is culled to the viewport (plus a margin) and only recomputed when the
// pan crosses a coarse bucket, so the cull never costs per-frame work.
//
// Pins render at a constant screen size (they live in a translate-only, never
// scaled, container). Found/unfound coloring, the fog spoiler cull, and the
// per-layer filter toggles are all applied here.

import { useMemo } from "react";
import { worldToPx, worldInBounds, type MapEntry } from "../../lib/map-coords";
import { PalIcon } from "../../components/primitives";
import { isRevealed, type FogMask } from "./fog";
import {
  fallbackIcon,
  iconUrl,
  markerFallback,
  type IconManifest,
} from "./icons";
import type { PoiPin } from "./pins";

/** Per-layer visibility toggles (persisted by MapView). */
export interface LayerFilters {
  fastTravel: boolean;
  alpha: boolean;
  effigies: boolean;
  bounties: boolean;
  spawns: boolean;
  players: boolean;
  markers: boolean;
  bases: boolean;
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

/** Token hexes (index.css) used for pin tints — kept in code (not Tailwind
 *  classes) because they drive inline SVG fills + box-shadow glows. */
const CYAN = "#74d3e6"; // el-ice — unlocked fast travel, dungeon
const GREEN = "#6ec25a"; // el-leaf — unfound effigy (actionable)
const PURPLE = "#8a68d6"; // el-dark — bounty
const AMBER = "#f0a94a"; // player
const DIM = "#63717f"; // ink-faint — locked / found-and-done

/** A small icon img with a vector fallback; never a broken image. `real` is the
 *  manifest URL (or null), `fallback` the inline-SVG data URL. */
function PinIcon({
  real,
  fallback,
  size,
  title,
  className = "",
}: {
  real: string | null;
  fallback: string | null;
  size: number;
  title?: string;
  className?: string;
}) {
  const src = real ?? fallback;
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      title={title}
      width={size}
      height={size}
      draggable={false}
      className={`pointer-events-none select-none ${className}`}
      style={{
        width: size,
        height: size,
        filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.85))",
      }}
    />
  );
}

export default function PinLayer({
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
}) {
  const [W, H] = entry.px;
  // Coarse pan bucket: the cull set only recomputes when the pan crosses a
  // bucket boundary; within a bucket the container transform does the work.
  const bx = Math.round(tx / CULL_STEP);
  const by = Math.round(ty / CULL_STEP);

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
      if (pin.kind === "bounty" && !filters.bounties) continue;
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

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${tx}px, ${ty}px)` }}
      >
        {visibleMarkers.map(({ m, i, left, top }) => {
          const entryIcon = icons?.[`marker_${m.icon_type}`] ?? null;
          return (
            <div
              key={`mk${i}`}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
              title="Custom marker"
            >
              <PinIcon
                real={entryIcon ? iconUrl(entryIcon) : null}
                fallback={markerFallback(DIM)}
                size={20}
              />
            </div>
          );
        })}

        {visibleBases.map(({ i, left, top }) => (
          <div
            key={`bs${i}`}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left, top }}
            title="Base camp"
          >
            <PinIcon
              real={icons?.base ? iconUrl(icons.base) : null}
              fallback={fallbackIcon("base", AMBER)}
              size={22}
            />
          </div>
        ))}

        {visiblePois.map(({ pin, left, top }) =>
          pin.kind === "alpha" ? (
            <button
              key={pin.key}
              type="button"
              onClick={() => pin.speciesId && onOpenSpecies(pin.speciesId)}
              className="group pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center focus:outline-none"
              style={{ left, top }}
              title={`Alpha${pin.level ? ` · Lv ${pin.level}` : ""}`}
            >
              <span className="relative block">
                <PalIcon
                  id={pin.speciesId ?? null}
                  size={30}
                  className="!rounded-full ring-2 ring-abyss group-hover:ring-amber/70"
                />
                {/* Alpha badge, lower-right. */}
                <span className="absolute -bottom-0.5 -right-0.5 block">
                  <PinIcon
                    real={icons?.alpha_badge ? iconUrl(icons.alpha_badge) : null}
                    fallback={fallbackIcon("alpha_badge", CYAN)}
                    size={12}
                  />
                </span>
              </span>
              {pin.level != null && (
                <span className="pointer-events-none mt-0.5 rounded-xs border border-line bg-panel/90 px-1 font-mono text-[9px] tabular-nums text-ink opacity-0 transition-opacity group-hover:opacity-100">
                  Lv {pin.level}
                </span>
              )}
            </button>
          ) : (
            <div
              key={pin.key}
              className="group pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
            >
              <PinTypeIcon pin={pin} icons={icons} />
              {pin.name && (
                <span className="pointer-events-none absolute left-1/2 top-full mt-0.5 -translate-x-1/2 whitespace-nowrap rounded-xs border border-line bg-panel/90 px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-ink opacity-0 transition-opacity group-hover:opacity-100">
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

/** Non-alpha POI glyph (fast travel / effigy / bounty) with found/unfound tint. */
function PinTypeIcon({
  pin,
  icons,
}: {
  pin: PoiPin;
  icons: IconManifest | null;
}) {
  if (pin.kind === "fast_travel") {
    const color = pin.found ? CYAN : DIM;
    const entryIcon = icons?.fast_travel ?? null;
    return (
      <span
        className="block transition-opacity"
        style={{ opacity: pin.found ? 1 : 0.55 }}
      >
        <PinIcon
          real={entryIcon ? iconUrl(entryIcon) : null}
          fallback={fallbackIcon("fast_travel", color)}
          size={24}
          title={pin.found ? "Fast travel · unlocked" : "Fast travel · locked"}
        />
      </span>
    );
  }
  if (pin.kind === "effigy") {
    const color = pin.found ? DIM : GREEN;
    const entryIcon = icons?.effigy ?? null;
    return (
      <span
        className="relative block transition-opacity"
        style={{ opacity: pin.found ? 0.5 : 1 }}
      >
        <PinIcon
          real={entryIcon ? iconUrl(entryIcon) : null}
          fallback={fallbackIcon("effigy", color)}
          size={22}
          title={pin.found ? "Effigy · collected" : "Effigy"}
          className={pin.found ? "grayscale" : ""}
        />
        {pin.found && (
          <span
            className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full text-[8px] font-bold"
            style={{ background: GREEN, color: "#0d1117" }}
          >
            ✓
          </span>
        )}
      </span>
    );
  }
  // bounty
  const entryIcon = icons?.bounty ?? null;
  return (
    <PinIcon
      real={entryIcon ? iconUrl(entryIcon) : null}
      fallback={fallbackIcon("bounty", PURPLE)}
      size={24}
      title="Bounty"
    />
  );
}
