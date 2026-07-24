// The World Map view: a pannable / zoomable render of the Palworld world map
// with an optional fog-of-war overlay driven by the loaded save's client-side
// LocalData. The map image is 8192x8192, so it is drawn to a <canvas> (one
// ctx.drawImage per frame under a viewport transform) rather than the DOM — the
// pan/zoom interaction itself is the same hand-rolled pattern as the Solver's
// plan graph (wheel zooms to the cursor clamped, drag pans past a threshold,
// fit/reset control). Player pins and custom markers ride a thin DOM overlay in
// screen space so their labels stay crisp at any zoom.
//
// Contracts consumed:
//   C1  public/map/map-data.json + the layer webp images (MapExtract)
//   C2  get_map_state(save_dir) -> MapState (SaveSide)
//   C3  dev-fixtures/map-state.json served by the fixture shim (SaveSide)

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
  worldInBounds,
  type MapData,
  type MapEntry,
} from "../../lib/map-coords";

import type { FogLayer, MapState } from "../../lib/types";

type LayerKey = "MainMap" | "Tree";

const LAYERS: { key: LayerKey; label: string; hint: string }[] = [
  { key: "MainMap", label: "Palpagos", hint: "Overworld" },
  { key: "Tree", label: "World Tree", hint: "Sanctuary" },
];

// Zoom range: the map image is ~8192px, so a viewport-fit lands near k=0.12.
// 100% (k=1) is one image pixel per screen pixel; 200% is the pixel-peep cap.
const MIN_ZOOM = 0.06;
const MAX_ZOOM = 2;

// Fog compositing over fogged terrain: a neutral gray drawn with the
// `saturation` blend (drains color to grayscale) then a semi-opaque abyss tint
// (dims it). Terrain stays barely legible — the in-game unexplored feel, never
// pure black. Tuned against the fixture's revealed-region cluster.
const FOG_TINT = { r: 13, g: 17, b: 23, a: 168 }; // abyss #0d1117 @ ~0.66

interface ViewTransform {
  k: number;
  tx: number;
  ty: number;
}

/** Clamp a zoom factor into the interaction spec's range. */
function clampZoom(k: number): number {
  return Math.min(Math.max(k, MIN_ZOOM), MAX_ZOOM);
}

/** Two offscreen mask canvases for one fog layer, at the mask's native px:
 *  `gray` (opaque neutral over fogged, transparent over revealed — the
 *  saturation-blend source) and `tint` (abyss dim over fogged). */
interface FogMask {
  layer: LayerKey;
  gray: HTMLCanvasElement;
  tint: HTMLCanvasElement;
}

/** Decode a fog layer's revealed PNG into the two composite masks. Fogged =
 *  the mask's red channel below mid (contract: 0 fogged / 255 revealed). */
async function buildFogMask(fog: FogLayer): Promise<FogMask> {
  const img = new Image();
  img.src = `data:image/png;base64,${fog.revealed_png_base64}`;
  await img.decode();
  const w = fog.width;
  const h = fog.height;

  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d")!;
  sctx.drawImage(img, 0, 0, w, h);
  const px = sctx.getImageData(0, 0, w, h).data;

  const gray = document.createElement("canvas");
  gray.width = w;
  gray.height = h;
  const tint = document.createElement("canvas");
  tint.width = w;
  tint.height = h;
  const gctx = gray.getContext("2d")!;
  const tctx = tint.getContext("2d")!;
  const gImg = gctx.createImageData(w, h);
  const tImg = tctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    if (px[i * 4] >= 128) continue; // revealed -> leave both transparent
    gImg.data[i * 4] = 128;
    gImg.data[i * 4 + 1] = 128;
    gImg.data[i * 4 + 2] = 128;
    gImg.data[i * 4 + 3] = 255;
    tImg.data[i * 4] = FOG_TINT.r;
    tImg.data[i * 4 + 1] = FOG_TINT.g;
    tImg.data[i * 4 + 2] = FOG_TINT.b;
    tImg.data[i * 4 + 3] = FOG_TINT.a;
  }
  gctx.putImageData(gImg, 0, 0);
  tctx.putImageData(tImg, 0, 0);
  return { layer: fog.map, gray, tint };
}

