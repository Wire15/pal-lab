// Plan export: a hand-rolled PNG serializer + a shareable "plan code" codec.
//
// PNG — rather than serialize the live plan-graph DOM+SVG (which would need to
// inline the external pal PNGs and the self-hosted fonts into a foreignObject
// just to survive canvas rasterization, the classic html-to-image trap), we
// re-render the plan onto a fresh canvas from the SAME pure geometry the graph
// view uses (`layoutPlan`). Zero dependencies, taint-free, deterministic, and it
// bakes in the dark background + a PAL-LAB watermark and target header. The
// exported frame therefore matches the graph's bracket layout exactly (fit to
// the whole plan, no pan/zoom state).
//
// Plan code — base64url of `{ request, planIdx }`; pasting it back re-solves via
// the normal solve path, so the shared tree is honest against the current save
// rather than a frozen snapshot.

import type { BreedingPlan, PlanNode, SolveRequest } from "../lib/types";
import { formatDuration } from "../lib/ui";
import { palIconUrl, UNKNOWN_ICON } from "../lib/assets";
import { layoutPlan, NODE_R, NODE_W, type LaidNode } from "./plan-graph-layout";

// --- Design tokens (index.css @theme), needed as literals on a 2D canvas ------
const C = {
  abyss: "#0d1117",
  panel: "#151c26",
  raised: "#1d2733",
  line: "#2b3746",
  ink: "#e7ecf2",
  inkDim: "#9dabbb",
  inkFaint: "#63717f",
  amber: "#f0a94a",
  amber70: "rgba(240,169,74,0.7)",
  elLeaf: "#6ec25a",
  elWater: "#4aa8e0", // ♂
  elDragon: "#d264b0", // ♀
  good: "#57cf8b",
  fair: "#e7c34a",
  warn: "#f0983f",
  bad: "#ef6a6a",
} as const;

/** Junction-chip odds color: mirrors `ui.probBand` thresholds (0-1 → hex). */
function probColor(p: number): string {
  const pct = p * 100;
  if (pct >= 75) return C.good;
  if (pct >= 50) return C.fair;
  if (pct >= 25) return C.warn;
  return C.bad;
}

const FONT_SANS = "'IBM Plex Sans', sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";
const FONT_DISPLAY = "'Chakra Petch', sans-serif";

/** Height of the target-name + watermark band above the plan bracket. */
const HEADER_H = 74;

/** The egg glyph from the junction chip (viewBox 20×24), reused on canvas. */
const EGG_PATH = new Path2D("M10 1C6 1 2 8 2 14a8 8 0 0 0 16 0C18 8 14 1 10 1z");

/** Load an image, resolving to the neutral placeholder on any error so a single
 *  missing icon never rejects the whole export. */
function loadImage(url: string): Promise<HTMLImageElement> {
  const { promise, resolve } = Promise.withResolvers<HTMLImageElement>();
  const img = new Image();
  img.decoding = "async";
  img.onload = () => resolve(img);
  img.onerror = () => {
    if (img.src === UNKNOWN_ICON) {
      resolve(img); // give up gracefully; draw nothing rather than loop
      return;
    }
    img.onload = () => resolve(img);
    img.src = UNKNOWN_ICON;
  };
  img.src = url;
  return promise;
}

/** Trim `text` with an ellipsis so it fits `maxW` at the current ctx.font. */
function ellipsize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "\u2026").width > maxW) {
    t = t.slice(0, -1);
  }
  return t + "\u2026";
}

/** Rounded-rect path helper (roundRect is supported by the app's Chromium
 *  webviews; kept behind one call site for clarity). */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A centered outlined pill (border + faint fill + colored mono text). */
function pill(
  ctx: CanvasRenderingContext2D,
  cx: number,
  top: number,
  text: string,
  color: string,
  fillAlpha = "12",
): number {
  ctx.font = `600 10px ${FONT_MONO}`;
  const tw = ctx.measureText(text).width;
  const w = tw + 12;
  const h = 15;
  const x = cx - w / 2;
  roundRect(ctx, x, top, w, h, 3);
  ctx.fillStyle = color + fillAlpha;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color + "66";
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, top + h / 2 + 0.5);
  return w;
}

/** Draw one pal node (circle portrait, source-tinted ring, gender dot, name,
 *  status chip) centered on its laid position. */
