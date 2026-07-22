// The Solver graph view: a pannable / zoomable breeding-bracket flowchart.
//
// Layout is the hand-rolled tidy-tree in plan-graph-layout.ts (leaves left,
// target right). Rendering is real DOM — circular pal nodes absolutely
// positioned inside a single CSS-transformed viewport div (translate+scale),
// over ONE SVG underlay that draws the edges in the same coordinate space — so
// hover cards, focus, and click all keep working. No layout/graph dependency.
//
// Interaction: wheel zooms to the cursor (clamped 0.4–2.5, page scroll
// suppressed), a left-drag on the background pans past a 4px threshold, nodes
// stop propagation so a click selects instead of panning, and the view
// fit-to-views on mount and on every plan switch. Corner controls do −/+/fit;
// nodes are Enter/Space-activatable for keyboard selection.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BreedingPlan } from "../lib/types";
import type { PlanNodeSelection } from "./plan-node-panel";
import {
  COL_W,
  layoutPlan,
  NODE_R,
  NODE_W,
  type LaidNode,
  type PlanLayout,
} from "./plan-graph-layout";
import { formatDuration, genderView, probBand } from "../lib/ui";
import { palIconUrl, UNKNOWN_ICON } from "../lib/assets";
import { PalHoverCard } from "./pal-hover-card";
import { Tag } from "./primitives";

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

/** Clamp a zoom factor into the interaction spec's [0.4, 2.5] range. */
function clampZoom(k: number): number {
  return Math.min(Math.max(k, MIN_ZOOM), MAX_ZOOM);
}

interface ViewTransform {
  k: number;
  tx: number;
  ty: number;
}

/** A circular pal node in the slot visual idiom (portrait clipped to a circle,
 *  element/source-tinted ring, gender dot). The plan payload carries no level /
 *  rank / alpha / instance, so — unlike the palbox Slot primitive it mirrors —
 *  it renders no level pill (nothing to fabricate); the side panel owns detail.
 *  Wrapped in the species-only PalHoverCard when a species id resolves. */
