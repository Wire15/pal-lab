// Spoiler-proof fog of war. Wave 1 desaturated + dimmed the unexplored terrain
// (still faintly legible — a spoiler leak). Wave 2 HIDES it: a near-opaque
// abyss-navy layer the terrain does not read through, with soft cloud-like
// edges instead of the raw 8-px mask blocks.
//
// The reveal PNG is a coarse mask (MainMap 1024², Tree 512²) that, stretched to
// the 8192-px content box, would show hard blocky reveal boundaries. So the
// mask is baked once into a blurred offscreen canvas (ctx.filter blur pass);
// the paint loop then bilinear-upscales that to the content box, and the two
// smoothing stages together dissolve the blocks into a haze whose edge softness
// grows with zoom. The sharp mask is kept as a bit array for the per-pin
// spoiler test (a pin in an unrevealed cell is culled unless already known).

import type { FogLayer } from "../../lib/types";

/** Fog fill: a deep abyss-navy, a touch bluer/darker than the panel abyss so
 *  the unexplored region reads as ocean-deep rather than flat panel. */
const FOG_COLOR = { r: 8, g: 12, b: 20 };
/** Near-opaque so terrain is not legible beneath, but not pure black — a faint
 *  abyss depth remains (matches the in-game unexplored look minus 100% black). */
const FOG_ALPHA = 249; // ~0.976
/** Blur radius in native mask px baked into the offscreen fog canvas. ~1.6
 *  cells of softening; the later 8× content stretch carries it to a soft ~13px
 *  cloud edge at fit and softer as you zoom in. */
const FOG_BLUR = 1.6;

/** A built fog layer: the blurred paint source plus the sharp reveal bit array
 *  (1 = revealed) for the spoiler test. */
export interface FogMask {
  layer: string;
  /** Blurred, near-opaque fog at native mask resolution — the paint source. */
  blurred: HTMLCanvasElement;
  maskW: number;
  maskH: number;
  /** 1 byte per mask cell, row-major: 1 = revealed, 0 = fogged. */
  revealed: Uint8Array;
}

/** Decode a fog layer's reveal PNG into a {@link FogMask}. Fogged = the mask's
 *  red channel below mid (contract: 0 fogged / 255 revealed). */
export async function buildFogMask(fog: FogLayer): Promise<FogMask> {
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

  const revealed = new Uint8Array(w * h);
  // Sharp fog canvas: fogged cells opaque abyss-navy, revealed transparent.
  const sharp = document.createElement("canvas");
  sharp.width = w;
  sharp.height = h;
  const sharpCtx = sharp.getContext("2d")!;
  const fogImg = sharpCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    if (px[i * 4] >= 128) {
      revealed[i] = 1;
      continue; // revealed -> leave transparent
    }
    fogImg.data[i * 4] = FOG_COLOR.r;
    fogImg.data[i * 4 + 1] = FOG_COLOR.g;
    fogImg.data[i * 4 + 2] = FOG_COLOR.b;
    fogImg.data[i * 4 + 3] = FOG_ALPHA;
  }
  sharpCtx.putImageData(fogImg, 0, 0);

  // Blur pass: bake soft edges into an offscreen canvas once (never per frame).
  const blurred = document.createElement("canvas");
  blurred.width = w;
  blurred.height = h;
  const bctx = blurred.getContext("2d")!;
  bctx.filter = `blur(${FOG_BLUR}px)`;
  bctx.drawImage(sharp, 0, 0);
  bctx.filter = "none";

  return { layer: fog.map, blurred, maskW: w, maskH: h, revealed };
}

/** True when the mask cell under normalized content coords `(fu, fv)` (each in
 *  0..1, texture-aligned) is revealed. Out-of-range coords read as fogged. */
export function isRevealed(mask: FogMask, fu: number, fv: number): boolean {
  if (fu < 0 || fu >= 1 || fv < 0 || fv >= 1) return false;
  const mx = Math.min(mask.maskW - 1, Math.floor(fu * mask.maskW));
  const my = Math.min(mask.maskH - 1, Math.floor(fv * mask.maskH));
  return mask.revealed[my * mask.maskW + mx] === 1;
}
