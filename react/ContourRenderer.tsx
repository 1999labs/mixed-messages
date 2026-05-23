"use client";

import { useEffect, useRef } from "react";

interface Point {
  x: number;
  y: number;
}

interface ContourRendererProps {
  points: Point[];
  prompt: string;
  size?: number;
  className?: string;
}

const CANVAS_SIZE = 640;

// ====== Algorithm constants (must match renderer/recursivesubdivision.js) ======

const SCALE = 10000;
const MIN_DIM = 50;
const NOISE_RANGE = 1000;

// Tuned project defaults
const DEFAULT_DENSITY_MULT = 10;
const DEFAULT_MAX_SLIVER_PCT = 30;
const DEFAULT_USE_CONVICTION_AXIS = true;

const SALT_K_CAP = 300;
const BASE_SCATTER_PROB = 20; // /100 — 20% random region selection, 80% closest
const LOCAL_Q_DISCOUNT_NUM = 3;
const LOCAL_Q_DISCOUNT_DEN = 10; // matching color gets 30% of its weight

const FLAT_ALPHA = 95;
const BG_R = 0xff;
const BG_G = 0xff;
const BG_B = 0xff;

const C_TL: [number, number, number] = [85, 255, 255];  // uniting  + performed — cyan
const C_TR: [number, number, number] = [85, 255, 85];   // uniting  + honest    — green
const C_BL: [number, number, number] = [255, 85, 85];   // dividing + performed — red
const C_BR: [number, number, number] = [85, 85, 255];   // dividing + honest    — blue

