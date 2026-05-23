/**
 * Mixed Messages — Canonical Salt-Cuts Renderer
 *
 * Reference implementation for the 1/1 art. The Solidity renderer
 * (MixedMessagesRenderer.sol) and the React Canvas renderer
 * (frontend/src/components/ContourRenderer.tsx) must produce identical
 * output to this for the same inputs.
 *
 * Algorithm:
 *   1. SCATTERED BASE — each submission picks a region either at random
 *      (area-weighted) or by closeness, decided by a 50/50 PRNG flip
 *      seeded by the prompt. The submission's quadrant determines paint
 *      color, magnitude drives the claim share, and per-axis magnitude
 *      determines cut direction:
 *        P(vertical cut) = |x-0.5| / (|x-0.5| + |y-0.5|)
 *      so x-axis (Honest/Performed) conviction biases vertical cuts and
 *      y-axis (Uniting/Dividing) conviction biases horizontal cuts.
 *      Submissions are reordered by a deterministic Fisher-Yates shuffle
 *      seeded by the prompt so first-mover doesn't dominate.
 *   2. FULL-COVERAGE LANDLOCK — every remaining white region (edge-touching
 *      or interior) is recolored using a count-weighted color distribution
 *      with the local region's MATCHING color discounted to 30% weight. The
 *      final piece has no white showing through.
 *   3. SALT POST-PASS — K = ceil(densityMult * 120 / (20 + sqrt(N))) tiny
 *      boxes are added at prompt-seeded random positions. K peaks at low
 *      N (where salt carries the visual interest) and falls off at high N
 *      (where the base layer already has plenty of detail). Each salt op
 *      is a double-cut producing a small rect at one corner of a randomly-
 *      chosen region. Salt color uses the same count-weighted + locally-
 *      discounted distribution as landlock.
 *
 * Painted regions are blended toward white at a flat alpha for a printed
 * look.
 *
 * Usage:
 *   renderSubdivision(ctx, width, height, points, prompt, opts?)
 *
 * `points` is an array of { x, y } in [0, 1]. `prompt` is the day's word
 * string (used to seed the PRNG so output is deterministic per word).
 * `opts` (optional): { densityMult, maxSliverPct, useConvictionAxis }
 * defaults match the project's tuned settings (15, 50, true).
 */

// Internal coord scale — matches Solidity COORD_SCALE
const SCALE = 10000;

// Minimum cuttable dimension (in SCALE units). 50 ≈ 0.5% of canvas.
const MIN_DIM = 50;

// PRNG noise on the base-cut ratio: ±NOISE_RANGE/2 (= ±5%)
const NOISE_RANGE = 1000;

// Tuned project defaults
const DEFAULT_DENSITY_MULT = 10;
const DEFAULT_MAX_SLIVER_PCT = 30;
const DEFAULT_USE_CONVICTION_AXIS = true;

// Salt density hard cap (protects against pathological N)
const SALT_K_CAP = 300;

// Base region selection: 20% random (area-weighted), 80% closest. Heavily
// home-territory biased — cross-quadrant color appears as rare accent.
const BASE_SCATTER_PROB = 20; // /100

// Local-quadrant color discount — matching color gets 3/10 = 30% of its weight
const LOCAL_Q_DISCOUNT_NUM = 3;
const LOCAL_Q_DISCOUNT_DEN = 10;

// Flat alpha for blending toward white (95% color + 5% white)
const FLAT_ALPHA = 95;

// Pure white background
const BG_R = 0xff, BG_G = 0xff, BG_B = 0xff;

// Four pure pastel corner colors, one per grid quadrant
const C_TL = [85, 255, 255];  // uniting  + performed — cyan
const C_TR = [85, 255, 85];   // uniting  + honest    — green
const C_BL = [255, 85, 85];   // dividing + performed — red
const C_BR = [85, 85, 255];   // dividing + honest    — blue

// ---------- PRNG (must match Solidity) ----------

