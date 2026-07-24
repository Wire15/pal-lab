// The World Map view: a pannable / zoomable render of the Palworld world map
// with a spoiler-proof fog-of-war overlay, an in-game-style POI pin system
// (fast travel / alpha pals / effigies / bounties / custom markers / players),
// a per-layer filter panel, and a species spawn-heat overlay. The map image is
// 8192x8192, so the base map + fog + spawn heat draw to a <canvas> under a
// viewport transform (the same hand-rolled pan/zoom as the Solver's plan graph);
// the interactive POI pins ride a thin screen-space DOM overlay so their labels,
// hover chips, and clicks stay crisp and cheap while panning.
//
// Contracts consumed:
//   C1  public/map/map-data.json + layer webp images (MapExtract)
//       public/map/icons.json + icons/<key>.png (IconFinish) — degrades to
//       vector fallbacks when absent
//   R1  map-data.json fast_travel/effigies carry a per-POI `guid` (32-char
//       UPPERCASE hex) matching the save flag keys
//   R2  get_map_state(save_dir) -> MapState (incl. optional `bases`)
//   R3  the found/unlocked join (pins.ts) — a scoped player's flag set string-
//       matches a POI's guid; degrades to counts-only when no POI carries one

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "../../lib/tauri";
import { useAppState } from "../../state";
import {
  worldToPx,
  pxToWorld,
  worldToInGame,
  type MapData,
  type MapEntry,
} from "../../lib/map-coords";
import { loadMapData, baseSpeciesId, isFieldBossSpawn } from "../../lib/map-data";
import type { MapState, NamedEntry } from "../../lib/types";
import { buildFogMask, type FogMask } from "./fog";
import { buildPois } from "./pins";
import { loadMapIcons, type IconManifest } from "./icons";
import PinLayer, { type LayerFilters, type PlayerPin } from "./PinLayer";
import FilterPanel from "./FilterPanel";
import SpawnSearch, { type SpawnLegend } from "./SpawnSearch";

type LayerKey = "MainMap" | "Tree";

const LAYERS: { key: LayerKey; label: string; hint: string }[] = [
  { key: "MainMap", label: "Palpagos", hint: "Overworld" },
  { key: "Tree", label: "World Tree", hint: "Sanctuary" },
];

// Zoom range: the map image is ~8192px, so a viewport-fit lands near k=0.12.
// 100% (k=1) is one image pixel per screen pixel; 200% is the pixel-peep cap.
const MIN_ZOOM = 0.06;
const MAX_ZOOM = 2;

// Spawn-heat fills: warm amber for day/anytime, indigo for night-only, both at
// low alpha so overlapping spawn radii build up into a readable heat cloud.
const SPAWN_DAY = "240,169,74"; // amber
const SPAWN_NIGHT = "138,104,214"; // el-dark indigo

const FILTERS_KEY = "pal-calc.mapFilters";
const SHOW_HIDDEN_KEY = "pal-calc.mapShowHidden";

const DEFAULT_FILTERS: LayerFilters = {
  fastTravel: true,
  alpha: true,
  effigies: true,
  bounties: true,
  spawns: true,
  players: true,
  markers: true,
  bases: true,
};

function readFilters(): LayerFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch {
    // Ignore parse/storage failures — fall back to defaults.
  }
  return DEFAULT_FILTERS;
}

interface ViewTransform {
  k: number;
  tx: number;
  ty: number;
}

/** Clamp a zoom factor into the interaction spec's range. */
function clampZoom(k: number): number {
  return Math.min(Math.max(k, MIN_ZOOM), MAX_ZOOM);
}

/** One spawn point resolved to content px + its content-px radius, for both the
 *  canvas heat draw and the pointer hover hit-test. */
interface SpawnDot {
  u: number;
  v: number;
  r: number;
  night: boolean;
  lv: [number, number];
  n: [number, number];
  time: string | null;
}