function PalCircle({
  laid,
  iconId,
  selected,
  onSelect,
}: {
  laid: LaidNode;
  iconId: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { node } = laid;
  const g = genderView(node.gender);
  const [failed, setFailed] = useState(false);
  const src = iconId && !failed ? palIconUrl(iconId) : UNKNOWN_ICON;

  const wild =
    typeof node.source === "object" && "Wild" in node.source
      ? node.source.Wild
      : null;
  const owned =
    typeof node.source === "object" && "Owned" in node.source
      ? node.source.Owned
      : null;
  const isBred = node.source === "Bred";

  const d = NODE_R * 2;
  const gBadge = Math.max(15, Math.round(d * 0.3));
  const gFont = Math.max(10, Math.round(d * 0.22));

  const ring = selected
    ? "ring-2 ring-amber"
    : wild
      ? "ring-el-leaf/60 group-hover:ring-el-leaf"
      : isBred
        ? "ring-amber/50 group-hover:ring-amber"
        : "ring-line/70 group-hover:ring-amber/50";

  const trigger = (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${node.species_name}${g.label !== "Any" ? `, ${g.label}` : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      // Don't let a node click start a background pan; keep click = select.
      onPointerDown={(e) => e.stopPropagation()}
      className="group relative cursor-pointer rounded-full outline-none"
      style={{ width: d, height: d }}
    >
      <span
        className={`block h-full w-full overflow-hidden rounded-full bg-abyss/70 ring-1 transition-[box-shadow,transform] group-hover:-translate-y-0.5 ${ring}`}
      >
        <img
          src={src}
          alt=""
          width={d}
          height={d}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      </span>
      {node.gender && (
        <span
          title={g.label}
          style={{ width: gBadge, height: gBadge, fontSize: gFont }}
          className={`absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border border-abyss bg-raised font-semibold leading-none ${g.className}`}
        >
          {g.glyph}
        </span>
      )}
    </div>
  );

  return (
    <div
      className="absolute flex flex-col items-center gap-1.5"
      style={{ left: laid.x - NODE_W / 2, top: laid.y - NODE_R, width: NODE_W }}
    >
      {iconId ? (
        <PalHoverCard speciesId={iconId}>{trigger}</PalHoverCard>
      ) : (
        trigger
      )}
      <div className="flex flex-col items-center gap-1 text-center">
        <span
          className="max-w-full truncate text-[12px] font-medium text-ink"
          title={node.species_name}
        >
          {node.species_name}
        </span>
        {wild ? (
          <div className="flex items-center gap-1">
            <span
              className="rounded-sm border border-el-leaf/50 bg-el-leaf/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wider text-el-leaf"
              title="Catch this pal in the wild"
            >
              Catch{wild.captures > 1 ? `\u00a0\u00d7${wild.captures}` : ""}
            </span>
            {wild.min_wild_level ? (
              <span
                className="rounded-sm border border-el-leaf/35 bg-el-leaf/[0.08] px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none tabular-nums text-el-leaf"
                title={`Wild spawns from level ${wild.min_wild_level}`}
              >
                Lv {wild.min_wild_level}+
              </span>
            ) : null}
          </div>
        ) : owned ? (
          <Tag>Owned &middot; {owned.location}</Tag>
        ) : isBred ? (
          <Tag tone="amber">Bred</Tag>
        ) : null}
      </div>
    </div>
  );
}

/** The compact breeding-step chip on the junction where two parents converge
 *  into a bred child: egg glyph + color-coded odds pill + mono step time. All
 *  step math lives here, never on the pal nodes. */
function JunctionChip({ child }: { child: LaidNode }) {
  const prob = probBand(child.node.probability);
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1"
      style={{ left: child.x - COL_W / 2, top: child.y }}
      title={`Breed step: ${(child.node.probability * 100).toFixed(0)}% odds, ${formatDuration(child.node.est_time_secs)}`}
    >
      <svg
        width="11"
        height="13"
        viewBox="0 0 20 24"
        className="shrink-0 text-amber/80"
        fill="currentColor"
        aria-hidden
      >
        <path d="M10 1C6 1 2 8 2 14a8 8 0 0 0 16 0C18 8 14 1 10 1z" />
      </svg>
      <span
        className={`rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${prob.text} ${prob.ring}`}
        title={`${prob.label} odds`}
      >
        {(child.node.probability * 100).toFixed(0)}%
      </span>
      <span className="font-mono text-[11px] tabular-nums text-ink-dim">
        {formatDuration(child.node.est_time_secs)}
      </span>
    </div>
  );
}

export function PlanGraph({
  plan,
  planIndex,
  nameToId,
  selectedId,
  onSelect,
}: {
  plan: BreedingPlan;
  planIndex: number;
  nameToId: Map<string, string>;
  selectedId: string | null;
  onSelect: (sel: PlanNodeSelection, nodeId: string) => void;
}) {
  const layout = useMemo<PlanLayout>(() => layoutPlan(plan.root), [plan.root]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform>({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [dragging, setDragging] = useState(false);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    if (vw === 0 || vh === 0) return;
    const pad = 48;
    const k = clampZoom(
      Math.min(
        (vw - 2 * pad) / layout.width,
        (vh - 2 * pad) / layout.height,
        MAX_ZOOM,
      ),
    );
    setView({
      k,
      tx: (vw - layout.width * k) / 2,
      ty: (vh - layout.height * k) / 2,
    });
  }, [layout]);

  // Fit on mount and whenever the plan (hence layout) switches.
  useLayoutEffect(() => {
    fit();
  }, [fit, planIndex]);

  // Refit when the viewport is resized (also delivers the first real measure).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Native non-passive wheel listener so preventDefault actually blocks the
  // page from scrolling; zoom keeps the point under the cursor fixed.
  useEffect(() => {
    const el = containerRef.current;
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

  // Background pan: engage only past a 4px threshold (so a bare click on the
  // canvas doesn't jitter the view); nodes stopPropagation upstream.
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

  const zoomBy = useCallback((mult: number) => {
    const el = containerRef.current;
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

  const ctrlBtn =
    "flex h-8 w-8 items-center justify-center border-b border-line text-ink-dim transition-colors last:border-b-0 hover:bg-hover hover:text-ink";

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      className={`relative h-full w-full select-none overflow-hidden ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
        }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width={layout.width}
          height={layout.height}
        >
          {layout.edges.map((e) => (
            <path
              key={e.id}
              d={e.d}
              fill="none"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              className={e.accent ? "stroke-amber/70" : "stroke-line"}
            />
          ))}
        </svg>

        {layout.junctions.map((j) => (
          <JunctionChip key={j.id} child={j.child} />
        ))}

        {layout.nodes.map((laid) => {
          const iconId = nameToId.get(laid.node.species_name) ?? null;
          return (
            <PalCircle
              key={laid.id}
              laid={laid}
              iconId={iconId}
              selected={selectedId === laid.id}
              onSelect={() =>
                onSelect(
                  {
                    species: iconId,
                    speciesName: laid.node.species_name,
                    source: laid.node.source,
                    gender: laid.node.gender,
                    planIndex,
                    passives: laid.node.passives,
                    probability: laid.node.probability,
                    estTimeSecs: laid.node.est_time_secs,
                  },
                  laid.id,
                )
              }
            />
          );
        })}
      </div>

      {/* Zoom / fit cluster. */}
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
  );
}