// FNV-1a 32-bit. Operates byte-by-byte on the prompt string.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ (str.charCodeAt(i) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Numerical Recipes LCG. 32-bit state, 32-bit output.
function next32(state) {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

// ---------- Color / claim helpers ----------

function discreteColor(x, y) {
  if (x < 0.5 && y < 0.5) return C_TL;
  if (x >= 0.5 && y < 0.5) return C_TR;
  if (x < 0.5 && y >= 0.5) return C_BL;
  return C_BR;
}

// 0=TL, 1=TR, 2=BL, 3=BR — matches discreteColor's quadrant order
function quadrantIndex(x, y) {
  return (y < 0.5 ? 0 : 2) + (x < 0.5 ? 0 : 1);
}

// Integer blend of color channel toward white at FLAT_ALPHA. Must match Solidity.
function blendChannel(c, bg) {
  return Math.floor((c * FLAT_ALPHA + bg * (100 - FLAT_ALPHA)) / 100);
}

// Magnitude-driven claim share in scaled units. range [SCALE/2, 7000].
// claim = HALF + sqrt(magScaled) * 20 / 100. sqrt curve dampens extremes.
function sliceClaimScaled(px, py) {
  const HALF = SCALE / 2;
  const dx2 = Math.abs(px - HALF) * 2;
  const dy2 = Math.abs(py - HALF) * 2;
  const magScaled = dx2 > dy2 ? dx2 : dy2;
  const shapedScaled = Math.floor(Math.sqrt(magScaled * SCALE));
  return Math.floor(HALF + shapedScaled * 20 / 100);
}

// ---------- Color picker (count-weighted + local-quadrant discount) ----------

// Sample a color from baseWeights with the localQ entry discounted. Used by
// both salt and landlock so dominant-quadrant colors spread across the canvas
// while still being biased AWAY from their own corners.
// rngRef is a mutable holder { s: <state> }; the caller is responsible for
// reading rngRef.s back out if it wants to thread the state further.
function pickWeightedColor(baseWeights, localQ, rngRef, colorTable) {
  const w = [baseWeights[0], baseWeights[1], baseWeights[2], baseWeights[3]];
  w[localQ] = Math.floor(w[localQ] * LOCAL_Q_DISCOUNT_NUM / LOCAL_Q_DISCOUNT_DEN);
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

// ---------- Algorithm ----------

/**
 * Compute the final region list. Returns [{ x, y, w, h, r, g, b }] in SCALE units.
 * Pure (no canvas) so the same function feeds Canvas, SVG, and Solidity outputs.
 */
function computeRegions(points, prompt, opts) {
  // No submissions = blank piece. Skip landlock + salt so the canvas stays white.
  if (points.length === 0) {
    return [{ x: 0, y: 0, w: SCALE, h: SCALE, r: BG_R, g: BG_G, b: BG_B }];
  }

  const densityMult         = (opts && opts.densityMult         != null) ? opts.densityMult         : DEFAULT_DENSITY_MULT;
  const maxSliverPct        = (opts && opts.maxSliverPct        != null) ? opts.maxSliverPct        : DEFAULT_MAX_SLIVER_PCT;
  const useConvictionAxis   = (opts && opts.useConvictionAxis   != null) ? opts.useConvictionAxis   : DEFAULT_USE_CONVICTION_AXIS;

  const colorTable = [C_TL, C_TR, C_BL, C_BR];

  // Per-quadrant submission counts → color weights for landlock + salt.
  // +1 floor per quadrant so unanimous-quadrant days don't collapse to a single
  // color: with weights [N,0,0,0] the local discount has nothing to redistribute
  // to, so every non-dominant region is forced to the dominant color. The floor
  // gives salt/landlock a baseline of "all four colors exist" without distorting
  // the distribution at non-trivial N.
  const counts = [0, 0, 0, 0];
  for (const p of points) counts[quadrantIndex(p.x, p.y)]++;
  const baseWeights = [counts[0] + 1, counts[1] + 1, counts[2] + 1, counts[3] + 1];

  // Independent RNG streams seeded by prompt (and a suffix for salt) so they
  // don't collide. baseRng is mutated through the base loop; saltRng through
  // the salt loop; shuffleRng for the Fisher-Yates only.
  const promptHash = fnv1a32(prompt || '');
  let baseRng = promptHash;
  let shuffleRng = promptHash;
  let saltRng = fnv1a32((prompt || '') + '\x00salt');

  // === BASE LAYER ===
  const regions = [{ x: 0, y: 0, w: SCALE, h: SCALE, r: BG_R, g: BG_G, b: BG_B }];

  // Deterministic Fisher-Yates shuffle so submission order doesn't matter
  const ordered = points.slice();
  for (let i = ordered.length - 1; i > 0; i--) {
    shuffleRng = next32(shuffleRng);
    const j = shuffleRng % (i + 1);
    const tmp = ordered[i]; ordered[i] = ordered[j]; ordered[j] = tmp;
  }

  for (const p of ordered) {
    const px = Math.max(0, Math.min(SCALE, Math.round(p.x * SCALE)));
    const py = Math.max(0, Math.min(SCALE, Math.round(p.y * SCALE)));

    // Region selection: random (area-weighted) BASE_SCATTER_PROB% of the time,
    // else closest. Mixed scatter lets any color appear in any quadrant while
    // preserving some territorial sense.
    baseRng = next32(baseRng);
    const useScatter = (baseRng % 100) < BASE_SCATTER_PROB;

    let bestIdx = -1;
    if (useScatter) {
      let totalArea = 0;
      const cuttableIdx = [];
      const cumArea = [];
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
        const dx = cx - px, dy = cy - py;
        const s = dx * dx + dy * dy;
        if (bestIdx === -1 || s < bestScore) { bestScore = s; bestIdx = i; }
      }
      if (bestIdx === -1) continue;
    }
    const reg = regions[bestIdx];

    // Cut direction: per-axis magnitude probabilistically picks vertical vs.
    // horizontal when conviction-axis is on. splitWidth=true means a vertical
    // cut (splits left/right — matches the x-axis Honest/Performed line).
    // splitWidth=false is horizontal (splits top/bottom — matches y-axis).
    let splitWidth;
    if (useConvictionAxis) {
      const xMag = Math.abs(2 * px - SCALE);
      const yMag = Math.abs(2 * py - SCALE);
      const totalMag = xMag + yMag;
      baseRng = next32(baseRng);
      if (totalMag === 0) {
        splitWidth = (baseRng & 1) === 0;
      } else {
        const pVertScaled = Math.floor(xMag * SCALE / totalMag);
        splitWidth = (baseRng % SCALE) < pVertScaled;
      }
    } else {
      // Legacy rule: x-sign + longer/shorter heuristic
      const wLonger = reg.w >= reg.h;
      const gx = 2 * px - SCALE;
      splitWidth = (gx >= 0) ? wLonger : !wLonger;
    }
    if (splitWidth && reg.w < 2 * MIN_DIM) splitWidth = false;
    else if (!splitWidth && reg.h < 2 * MIN_DIM) splitWidth = true;

    // Cut position from magnitude-driven claim share
    const claimedShareScaled = sliceClaimScaled(px, py);

    // PRNG flip for paint-side (the submission isn't necessarily "in" this
    // region since region selection may have been random)
    baseRng = next32(baseRng);
    const paintLow = (baseRng & 1) === 0;
    const baseRatio = paintLow ? claimedShareScaled : (SCALE - claimedShareScaled);

    baseRng = next32(baseRng);
    let ratio = baseRatio + ((baseRng % (NOISE_RANGE + 1)) - NOISE_RANGE / 2);
    if (ratio < 1500) ratio = 1500;
    if (ratio > 8500) ratio = 8500;

    const dim = splitWidth ? reg.w : reg.h;
    let cutPos = Math.floor(dim * ratio / SCALE);
    if (cutPos < MIN_DIM) cutPos = MIN_DIM;
    if (cutPos > dim - MIN_DIM) cutPos = dim - MIN_DIM;

    let r1, r2;
    if (splitWidth) {
      r1 = { x: reg.x, y: reg.y, w: cutPos, h: reg.h };
      r2 = { x: reg.x + cutPos, y: reg.y, w: reg.w - cutPos, h: reg.h };
    } else {
      r1 = { x: reg.x, y: reg.y, w: reg.w, h: cutPos };
      r2 = { x: reg.x, y: reg.y + cutPos, w: reg.w, h: reg.h - cutPos };
    }
    const nc = discreteColor(p.x, p.y);
    if (paintLow) {
      r1.r = nc[0]; r1.g = nc[1]; r1.b = nc[2]; r2.r = reg.r; r2.g = reg.g; r2.b = reg.b;
    } else {
      r2.r = nc[0]; r2.g = nc[1]; r2.b = nc[2]; r1.r = reg.r; r1.g = reg.g; r1.b = reg.b;
    }
    regions.splice(bestIdx, 1, r1, r2);
  }

  // === LANDLOCK ===
  // ALL remaining white regions are recolored via the count-weighted +
  // locally-discounted picker — edge-touching and interior alike. No white
  // shows through in the final piece.
  const baseRngRef = { s: baseRng };
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
  // K tiny boxes scattered at prompt-seeded random positions. Each is a
  // double-cut (perpendicular edge-biased cuts) producing a small rect at
  // one corner of a randomly-chosen region. Salt color uses the same
  // count-weighted + locally-discounted distribution as landlock.
  // Salt density falls off with N: peaks at low-N (when salt is most visually
  // useful) and shrinks at high-N (when the base layer already carries detail).
  // K = density × 120 / (20 + floor(sqrt(N))). Uses floor(sqrt) so the
  // Solidity isqrt port produces identical K.
  const sqrtN = Math.floor(Math.sqrt(points.length));
  const K = Math.min(SALT_K_CAP, Math.ceil(densityMult * 120 / (20 + sqrtN)));
  const SLIVER_MIN = 100;
  const sliverMaxU = Math.max(SLIVER_MIN + 1, maxSliverPct * 100);
  const sliverSpan = sliverMaxU - SLIVER_MIN + 1;

  const saltRngRef = { s: saltRng };
  function pickEdgeBiased() {
    saltRngRef.s = next32(saltRngRef.s);
    const nearLow = (saltRngRef.s & 1) === 0;
    saltRngRef.s = next32(saltRngRef.s);
    const ratio = nearLow
      ? SLIVER_MIN + (saltRngRef.s % sliverSpan)
      : (SCALE - sliverMaxU) + (saltRngRef.s % sliverSpan);
    return { ratio, nearLow };
  }

  for (let k = 0; k < K; k++) {
    // Pick region area-weighted
    let totalArea = 0;
    const cuttableIdx = [];
    const cumArea = [];
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

    // First cut: random axis (fall back if forbidden), edge-biased position
    saltRngRef.s = next32(saltRngRef.s);
    let splitWidth1 = (saltRngRef.s & 1) === 0;
    if (splitWidth1 && reg.w < 2 * MIN_DIM) splitWidth1 = false;
    else if (!splitWidth1 && reg.h < 2 * MIN_DIM) splitWidth1 = true;

    const dim1 = splitWidth1 ? reg.w : reg.h;
    const cut1 = pickEdgeBiased();
    let cutPos1 = Math.floor(dim1 * cut1.ratio / SCALE);
    if (cutPos1 < MIN_DIM) cutPos1 = MIN_DIM;
    if (cutPos1 > dim1 - MIN_DIM) cutPos1 = dim1 - MIN_DIM;

    let sliver, remainder;
    if (splitWidth1) {
      const left  = { x: reg.x,           y: reg.y, w: cutPos1,         h: reg.h, r: reg.r, g: reg.g, b: reg.b };
      const right = { x: reg.x + cutPos1, y: reg.y, w: reg.w - cutPos1, h: reg.h, r: reg.r, g: reg.g, b: reg.b };
      sliver    = cut1.nearLow ? left  : right;
      remainder = cut1.nearLow ? right : left;
    } else {
      const top = { x: reg.x, y: reg.y,           w: reg.w, h: cutPos1,         r: reg.r, g: reg.g, b: reg.b };
      const bot = { x: reg.x, y: reg.y + cutPos1, w: reg.w, h: reg.h - cutPos1, r: reg.r, g: reg.g, b: reg.b };
      sliver    = cut1.nearLow ? top : bot;
      remainder = cut1.nearLow ? bot : top;
    }

    // Salt color from count-weighted + locally-discounted picker
    const regCx = reg.x + reg.w / 2;
    const regCy = reg.y + reg.h / 2;
    const localQ = (regCy < SCALE / 2 ? 0 : 2) + (regCx < SCALE / 2 ? 0 : 1);
    const nc = pickWeightedColor(baseWeights, localQ, saltRngRef, colorTable);

    // Second cut: perpendicular to the first. Turns the strip into a small box
    // at one corner of the parent region. Fall back to painting the whole strip
    // if it can't accommodate a second cut.
    const splitWidth2 = !splitWidth1;
    const dim2 = splitWidth2 ? sliver.w : sliver.h;
    if (dim2 < 2 * MIN_DIM) {
      sliver.r = nc[0]; sliver.g = nc[1]; sliver.b = nc[2];
      regions.splice(idx, 1, sliver, remainder);
    } else {
      const cut2 = pickEdgeBiased();
      let cutPos2 = Math.floor(dim2 * cut2.ratio / SCALE);
      if (cutPos2 < MIN_DIM) cutPos2 = MIN_DIM;
      if (cutPos2 > dim2 - MIN_DIM) cutPos2 = dim2 - MIN_DIM;

      let tinyBox, sliverRest;
      if (splitWidth2) {
        const a = { x: sliver.x,           y: sliver.y, w: cutPos2,            h: sliver.h, r: sliver.r, g: sliver.g, b: sliver.b };
        const b = { x: sliver.x + cutPos2, y: sliver.y, w: sliver.w - cutPos2, h: sliver.h, r: sliver.r, g: sliver.g, b: sliver.b };
        tinyBox    = cut2.nearLow ? a : b;
        sliverRest = cut2.nearLow ? b : a;
      } else {
        const a = { x: sliver.x, y: sliver.y,           w: sliver.w, h: cutPos2,            r: sliver.r, g: sliver.g, b: sliver.b };
        const b = { x: sliver.x, y: sliver.y + cutPos2, w: sliver.w, h: sliver.h - cutPos2, r: sliver.r, g: sliver.g, b: sliver.b };
        tinyBox    = cut2.nearLow ? a : b;
        sliverRest = cut2.nearLow ? b : a;
      }
      tinyBox.r = nc[0]; tinyBox.g = nc[1]; tinyBox.b = nc[2];
      regions.splice(idx, 1, tinyBox, sliverRest, remainder);
    }
  }

  return regions;
}

/**
 * Render onto a canvas 2D context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W - canvas width
 * @param {number} H - canvas height
 * @param {{ x: number, y: number }[]} points
 * @param {string} prompt - the day's word (PRNG seed)
 * @param {Object} [opts] - { densityMult, maxSliverPct, useConvictionAxis }
 */
function renderSubdivision(ctx, W, H, points, prompt, opts) {
  ctx.fillStyle = `rgb(${BG_R},${BG_G},${BG_B})`;
  ctx.fillRect(0, 0, W, H);

  const regions = computeRegions(points, prompt, opts);

  for (const reg of regions) {
    const r = blendChannel(reg.r, BG_R);
    const g = blendChannel(reg.g, BG_G);
    const b = blendChannel(reg.b, BG_B);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    // Snap to integer pixel grid so adjacent same-color rects share an exact
    // boundary — otherwise canvas anti-aliases each edge and leaves a faint
    // seam between them.
    const x0 = Math.round(reg.x * W / SCALE);
    const y0 = Math.round(reg.y * H / SCALE);
    const x1 = Math.round((reg.x + reg.w) * W / SCALE);
    const y1 = Math.round((reg.y + reg.h) * H / SCALE);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    renderSubdivision,
    computeRegions,
    fnv1a32,
    next32,
    discreteColor,
    quadrantIndex,
    blendChannel,
    sliceClaimScaled,
    pickWeightedColor,
    SCALE,
    MIN_DIM,
    NOISE_RANGE,
    FLAT_ALPHA,
    DEFAULT_DENSITY_MULT,
    DEFAULT_MAX_SLIVER_PCT,
    DEFAULT_USE_CONVICTION_AXIS,
    SALT_K_CAP,
    BASE_SCATTER_PROB,
    LOCAL_Q_DISCOUNT_NUM,
    LOCAL_Q_DISCOUNT_DEN,
  };
} else if (typeof window !== "undefined") {
  window.renderSubdivision = renderSubdivision;
  window.computeRegions = computeRegions;
  window.discreteColor = discreteColor;
  window.SCALE = SCALE;
}