export default function MapView() {
  const { saveDir, saveSummary } = useAppState();

  const [mapData, setMapData] = useState<MapData | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [layer, setLayer] = useState<LayerKey>("MainMap");
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [imgLoading, setImgLoading] = useState(true);
  const [imgError, setImgError] = useState<string | null>(null);

  const [mapState, setMapState] = useState<MapState | null>(null);
  const [fogMask, setFogMask] = useState<FogMask | null>(null);
  const [fogOn, setFogOn] = useState(true);

  const [view, setView] = useState<ViewTransform>({ k: 0.1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [dragging, setDragging] = useState(false);
  const [readout, setReadout] = useState<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapCache = useRef<Map<string, ImageBitmap>>(new Map());

  const entry: MapEntry | null = mapData?.maps[layer] ?? null;

  // --- Load the map manifest once. ----------------------------------------
  useEffect(() => {
    let alive = true;
    fetch("/map/map-data.json")
      .then((r) => {
        if (!r.ok) throw new Error(`map-data.json ${r.status}`);
        return r.json() as Promise<MapData>;
      })
      .then((d) => alive && setMapData(d))
      .catch((e) => alive && setDataError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

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

  // --- Fetch the save's map state (fog + players + markers). ---------------
  // No save loaded -> no fetch, no fog controls. The fixture shim serves this
  // in browser dev once a save is loaded; a missing shim degrades to no-fog.
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

  // --- Build the fog masks for the active layer when state/layer changes. --
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

  // Fit on first image and on every layer switch.
  useLayoutEffect(() => {
    if (bitmap) fit();
  }, [bitmap, layer, fit]);

  // Refit on viewport resize (also delivers the first real measure).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // --- Canvas paint. Reads the live view from a ref; the effect below
  //     re-schedules it (rAF-coalesced) whenever any input changes. ---------
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

    if (fogDrawn && fogMask) {
      ctx.globalCompositeOperation = "saturation";
      ctx.drawImage(fogMask.gray, 0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(fogMask.tint, 0, 0, W, H);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [entry, bitmap, fogDrawn, fogMask]);

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

  // --- Cursor coordinate readout (screen -> content px -> world -> in-game). -
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!entry) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const v = viewRef.current;
      const contentX = (e.clientX - rect.left - v.tx) / v.k;
      const contentY = (e.clientY - rect.top - v.ty) / v.k;
      const [wx, wy] = pxToWorld(entry, contentX, contentY);
      setReadout(worldToInGame(wx, wy));
    },
    [entry],
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

  // --- Screen-space positions for player pins + custom markers. ------------
  const pins = useMemo(() => {
    if (!entry || !mapState) return { players: [], markers: [] };
    const nameByUid = new Map(
      saveSummary?.players.map((p) => [p.uid, p.name]) ?? [],
    );
    const players = mapState.players
      .filter(
        (p) =>
          p.x !== null &&
          p.y !== null &&
          worldInBounds(entry, p.x, p.y),
      )
      .map((p) => {
        const [u, vv] = worldToPx(entry, p.x as number, p.y as number);
        return {
          uid: p.uid,
          label: p.nickname ?? nameByUid.get(p.uid) ?? null,
          sx: u * view.k + view.tx,
          sy: vv * view.k + view.ty,
        };
      });
    const markers = mapState.markers
      .filter((m) => worldInBounds(entry, m.x, m.y))
      .map((m, i) => {
        const [u, vv] = worldToPx(entry, m.x, m.y);
        return { id: i, sx: u * view.k + view.tx, sy: vv * view.k + view.ty };
      });
    return { players, markers };
  }, [entry, mapState, saveSummary, view]);

  const ctrlBtn =
    "flex h-8 w-8 items-center justify-center border-b border-line text-ink-dim transition-colors last:border-b-0 hover:bg-hover hover:text-ink";

  return (
    <div className="flex h-full flex-col">
      {/* Header: eyebrow / title / layer tabs, fog controls on the right. */}
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

        {/* Fog controls: hidden with no save; disabled + honest microcopy when
            the world has no client LocalData; live toggle + reveal chip otherwise. */}
        {saveDir && (
          <div className="flex items-center gap-3">
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
          </div>
        )}
      </header>

      {/* Map surface. */}
      <div className="relative flex-1 overflow-hidden bg-abyss">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setReadout(null)}
          aria-label={`World map, ${LAYERS.find((l) => l.key === layer)?.label} layer`}
          className={`absolute inset-0 h-full w-full touch-none select-none ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          }`}
        />

        {/* Player + marker overlay (screen space; never intercepts panning). */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {pins.markers.map((m) => (
            <span
              key={`m${m.id}`}
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-abyss/70 bg-ink-dim/80"
              style={{ left: m.sx, top: m.sy }}
              title="Custom marker"
            />
          ))}
          {pins.players.map((p) => (
            <div
              key={p.uid}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
              style={{ left: p.sx, top: p.sy }}
            >
              <span className="h-3 w-3 rounded-full border-2 border-abyss bg-amber shadow-[0_0_0_1px_rgba(240,169,74,0.5)]" />
              {p.label && (
                <span className="mt-1 whitespace-nowrap rounded-xs border border-line bg-panel/90 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-ink">
                  {p.label}
                </span>
              )}
            </div>
          ))}
        </div>

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