function drawNode(
  ctx: CanvasRenderingContext2D,
  laid: LaidNode,
  img: HTMLImageElement,
): void {
  const { node } = laid;
  const { x, y } = laid;
  const wild =
    typeof node.source === "object" && "Wild" in node.source
      ? node.source.Wild
      : null;
  const owned =
    typeof node.source === "object" && "Owned" in node.source
      ? node.source.Owned
      : null;
  const isBred = node.source === "Bred";

  // Portrait clipped to a circle over an abyss backing.
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = C.abyss;
  ctx.fill();
  ctx.clip();
  if (img.width > 0) {
    ctx.drawImage(img, x - NODE_R, y - NODE_R, NODE_R * 2, NODE_R * 2);
  }
  ctx.restore();

  // Source-tinted ring.
  ctx.beginPath();
  ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = wild
    ? C.elLeaf + "99"
    : isBred
      ? C.amber + "80"
      : C.line + "b3";
  ctx.stroke();

  // Gender dot (bottom-right), matching genderView glyphs/colors.
  if (node.gender) {
    const gx = x + NODE_R * 0.72;
    const gy = y + NODE_R * 0.72;
    const gr = 9;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.fillStyle = C.raised;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C.abyss;
    ctx.stroke();
    ctx.fillStyle = node.gender === "Male" ? C.elWater : C.elDragon;
    ctx.font = `700 11px ${FONT_SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(node.gender === "Male" ? "\u2642" : "\u2640", gx, gy + 0.5);
  }

  // Species name.
  ctx.font = `500 12px ${FONT_SANS}`;
  ctx.fillStyle = C.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const nameY = y + NODE_R + 8;
  ctx.fillText(ellipsize(ctx, node.species_name, NODE_W), x, nameY);

  // Status chip cluster.
  const chipTop = nameY + 17;
  if (wild) {
    const label = `CATCH${wild.captures > 1 ? `\u00a0\u00d7${wild.captures}` : ""}`;
    if (wild.min_wild_level > 0) {
      // Two pills side by side (CATCH + Lv N+): lay them out around center.
      ctx.font = `600 10px ${FONT_MONO}`;
      const w1 = ctx.measureText(label).width + 12;
      const lv = `Lv ${wild.min_wild_level}+`;
      const w2 = ctx.measureText(lv).width + 12;
      const gap = 4;
      const total = w1 + gap + w2;
      const c1 = x - total / 2 + w1 / 2;
      const c2 = x + total / 2 - w2 / 2;
      pill(ctx, c1, chipTop, label, C.elLeaf);
      pill(ctx, c2, chipTop, lv, C.elLeaf);
    } else {
      pill(ctx, x, chipTop, label, C.elLeaf);
    }
  } else if (owned) {
    pill(ctx, x, chipTop, `Owned \u00b7 ${owned.location}`, C.inkDim, "10");
  } else if (isBred) {
    pill(ctx, x, chipTop, "Bred", C.amber);
  }
}

/** Draw the odds/step-time junction chip centered on a convergence point. */
function drawJunction(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  node: PlanNode,
): void {
  const odds = `${Math.round(node.probability * 100)}%`;
  const time = formatDuration(node.est_time_secs);
  const oc = probColor(node.probability);

  ctx.font = `600 11px ${FONT_MONO}`;
  const oddsW = ctx.measureText(odds).width;
  const timeW = ctx.measureText(time).width;
  const eggW = 11;
  const padX = 8;
  const gap = 6;
  const pillW = oddsW + 10;
  const chipW = padX * 2 + eggW + gap + pillW + gap + timeW;
  const chipH = 22;
  const x = cx - chipW / 2;
  const y = cy - chipH / 2;

  roundRect(ctx, x, y, chipW, chipH, 6);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.line;
  ctx.stroke();

  // Egg glyph (viewBox 20×24 → ~11×13).
  ctx.save();
  ctx.translate(x + padX, y + (chipH - 13.2) / 2);
  ctx.scale(0.55, 0.55);
  ctx.fillStyle = C.amber70;
  ctx.fill(EGG_PATH);
  ctx.restore();

  // Odds pill.
  const pillX = x + padX + eggW + gap;
  const pillY = y + (chipH - 16) / 2;
  roundRect(ctx, pillX, pillY, pillW, 16, 3);
  ctx.fillStyle = oc + "1a";
  ctx.fill();
  ctx.strokeStyle = oc + "66";
  ctx.stroke();
  ctx.fillStyle = oc;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(odds, pillX + pillW / 2, y + chipH / 2 + 0.5);

  // Step time.
  ctx.fillStyle = C.inkDim;
  ctx.textAlign = "left";
  ctx.fillText(time, pillX + pillW + gap, y + chipH / 2 + 0.5);
}

/** Options for {@link renderPlanPng}. */
export interface RenderPlanOpts {
  /** Target species name shown in the exported frame's header. */
  targetName: string;
  /** Device-pixel multiplier for a crisp raster. Defaults to 2. */
  scale?: number;
}

/**
 * Render a breeding plan to a PNG Blob: a fit-to-frame re-render of the graph
 * bracket on a dark background, with a target-name header and PAL-LAB
 * watermark baked in. Reuses `layoutPlan`, so geometry is identical to the live
 * graph. Awaits `document.fonts.ready` so the self-hosted faces are available.
 */
export async function renderPlanPng(
  plan: BreedingPlan,
  nameToId: Map<string, string>,
  opts: RenderPlanOpts,
): Promise<Blob> {
  const layout = layoutPlan(plan.root);
  const scale = opts.scale ?? 2;
  const W = layout.width;
  const H = layout.height + HEADER_H;

  // Preload every node icon before painting (order matches layout.nodes).
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* fonts optional; canvas falls back to generic families */
    }
  }
  const images = await Promise.all(
    layout.nodes.map((laid) => {
      const id = nameToId.get(laid.node.species_name) ?? null;
      return loadImage(id ? palIconUrl(id) : UNKNOWN_ICON);
    }),
  );

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(W * scale);
  canvas.height = Math.ceil(H * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for PNG export");
  ctx.scale(scale, scale);

  // Background.
  ctx.fillStyle = C.abyss;
  ctx.fillRect(0, 0, W, H);

  // Header band: target name (display, amber) + a mono stats subline; the
  // PAL-LAB watermark sits top-right. A hairline divides it from the bracket.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.amber;
  ctx.font = `700 22px ${FONT_DISPLAY}`;
  ctx.fillText(opts.targetName, 20, 34);

  ctx.fillStyle = C.inkDim;
  ctx.font = `500 12px ${FONT_MONO}`;
  const wild = plan.total_wild_pals;
  const sub =
    `${formatDuration(plan.total_time_secs)}  \u00b7  ` +
    `${plan.total_steps} steps  \u00b7  ${wild} wild` +
    (plan.cake && plan.cake !== "Normal"
      ? `  \u00b7  ${plan.cake_count} ${plan.cake} cake`
      : "");
  ctx.fillText(sub, 20, 56);

  ctx.textAlign = "right";
  ctx.fillStyle = C.inkFaint;
  ctx.font = `600 11px ${FONT_MONO}`;
  ctx.fillText("PAL-LAB", W - 20, 30);
  ctx.font = `500 10px ${FONT_MONO}`;
  ctx.fillText("breeding plan", W - 20, 46);

  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H - 0.5);
  ctx.lineTo(W, HEADER_H - 0.5);
  ctx.stroke();

  // Plan bracket (shift below the header).
  ctx.save();
  ctx.translate(0, HEADER_H);

  for (const e of layout.edges) {
    const path = new Path2D(e.d);
    ctx.strokeStyle = e.accent ? C.amber70 : C.line;
    ctx.lineWidth = 2;
    ctx.stroke(path);
  }
  for (const j of layout.junctions) {
    drawJunction(ctx, j.x, j.y, j.child.node);
  }
  layout.nodes.forEach((laid, i) => drawNode(ctx, laid, images[i]));

  ctx.restore();

  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error("canvas.toBlob returned null"));
  }, "image/png");
  return promise;
}

/** Trigger a browser download for a Blob via an anchor (works in a plain
 *  browser and in the Tauri webview's download handler). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has grabbed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filesystem-safe filename for a plan PNG. */
export function planPngFilename(targetName: string): string {
  const slug = targetName.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `pal-lab-${slug || "plan"}.png`;
}

// --- Shareable plan code -----------------------------------------------------

/** The decoded payload of a plan code. */
export interface DecodedPlanCode {
  request: SolveRequest;
  planIdx: number;
}

/** Encode `{ request, planIdx }` as a base64url string (URL/paste-safe). */
export function encodePlanCode(request: SolveRequest, planIdx: number): string {
  const json = JSON.stringify({ request, planIdx });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a plan code back to `{ request, planIdx }`; throws a friendly error
 *  when the string is not a valid, well-shaped code. */
export function decodePlanCode(code: string): DecodedPlanCode {
  const trimmed = code.trim();
  if (!trimmed) throw new Error("Paste a plan code first.");
  let json: string;
  try {
    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch {
    throw new Error("That doesn't look like a valid plan code.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That doesn't look like a valid plan code.");
  }
  const p = parsed as Partial<DecodedPlanCode> | null;
  if (
    !p ||
    typeof p !== "object" ||
    !p.request ||
    typeof p.request.target_species !== "string" ||
    typeof p.planIdx !== "number"
  ) {
    throw new Error("This plan code is missing a target species.");
  }
  return { request: p.request, planIdx: p.planIdx };
}