export default function MapView() {
  const {
    saveDir,
    saveSummary,
    playerScope,
    requestDex,
    mapSpawnTarget,
    clearMapSpawnTarget,
  } = useAppState();

  const [mapData, setMapData] = useState<MapData | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [layer, setLayer] = useState<LayerKey>("MainMap");
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [imgLoading, setImgLoading] = useState(true);
  const [imgError, setImgError] = useState<string | null>(null);

  const [mapState, setMapState] = useState<MapState | null>(null);
  const [fogMask, setFogMask] = useState<FogMask | null>(null);
  const [fogOn, setFogOn] = useState(true);

  const [icons, setIcons] = useState<IconManifest | null>(null);
  const [speciesNames, setSpeciesNames] = useState<NamedEntry[]>([]);
  const [filters, setFilters] = useState<LayerFilters>(readFilters);
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [spawnSpecies, setSpawnSpecies] = useState<string | null>(null);
  const [spawnHover, setSpawnHover] = useState<{
    sx: number;
    sy: number;
    dot: SpawnDot;
  } | null>(null);

  const [view, setView] = useState<ViewTransform>({ k: 0.1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [dragging, setDragging] = useState(false);
  const [readout, setReadout] = useState<{ x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapCache = useRef<Map<string, ImageBitmap>>(new Map());

  const entry: MapEntry | null = mapData?.maps[layer] ?? null;

  // --- Load the map manifest + icons once (shared cached loaders). ---------
  useEffect(() => {
    let alive = true;
    loadMapData()
      .then((d) => alive && setMapData(d))
      .catch((e) => alive && setDataError(String(e)));
    loadMapIcons()
      .then((m) => alive && setIcons(m))
      .catch(() => {});
    invoke<NamedEntry[]>("list_species")
      .then((n) => alive && setSpeciesNames(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // --- Persist filter + spoiler state. -------------------------------------
  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    } catch {
      // Ignore storage failures — non-fatal.
    }
  }, [filters]);
  useEffect(() => {
    try {
      localStorage.setItem(SHOW_HIDDEN_KEY, showHidden ? "1" : "0");
    } catch {
      // Ignore storage failures — non-fatal.
    }
  }, [showHidden]);

  // --- Consume a one-shot dex -> map spawn target. -------------------------
  useEffect(() => {
    if (!mapSpawnTarget) return;
    setSpawnSpecies(mapSpawnTarget);
    setFilters((f) => (f.spawns ? f : { ...f, spawns: true }));
    clearMapSpawnTarget();
  }, [mapSpawnTarget, clearMapSpawnTarget]);

  // --- Load (and cache) the active layer's image lazily. ------------------
  useEffect(() => {
    if (!entry) return;
    const url = entry.image;
    const cached = bitmapCache.current.get(url);
    if (cached) {
      setBitmap(cached);
      setImgLoading(false);
      setImgError(null);
      return;
    }
    let alive = true;
    setImgLoading(true);
    setImgError(null);
    setBitmap(null);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${url} ${r.status}`);
        return r.blob();
      })
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        if (!alive) {
          bmp.close();
          return;
        }
        bitmapCache.current.set(url, bmp);
        setBitmap(bmp);
        setImgLoading(false);
      })
      .catch((e) => {
        if (alive) {
          setImgError(String(e));
          setImgLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [entry]);

  // --- Fetch the save's map state (fog + players + markers + poi). ---------
  useEffect(() => {
    if (!saveDir) {
      setMapState(null);
      return;
    }
    let alive = true;
    invoke<MapState>("get_map_state", { saveDir })
      .then((s) => alive && setMapState(s))
      .catch(() => alive && setMapState(null));
    return () => {
      alive = false;
    };
  }, [saveDir]);

  // --- Build the fog mask for the active layer when state/layer changes. ---
  const activeFog = useMemo(
    () => mapState?.fog?.find((f) => f.map === layer) ?? null,
    [mapState, layer],
  );
  useEffect(() => {
    if (!activeFog) {
      setFogMask(null);
      return;
    }
    let alive = true;
    buildFogMask(activeFog)
      .then((m) => alive && setFogMask(m))
      .catch(() => alive && setFogMask(null));
    return () => {
      alive = false;
    };
  }, [activeFog]);

  const fogAvailable = activeFog !== null;
  const fogDrawn = fogOn && fogAvailable && fogMask?.layer === layer;

  // --- POI pins + counts (C3 join), rebuilt on data/state/scope change. ----
  const { pins, counts } = useMemo(() => {
    if (!mapData) {
      return {
        pins: [],
        counts: {
          fastTravel: { found: 0, total: 0 },
          effigies: { found: 0, total: 0 },
          bounties: 0,
          alphas: 0,
          joined: false,
        },
      };
    }
    return buildPois(mapData, mapState, playerScope);
  }, [mapData, mapState, playerScope]);
  const hasBounties = (mapData?.bounties?.length ?? 0) > 0;

  // --- Player pins (resolve nicknames from the cached summary). ------------
  const players = useMemo<PlayerPin[]>(() => {
    if (!mapState) return [];
    const nameByUid = new Map(
      saveSummary?.players.map((p) => [p.uid, p.name]) ?? [],
    );
    return mapState.players
      .filter((p) => p.x !== null && p.y !== null)
      .map((p) => ({
        uid: p.uid,
        label: p.nickname ?? nameByUid.get(p.uid) ?? null,
        x: p.x as number,
        y: p.y as number,
      }));
  }, [mapState, saveSummary]);

  // --- Spawnable species options for the search combobox. ------------------
  const spawnOptions = useMemo(() => {
    if (!mapData) return [];
    const nameById = new Map(speciesNames.map((n) => [n.id, n.name]));
    const ids = new Set(
      mapData.spawns
        .filter((s) => !isFieldBossSpawn(s.species))
        .map((s) => baseSpeciesId(s.species)),
    );
    return [...ids]
      .map((id) => ({ id, name: nameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [mapData, speciesNames]);
  const spawnName = useMemo(
    () => spawnOptions.find((o) => o.id === spawnSpecies)?.name ?? null,
    [spawnOptions, spawnSpecies],
  );

  // --- Resolved spawn dots (content px) for the active species + layer. ----
  const spawnDots = useMemo<SpawnDot[]>(() => {
    if (!mapData || !entry || !spawnSpecies) return [];
    const sx = entry.px[0] / (entry.world_max[1] - entry.world_min[1]); // px per world unit (u axis)
    const dots: SpawnDot[] = [];
    for (const s of mapData.spawns) {
      if (
        s.map !== layer ||
        isFieldBossSpawn(s.species) ||
        baseSpeciesId(s.species) !== spawnSpecies
      )
        continue;
      for (const p of s.points) {
        const [u, v] = worldToPx(entry, p.x, p.y);
        dots.push({
          u,
          v,
          r: Math.max(p.r * sx, entry.px[0] * 0.0015),
          night: p.time === "night",
          lv: p.lv,
          n: p.n,
          time: p.time,
        });
      }
    }
    return dots;
  }, [mapData, entry, spawnSpecies, layer]);
  const spawnActive = filters.spawns && spawnDots.length > 0;

  const spawnLegend = useMemo<SpawnLegend | null>(() => {
    if (spawnDots.length === 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    let hasDay = false;
    let hasNight = false;
    for (const d of spawnDots) {
      lo = Math.min(lo, d.lv[0]);
      hi = Math.max(hi, d.lv[1]);
      if (d.night) hasNight = true;
      else hasDay = true;
    }
    return { count: spawnDots.length, lv: [lo, hi], hasDay, hasNight };
  }, [spawnDots]);

  // --- Fit the map into the viewport (centered, padded). -------------------
  const fit = useCallback(() => {
    const el = canvasRef.current;
    if (!el || !entry) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    if (vw === 0 || vh === 0) return;
    const [W, H] = entry.px;
    const pad = 24;
    const k = clampZoom(Math.min((vw - 2 * pad) / W, (vh - 2 * pad) / H));
    setView({ k, tx: (vw - W * k) / 2, ty: (vh - H * k) / 2 });
  }, [entry]);

  useLayoutEffect(() => {
    if (bitmap) fit();
  }, [bitmap, layer, fit]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewport({ w: el.clientWidth, h: el.clientHeight });
      fit();
    });
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [fit]);

  // --- Canvas paint: map -> spawn heat -> fog, under the viewport transform. -
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !entry) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(canvas.clientWidth * dpr);
    const bh = Math.round(canvas.clientHeight * dpr);
    if (bw === 0 || bh === 0) return;
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0d1117"; // abyss backdrop (ocean beyond the map)
    ctx.fillRect(0, 0, bw, bh);
    if (!bitmap) return;

    const { k, tx, ty } = viewRef.current;
    ctx.setTransform(k * dpr, 0, 0, k * dpr, tx * dpr, ty * dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const [W, H] = entry.px;
    ctx.drawImage(bitmap, 0, 0, W, H);

    // Spawn heat — drawn before fog so points in fogged terrain are covered
    // (the spoiler rule for free); revealed clusters read as soft heat blobs.
    if (spawnActive) {
      for (const d of spawnDots) {
        const rgb = d.night ? SPAWN_NIGHT : SPAWN_DAY;
        ctx.beginPath();
        ctx.arc(d.u, d.v, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},0.11)`;
        ctx.fill();
        ctx.lineWidth = Math.max(1.5 / k, d.r * 0.03);
        ctx.strokeStyle = `rgba(${rgb},0.5)`;
        ctx.stroke();
      }
    }

    if (fogDrawn && fogMask) {
      // Near-opaque, pre-blurred fog stretched to the content box; the bilinear
      // upscale + baked blur dissolve the mask blocks into soft cloud edges.
      ctx.drawImage(fogMask.blurred, 0, 0, W, H);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [entry, bitmap, fogDrawn, fogMask, spawnActive, spawnDots]);

  useEffect(() => {
    const raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [paint, view]);

  // --- Wheel zoom to cursor (native non-passive so page scroll is blocked). -
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const nk = clampZoom(v.k * Math.exp(-e.deltaY * 0.0015));
        if (nk === v.k) return v;
        const contentX = (cx - v.tx) / v.k;
        const contentY = (cy - v.ty) / v.k;
        return { k: nk, tx: cx - contentX * nk, ty: cy - contentY * nk };
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // --- Background pan (engage past a 4px threshold). -----------------------
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const base = viewRef.current;
    let panning = false;
    function move(ev: PointerEvent) {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!panning && Math.hypot(dx, dy) < 4) return;
      if (!panning) {
        panning = true;
        setDragging(true);
        setSpawnHover(null);
      }
      setView({ k: base.k, tx: base.tx + dx, ty: base.ty + dy });
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  // --- Cursor coordinate readout + spawn hover hit-test. -------------------
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!entry) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const v = viewRef.current;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const contentX = (cx - v.tx) / v.k;
      const contentY = (cy - v.ty) / v.k;
      const [wx, wy] = pxToWorld(entry, contentX, contentY);
      setReadout(worldToInGame(wx, wy));

      if (spawnActive && !dragging) {
        let hit: SpawnDot | null = null;
        let bestSq = Infinity;
        for (const d of spawnDots) {
          const dx = d.u - contentX;
          const dy = d.v - contentY;
          const sq = dx * dx + dy * dy;
          if (sq <= d.r * d.r && sq < bestSq) {
            bestSq = sq;
            hit = d;
          }
        }
        setSpawnHover(hit ? { sx: cx, sy: cy, dot: hit } : null);
      } else if (spawnHover) {
        setSpawnHover(null);
      }
    },
    [entry, spawnActive, spawnDots, dragging, spawnHover],
  );

  const zoomBy = useCallback((mult: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((v) => {
      const nk = clampZoom(v.k * mult);
      if (nk === v.k) return v;
      const contentX = (cx - v.tx) / v.k;
      const contentY = (cy - v.ty) / v.k;
      return { k: nk, tx: cx - contentX * nk, ty: cy - contentY * nk };
    });
  }, []);

  const setFilter = useCallback((key: keyof LayerFilters, on: boolean) => {
    setFilters((f) => ({ ...f, [key]: on }));
  }, []);

  const ctrlBtn =
    "flex h-8 w-8 items-center justify-center border-b border-line text-ink-dim transition-colors last:border-b-0 hover:bg-hover hover:text-ink";

  return (
    <div className="flex h-full flex-col">
      {/* Header: eyebrow / title / layer tabs, overlay controls on the right. */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-panel/60 px-6 pb-4 pt-5">
        <div className="flex items-center gap-4">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
              World Map
            </div>
            <h1 className="font-display text-xl font-bold tracking-wide text-ink">
              {LAYERS.find((l) => l.key === layer)?.label}
            </h1>
          </div>
          <div className="flex items-center overflow-hidden rounded-md border border-line">
            {LAYERS.map((l) => {
              const active = l.key === layer;
              return (
                <button
                  key={l.key}
                  onClick={() => setLayer(l.key)}
                  aria-pressed={active}
                  title={l.hint}
                  className={`select-none border-l border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors first:border-l-0 ${
                    active
                      ? "bg-raised text-amber"
                      : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                  }`}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Spawn search / legend. */}
          {mapData && (
            <SpawnSearch
              options={spawnOptions}
              selectedId={spawnSpecies}
              selectedName={spawnName}
              legend={spawnLegend}
              onSelect={setSpawnSpecies}
              onClear={() => setSpawnSpecies(null)}
              onOpenDex={(id) => requestDex(id)}
            />
          )}

          {/* Filter popover. */}
          {mapData && (
            <div className="relative">
              <button
                onClick={() => setFilterOpen((o) => !o)}
                aria-expanded={filterOpen}
                title="Filter map layers"
                className={`flex select-none items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                  filterOpen
                    ? "border-amber/50 bg-raised text-amber"
                    : "border-line bg-raised text-ink-dim hover:bg-hover hover:text-ink"
                }`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 5h18M6 12h12M10 19h4" />
                </svg>
                Filter
              </button>
              {filterOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setFilterOpen(false)}
                  />
                  <FilterPanel
                    filters={filters}
                    setFilter={setFilter}
                    counts={counts}
                    hasBounties={hasBounties}
                    spawnLabel={spawnActive ? (spawnName ?? spawnSpecies) : null}
                    playerCount={players.length}
                    markerCount={mapState?.markers.length ?? 0}
                    basesCount={mapState?.bases?.length ?? 0}
                    fogOn={fogDrawn}
                    showHidden={showHidden}
                    setShowHidden={setShowHidden}
                  />
                </>
              )}
            </div>
          )}

          {/* Fog controls (only with a save loaded). */}
          {saveDir && (
            <>
              {fogAvailable && activeFog && (
                <span
                  className="rounded-xs border border-line bg-abyss/60 px-2 py-1 font-mono text-[11px] tabular-nums text-ink-dim"
                  title="Share of this map you have revealed"
                >
                  <span className="text-amber">
                    {activeFog.revealed_pct.toFixed(1)}%
                  </span>{" "}
                  <span className="text-ink-faint">revealed</span>
                </span>
              )}
              <button
                onClick={() => setFogOn((f) => !f)}
                disabled={!fogAvailable}
                aria-pressed={fogAvailable && fogOn}
                title={
                  fogAvailable
                    ? "Toggle fog of war"
                    : "No local map data found for this world"
                }
                className={`select-none rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                  !fogAvailable
                    ? "cursor-not-allowed border-line bg-panel text-ink-faint/60"
                    : fogOn
                      ? "border-amber/50 bg-raised text-amber"
                      : "border-line bg-raised text-ink-dim hover:bg-hover hover:text-ink"
                }`}
              >
                Fog
              </button>
              {!fogAvailable && (
                <span className="font-mono text-[10px] tracking-wider text-ink-faint">
                  No local map data found for this world
                </span>
              )}
            </>
          )}
        </div>
      </header>

      {/* Map surface. */}
      <div className="relative flex-1 overflow-hidden bg-abyss">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={() => {
            setReadout(null);
            setSpawnHover(null);
          }}
          aria-label={`World map, ${LAYERS.find((l) => l.key === layer)?.label} layer`}
          className={`absolute inset-0 h-full w-full touch-none select-none ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        />

        {/* POI / player / marker overlay. */}
        {entry && (
          <PinLayer
            entry={entry}
            layer={layer}
            k={view.k}
            tx={view.tx}
            ty={view.ty}
            vw={viewport.w}
            vh={viewport.h}
            pois={pins}
            players={players}
            markers={mapState?.markers ?? []}
            bases={mapState?.bases ?? []}
            fog={fogMask?.layer === layer ? fogMask : null}
            fogOn={fogDrawn}
            showHidden={showHidden}
            filters={filters}
            icons={icons}
            onOpenSpecies={(id) => requestDex(id)}
          />
        )}

        {/* Spawn hover tooltip (screen space, follows the cursor). */}
        {spawnHover && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-panel/95 px-2 py-1 font-mono text-[10px] leading-relaxed text-ink shadow-lg"
            style={{ left: spawnHover.sx, top: spawnHover.sy - 10 }}
          >
            <div className="tabular-nums">
              Lv{" "}
              <span className="text-amber">
                {spawnHover.dot.lv[0] === spawnHover.dot.lv[1]
                  ? spawnHover.dot.lv[0]
                  : `${spawnHover.dot.lv[0]}\u2013${spawnHover.dot.lv[1]}`}
              </span>
            </div>
            <div className="tabular-nums text-ink-dim">
              Pack{" "}
              {spawnHover.dot.n[0] === spawnHover.dot.n[1]
                ? spawnHover.dot.n[0]
                : `${spawnHover.dot.n[0]}\u2013${spawnHover.dot.n[1]}`}
            </div>
            <div className={spawnHover.dot.night ? "text-el-dark" : "text-ink-faint"}>
              {spawnHover.dot.night ? "\u263e Night" : "\u2600 Anytime"}
            </div>
          </div>
        )}

        {/* Loading / error states. */}
        {(imgLoading || dataError || imgError) && (
          <div className="absolute inset-0 flex items-center justify-center bg-abyss/80">
            <div className="flex flex-col items-center gap-2 font-mono text-[11px] uppercase tracking-[0.24em]">
              {dataError || imgError ? (
                <span className="text-bad">Map failed to load</span>
              ) : (
                <>
                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-amber" />
                  <span className="text-ink-faint">Loading map…</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* HUD: coordinate readout + zoom %. */}
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
          <div className="rounded-md border border-line bg-panel/85 px-2.5 py-1.5 font-mono text-[11px] tabular-nums">
            <span className="text-ink-faint">X</span>{" "}
            <span className="text-ink">
              {readout ? Math.round(readout.x) : "—"}
            </span>
            <span className="mx-1.5 text-line">·</span>
            <span className="text-ink-faint">Y</span>{" "}
            <span className="text-ink">
              {readout ? Math.round(readout.y) : "—"}
            </span>
          </div>
          <div className="rounded-md border border-line bg-panel/85 px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-ink-dim">
            {Math.round(view.k * 100)}%
          </div>
        </div>

        {/* Zoom / fit cluster (mirrors the plan-graph controls). */}
        <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-md border border-line bg-panel/90">
          <button
            type="button"
            className={ctrlBtn}
            onClick={() => zoomBy(1.2)}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className={ctrlBtn}
            onClick={() => zoomBy(1 / 1.2)}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className={ctrlBtn}
            onClick={fit}
            aria-label="Fit to view"
            title="Fit to view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