// ====== PRNG (must match Solidity) ======

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ (str.charCodeAt(i) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function next32(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

// ====== Color / claim helpers ======

function discreteColor(x: number, y: number): [number, number, number] {
  if (x < 0.5 && y < 0.5) return C_TL;
  if (x >= 0.5 && y < 0.5) return C_TR;
  if (x < 0.5 && y >= 0.5) return C_BL;
  return C_BR;
}

// 0=TL, 1=TR, 2=BL, 3=BR — matches discreteColor's quadrant order
function quadrantIndex(x: number, y: number): number {
  return (y < 0.5 ? 0 : 2) + (x < 0.5 ? 0 : 1);
}

function blendChannel(c: number, bg: number): number {
  return Math.floor((c * FLAT_ALPHA + bg * (100 - FLAT_ALPHA)) / 100);
}

function sliceClaimScaled(px: number, py: number): number {
  const HALF = SCALE / 2;
  const dx2 = Math.abs(px - HALF) * 2;
  const dy2 = Math.abs(py - HALF) * 2;
  const magScaled = dx2 > dy2 ? dx2 : dy2;
  const shapedScaled = Math.floor(Math.sqrt(magScaled * SCALE));
  return Math.floor(HALF + (shapedScaled * 20) / 100);
}

// ====== Color picker (count-weighted + local-quadrant discount) ======

interface RngRef {
  s: number;
}

function pickWeightedColor(
  baseWeights: number[],
  localQ: number,
  rngRef: RngRef,
  colorTable: Array<[number, number, number]>
): [number, number, number] {
  const w = [baseWeights[0], baseWeights[1], baseWeights[2], baseWeights[3]];
  w[localQ] = Math.floor((w[localQ] * LOCAL_Q_DISCOUNT_NUM) / LOCAL_Q_DISCOUNT_DEN);
  const total = w[0] + w[1] + w[2] + w[3];
  if (total === 0) {
    rngRef.s = next32(rngRef.s);
    return colorTable[rngRef.s % 4];
  }
  rngRef.s = next32(rngRef.s);
  const t = rngRef.s % total;
  if (t < w[0]) return colorTable[0];
  if (t < w[0] + w[1]) return colorTable[1];
  if (t < w[0] + w[1] + w[2]) return colorTable[2];
  return colorTable[3];
}

// ====== Region type ======

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
}

interface RenderOpts {
  densityMult?: number;
  maxSliverPct?: number;
  useConvictionAxis?: boolean;
}

// ====== Algorithm ======

function computeRegions(points: Point[], prompt: string, opts?: RenderOpts): Region[] {
  // No submissions = blank piece
  if (points.length === 0) {
    return [{ x: 0, y: 0, w: SCALE, h: SCALE, r: BG_R, g: BG_G, b: BG_B }];
  }

  const densityMult = opts?.densityMult ?? DEFAULT_DENSITY_MULT;
  const maxSliverPct = opts?.maxSliverPct ?? DEFAULT_MAX_SLIVER_PCT;
  const useConvictionAxis = opts?.useConvictionAxis ?? DEFAULT_USE_CONVICTION_AXIS;

  const colorTable: Array<[number, number, number]> = [C_TL, C_TR, C_BL, C_BR];

  // Per-quadrant counts → color weights for landlock + salt.
  // +1 floor per quadrant so unanimous-quadrant days don't collapse to a single
  // color (see recursivesubdivision.js for the rationale).
  const counts = [0, 0, 0, 0];
  for (const p of points) counts[quadrantIndex(p.x, p.y)]++;
  const baseWeights = [counts[0] + 1, counts[1] + 1, counts[2] + 1, counts[3] + 1];

  // Independent RNG streams
  const promptHash = fnv1a32(prompt || "");
  let baseRng = promptHash;
  let shuffleRng = promptHash;
  let saltRng = fnv1a32((prompt || "") + "\x00salt");

  // === BASE LAYER ===
  const regions: Region[] = [
    { x: 0, y: 0, w: SCALE, h: SCALE, r: BG_R, g: BG_G, b: BG_B },
  ];

  // Deterministic Fisher-Yates shuffle so submission order doesn't matter
  const ordered = points.slice();
  for (let i = ordered.length - 1; i > 0; i--) {
    shuffleRng = next32(shuffleRng);
    const j = shuffleRng % (i + 1);
    const tmp = ordered[i];
    ordered[i] = ordered[j];
    ordered[j] = tmp;
  }

  for (const p of ordered) {
    const px = Math.max(0, Math.min(SCALE, Math.round(p.x * SCALE)));
    const py = Math.max(0, Math.min(SCALE, Math.round(p.y * SCALE)));

    // Region selection: BASE_SCATTER_PROB% random (area-weighted), else closest
    baseRng = next32(baseRng);
    const useScatter = baseRng % 100 < BASE_SCATTER_PROB;

    let bestIdx = -1;
    if (useScatter) {
      let totalArea = 0;
      const cuttableIdx: number[] = [];
      const cumArea: number[] = [];
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        if (r.w < 2 * MIN_DIM && r.h < 2 * MIN_DIM) continue;
        totalArea += r.w * r.h;
        cuttableIdx.push(i);
        cumArea.push(totalArea);
      }
      if (cuttableIdx.length === 0) continue;
      baseRng = next32(baseRng);
      const target = baseRng % totalArea;
      let pick = 0;
      while (pick < cumArea.length - 1 && cumArea[pick] <= target) pick++;
      bestIdx = cuttableIdx[pick];
    } else {
      let bestScore = 0;
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        if (r.w < 2 * MIN_DIM && r.h < 2 * MIN_DIM) continue;
        const cx = r.x + Math.floor(r.w / 2);
        const cy = r.y + Math.floor(r.h / 2);
        const dx = cx - px;
        const dy = cy - py;
        const s = dx * dx + dy * dy;
        if (bestIdx === -1 || s < bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) continue;
    }
    const reg = regions[bestIdx];

    // Cut direction: conviction-axis bias when enabled, else legacy rule
    let splitWidth: boolean;
    if (useConvictionAxis) {
      const xMag = Math.abs(2 * px - SCALE);
      const yMag = Math.abs(2 * py - SCALE);
      const totalMag = xMag + yMag;
      baseRng = next32(baseRng);
      if (totalMag === 0) {
        splitWidth = (baseRng & 1) === 0;
      } else {
        const pVertScaled = Math.floor((xMag * SCALE) / totalMag);
        splitWidth = baseRng % SCALE < pVertScaled;
      }
    } else {
      const wLonger = reg.w >= reg.h;
      const gx = 2 * px - SCALE;
      splitWidth = gx >= 0 ? wLonger : !wLonger;
    }
    if (splitWidth && reg.w < 2 * MIN_DIM) splitWidth = false;
    else if (!splitWidth && reg.h < 2 * MIN_DIM) splitWidth = true;

    const claimedShareScaled = sliceClaimScaled(px, py);

    baseRng = next32(baseRng);
    const paintLow = (baseRng & 1) === 0;
    const baseRatio = paintLow ? claimedShareScaled : SCALE - claimedShareScaled;

    baseRng = next32(baseRng);
    let ratio = baseRatio + ((baseRng % (NOISE_RANGE + 1)) - NOISE_RANGE / 2);
    if (ratio < 1500) ratio = 1500;
    if (ratio > 8500) ratio = 8500;

    const dim = splitWidth ? reg.w : reg.h;
    let cutPos = Math.floor((dim * ratio) / SCALE);
    if (cutPos < MIN_DIM) cutPos = MIN_DIM;
    if (cutPos > dim - MIN_DIM) cutPos = dim - MIN_DIM;

    let r1: Region, r2: Region;
    if (splitWidth) {
      r1 = { x: reg.x, y: reg.y, w: cutPos, h: reg.h, r: 0, g: 0, b: 0 };
      r2 = {
        x: reg.x + cutPos, y: reg.y, w: reg.w - cutPos, h: reg.h,
        r: 0, g: 0, b: 0,
      };
    } else {
      r1 = { x: reg.x, y: reg.y, w: reg.w, h: cutPos, r: 0, g: 0, b: 0 };
      r2 = {
        x: reg.x, y: reg.y + cutPos, w: reg.w, h: reg.h - cutPos,
        r: 0, g: 0, b: 0,
      };
    }
    const nc = discreteColor(p.x, p.y);
    if (paintLow) {
      r1.r = nc[0]; r1.g = nc[1]; r1.b = nc[2];
      r2.r = reg.r; r2.g = reg.g; r2.b = reg.b;
    } else {
      r2.r = nc[0]; r2.g = nc[1]; r2.b = nc[2];
      r1.r = reg.r; r1.g = reg.g; r1.b = reg.b;
    }
    regions.splice(bestIdx, 1, r1, r2);
  }

  // === LANDLOCK (full coverage — no white survives) ===
  const baseRngRef: RngRef = { s: baseRng };
  for (const r of regions) {
    if (!(r.r === BG_R && r.g === BG_G && r.b === BG_B)) continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const localQ = (cy < SCALE / 2 ? 0 : 2) + (cx < SCALE / 2 ? 0 : 1);
    const c = pickWeightedColor(baseWeights, localQ, baseRngRef, colorTable);
    r.r = c[0]; r.g = c[1]; r.b = c[2];
  }
  baseRng = baseRngRef.s;

  // === SALT POST-PASS ===
  // K = density × 120 / (20 + floor(sqrt(N))) — uses floor(sqrt) so the
  // Solidity isqrt port produces an identical K.
  const sqrtN = Math.floor(Math.sqrt(points.length));
  const K = Math.min(
    SALT_K_CAP,
    Math.ceil((densityMult * 120) / (20 + sqrtN))
  );
  const SLIVER_MIN = 100;
  const sliverMaxU = Math.max(SLIVER_MIN + 1, maxSliverPct * 100);
  const sliverSpan = sliverMaxU - SLIVER_MIN + 1;

  const saltRngRef: RngRef = { s: saltRng };
  const pickEdgeBiased = () => {
    saltRngRef.s = next32(saltRngRef.s);
    const nearLow = (saltRngRef.s & 1) === 0;
    saltRngRef.s = next32(saltRngRef.s);
    const ratio = nearLow
      ? SLIVER_MIN + (saltRngRef.s % sliverSpan)
      : SCALE - sliverMaxU + (saltRngRef.s % sliverSpan);
    return { ratio, nearLow };
  };

  for (let k = 0; k < K; k++) {
    let totalArea = 0;
    const cuttableIdx: number[] = [];
    const cumArea: number[] = [];
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      if (r.w < 2 * MIN_DIM && r.h < 2 * MIN_DIM) continue;
      totalArea += r.w * r.h;
      cuttableIdx.push(i);
      cumArea.push(totalArea);
    }
    if (cuttableIdx.length === 0) break;

    saltRngRef.s = next32(saltRngRef.s);
    const target = saltRngRef.s % totalArea;
    let pick = 0;
    while (pick < cumArea.length - 1 && cumArea[pick] <= target) pick++;
    const idx = cuttableIdx[pick];
    const reg = regions[idx];

    saltRngRef.s = next32(saltRngRef.s);
    let splitWidth1 = (saltRngRef.s & 1) === 0;
    if (splitWidth1 && reg.w < 2 * MIN_DIM) splitWidth1 = false;
    else if (!splitWidth1 && reg.h < 2 * MIN_DIM) splitWidth1 = true;

    const dim1 = splitWidth1 ? reg.w : reg.h;
    const cut1 = pickEdgeBiased();
    let cutPos1 = Math.floor((dim1 * cut1.ratio) / SCALE);
    if (cutPos1 < MIN_DIM) cutPos1 = MIN_DIM;
    if (cutPos1 > dim1 - MIN_DIM) cutPos1 = dim1 - MIN_DIM;

    let sliver: Region, remainder: Region;
    if (splitWidth1) {
      const left: Region = {
        x: reg.x, y: reg.y, w: cutPos1, h: reg.h,
        r: reg.r, g: reg.g, b: reg.b,
      };
      const right: Region = {
        x: reg.x + cutPos1, y: reg.y, w: reg.w - cutPos1, h: reg.h,
        r: reg.r, g: reg.g, b: reg.b,
      };
      sliver = cut1.nearLow ? left : right;
      remainder = cut1.nearLow ? right : left;
    } else {
      const top: Region = {
        x: reg.x, y: reg.y, w: reg.w, h: cutPos1,
        r: reg.r, g: reg.g, b: reg.b,
      };
      const bot: Region = {
        x: reg.x, y: reg.y + cutPos1, w: reg.w, h: reg.h - cutPos1,
        r: reg.r, g: reg.g, b: reg.b,
      };
      sliver = cut1.nearLow ? top : bot;
      remainder = cut1.nearLow ? bot : top;
    }

    // Salt color via count-weighted + locally-discounted picker
    const regCx = reg.x + reg.w / 2;
    const regCy = reg.y + reg.h / 2;
    const localQ = (regCy < SCALE / 2 ? 0 : 2) + (regCx < SCALE / 2 ? 0 : 1);
    const nc = pickWeightedColor(baseWeights, localQ, saltRngRef, colorTable);

    // Second cut: perpendicular to the first. Turns the strip into a small box.
    const splitWidth2 = !splitWidth1;
    const dim2 = splitWidth2 ? sliver.w : sliver.h;
    if (dim2 < 2 * MIN_DIM) {
      sliver.r = nc[0]; sliver.g = nc[1]; sliver.b = nc[2];
      regions.splice(idx, 1, sliver, remainder);
    } else {
      const cut2 = pickEdgeBiased();
      let cutPos2 = Math.floor((dim2 * cut2.ratio) / SCALE);
      if (cutPos2 < MIN_DIM) cutPos2 = MIN_DIM;
      if (cutPos2 > dim2 - MIN_DIM) cutPos2 = dim2 - MIN_DIM;

      let tinyBox: Region, sliverRest: Region;
      if (splitWidth2) {
        const a: Region = {
          x: sliver.x, y: sliver.y, w: cutPos2, h: sliver.h,
          r: sliver.r, g: sliver.g, b: sliver.b,
        };
        const b: Region = {
          x: sliver.x + cutPos2, y: sliver.y, w: sliver.w - cutPos2, h: sliver.h,
          r: sliver.r, g: sliver.g, b: sliver.b,
        };
        tinyBox = cut2.nearLow ? a : b;
        sliverRest = cut2.nearLow ? b : a;
      } else {
        const a: Region = {
          x: sliver.x, y: sliver.y, w: sliver.w, h: cutPos2,
          r: sliver.r, g: sliver.g, b: sliver.b,
        };
        const b: Region = {
          x: sliver.x, y: sliver.y + cutPos2, w: sliver.w, h: sliver.h - cutPos2,
          r: sliver.r, g: sliver.g, b: sliver.b,
        };
        tinyBox = cut2.nearLow ? a : b;
        sliverRest = cut2.nearLow ? b : a;
      }
      tinyBox.r = nc[0]; tinyBox.g = nc[1]; tinyBox.b = nc[2];
      regions.splice(idx, 1, tinyBox, sliverRest, remainder);
    }
  }

  return regions;
}

function renderSubdivision(canvas: HTMLCanvasElement, points: Point[], prompt: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;

  ctx.fillStyle = `rgb(${BG_R},${BG_G},${BG_B})`;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const regions = computeRegions(points, prompt);

  for (const reg of regions) {
    const r = blendChannel(reg.r, BG_R);
    const g = blendChannel(reg.g, BG_G);
    const b = blendChannel(reg.b, BG_B);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    // Snap to integer pixel grid so adjacent same-color rects share an exact
    // boundary — otherwise canvas anti-aliasing leaves faint seams.
    const x0 = Math.round((reg.x * CANVAS_SIZE) / SCALE);
    const y0 = Math.round((reg.y * CANVAS_SIZE) / SCALE);
    const x1 = Math.round(((reg.x + reg.w) * CANVAS_SIZE) / SCALE);
    const y1 = Math.round(((reg.y + reg.h) * CANVAS_SIZE) / SCALE);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}

export function ContourRenderer({ points, prompt, size, className }: ContourRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    renderSubdivision(canvasRef.current, points, prompt);
  }, [points, prompt]);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      className={className}
      style={{
        width: size ?? "100%",
        height: size ?? "100%",
        display: "block",
      }}
    />
  );
}
