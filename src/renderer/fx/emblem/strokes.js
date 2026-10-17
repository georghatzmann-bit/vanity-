// PHOENIX emblem – the one canonical logo, defined as pen strokes (cubic bezier chains).
// Ported from the WARP prototype (S / ringStroke / emblemPolylines / drawPjs / invDrawP) and
// reshaped into a majestic rising phoenix: head in profile with a hooked beak and a swept flame
// crest, raised "displayed" wings with six fanned primaries that break out of the ring, and a
// three-plume flame tail.
//
// Emblem units: the ring has radius 1.10, y points UP. Strokes with m = 1 are mirrored to the left.
// Every stroke carries a reveal window t:[t0,t1] in "pen order" (0..1). Particles sampled along a
// stroke keep that value as their assembly order, the neon line draws in the same order, and the
// SVG export (svg.js) uses the very same strokes – so app icon, header logo and FX always match.

export const EMB_EXT = 1.45; // distance texture covers [-EXT, EXT]^2 (emblem units)
export const EMB_R = 0.2; // bake radius: the line glow must reach 0 here
export const RING_R = 1.1;
const RING_END_DEG = 12; // ring arc: bottom (-90°) up to +12° on both sides -> wide gap on top

// ---- wing primaries: generated from a pivot + fanned feather tips (keeps the feathers even) ----
const PIV = [0.12, 0.36];
const TIPS = [
  [43.5, 1.1],
  [33, 1.08],
  [22, 1.02],
  [11, 0.93],
  [0, 0.8],
  [-12, 0.64],
];
const ROOT = [0.15, 0.13];
const VALLEY = 0.82; // notch depth between primaries (fraction of the shorter feather)
const LOWB = 0.1; // bulge of a feather's lower edge
const UPB = 0.18; // bulge of the next feather's upper edge
const UPS = 0; // 0 = C-curve, <0 = S-curve
const polar = (deg, r) => [PIV[0] + Math.cos((deg * Math.PI) / 180) * r, PIV[1] + Math.sin((deg * Math.PI) / 180) * r];

function featherChain() {
  const tips = TIPS.map(([a, r]) => polar(a, r));
  const pts = [];
  const seg = (A, B, bulge, shape) => {
    // A -> B as one cubic; bulge pushes the curve along the left normal (flame-tongue edges)
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const nx = -dy;
    const ny = dx;
    const c1 = [A[0] + dx * shape[0] + nx * bulge, A[1] + dy * shape[0] + ny * bulge];
    const c2 = [A[0] + dx * shape[1] + nx * bulge * shape[2], A[1] + dy * shape[1] + ny * bulge * shape[2]];
    pts.push(c1[0], c1[1], c2[0], c2[1], B[0], B[1]);
  };
  pts.push(tips[0][0], tips[0][1]);
  for (let i = 0; i < tips.length; i++) {
    const a0 = TIPS[i][0];
    const r0 = TIPS[i][1];
    if (i < tips.length - 1) {
      const a1 = TIPS[i + 1][0];
      const r1 = TIPS[i + 1][1];
      const valley = polar((a0 + a1) / 2, VALLEY * Math.min(r0, r1));
      // lower edge of feather i: tip -> valley, upper edge of feather i+1: valley -> tip (flame tongue)
      seg(tips[i], valley, LOWB, [0.3, 0.75, 0.4]);
      seg(valley, tips[i + 1], UPB, [0.3, 0.72, UPS]);
    } else {
      seg(tips[i], ROOT, -0.1, [0.35, 0.75, 0.3]);
    }
  }
  return pts;
}

function shaft(i, len = 0.86) {
  // feather separation line from the shoulder towards the valley between primaries i and i+1
  const a = (TIPS[i][0] + TIPS[i + 1][0]) / 2;
  const r = 0.7 * Math.min(TIPS[i][1], TIPS[i + 1][1]) * len;
  const s = polar(a, 0.12);
  const e = polar(a, r);
  const m1 = polar(a + 2.5, 0.12 + (r - 0.12) * 0.35);
  const m2 = polar(a + 1.5, 0.12 + (r - 0.12) * 0.7);
  return [s[0], s[1], m1[0], m1[1], m2[0], m2[1], e[0], e[1]];
}

// Each stroke: chain of cubic segments [x0,y0, c1x,c1y, c2x,c2y, x1,y1, c1x,c1y, c2x,c2y, x2,y2, ...]
// id: name, t: reveal window (pen order), w: line width factor, m: 1 = mirrored to the left half,
// g: group (body | crest | wing | tail | ring) for colouring.
export const S = [
  // torso: neck base -> shoulder -> broad chest -> waist -> tail root (mirrored -> closed torso)
  { id: 'torso', c: [0.085, 0.52, 0.13, 0.48, 0.175, 0.41, 0.175, 0.3,
        0.175, 0.16, 0.105, 0.02, 0.06, -0.1,
        0.04, -0.17, 0.02, -0.23, 0, -0.28], t: [0.0, 0.16], w: 1.0, m: 1, g: 'body' },
  // head in profile (facing right): nape -> crown -> hooked beak -> throat -> front of the neck
  { id: 'head', c: [-0.085, 0.52, -0.11, 0.6, -0.085, 0.7, -0.025, 0.765,
        0.03, 0.82, 0.1, 0.84, 0.155, 0.81,
        0.195, 0.79, 0.235, 0.77, 0.275, 0.745,
        0.315, 0.72, 0.33, 0.675, 0.305, 0.635,
        0.285, 0.665, 0.245, 0.69, 0.2, 0.69,
        0.15, 0.69, 0.11, 0.655, 0.1, 0.6,
        0.092, 0.565, 0.088, 0.54, 0.085, 0.52], t: [0.06, 0.2], w: 1.0, m: 0, g: 'body' },
  // eye
  { id: 'eye', c: [0.125, 0.755, 0.145, 0.772, 0.17, 0.774, 0.192, 0.762], t: [0.19, 0.22], w: 0.6, m: 0, g: 'body' },
  // swept-back crest: three flame tongues along the back of the head
  { id: 'crest', c: [0.08, 0.835, 0.075, 0.93, 0.0, 1.03, -0.13, 1.1,
        -0.05, 1.0, -0.02, 0.9, -0.012, 0.805,
        -0.07, 0.88, -0.17, 0.94, -0.31, 0.965,
        -0.19, 0.9, -0.11, 0.82, -0.065, 0.75,
        -0.13, 0.78, -0.22, 0.78, -0.33, 0.73,
        -0.22, 0.71, -0.14, 0.69, -0.09, 0.655], t: [0.13, 0.26], w: 0.8, m: 0, g: 'crest' },
  // wing leading edge: shoulder -> raised wing tip (breaks out of the ring)
  { id: 'wingLead', c: [0.16, 0.44, 0.33, 0.55, 0.56, 0.68, 0.72, 0.85,
        0.8, 0.94, 0.86, 1.02, polar(43.5, 1.1)[0], polar(43.5, 1.1)[1]], t: [0.24, 0.42], w: 1.0, m: 1, g: 'wing' },
  // wing trailing edge: six fanned primaries back to the body
  { id: 'wingTrail', c: featherChain(), t: [0.4, 0.68], w: 0.9, m: 1, g: 'wing' },
  // feather separation lines fanning out from the shoulder
  { id: 'shaft1', c: shaft(0), t: [0.46, 0.62], w: 0.5, m: 1, g: 'wing' },
  { id: 'shaft2', c: shaft(1), t: [0.5, 0.65], w: 0.5, m: 1, g: 'wing' },
  { id: 'shaft3', c: shaft(2), t: [0.54, 0.68], w: 0.5, m: 1, g: 'wing' },
  { id: 'shaft4', c: shaft(3), t: [0.58, 0.7], w: 0.5, m: 1, g: 'wing' },
  // tail: two flame plumes flicking outward + the long centre plume (mirrored -> closed outline)
  { id: 'tail', c: [0.05, -0.22, 0.22, -0.29, 0.4, -0.43, 0.49, -0.62,
        0.57, -0.78, 0.6, -0.92, 0.71, -1.04,
        0.57, -1.0, 0.45, -0.92, 0.38, -0.8,
        0.3, -0.66, 0.2, -0.52, 0.13, -0.44,
        0.15, -0.66, 0.1, -0.92, 0, -1.17], t: [0.56, 0.8], w: 0.95, m: 1, g: 'tail' },
  // tail flame shafts
  { id: 'tailShaft', c: [0.04, -0.3, 0.2, -0.44, 0.36, -0.62, 0.47, -0.84], t: [0.66, 0.82], w: 0.5, m: 1, g: 'tail' },
  { id: 'tailMid', c: [0, -0.34, 0.012, -0.58, 0.01, -0.8, 0, -1.02], t: [0.68, 0.84], w: 0.5, m: 0, g: 'tail' },
];

const byId = (id) => S.find((s) => s.id === id);

export function ringStroke() {
  // arc from the bottom (-90 deg) up to RING_END_DEG on the right; mirrored -> wide gap on top
  const a0 = -Math.PI / 2;
  const a1 = (RING_END_DEG / 180) * Math.PI;
  const n = 140;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    pts.push([Math.cos(a) * RING_R, Math.sin(a) * RING_R]);
  }
  return { pts, t: [0.78, 1.0], w: 0.5, m: 1, g: 'ring' };
}

function cubic(p0, p1, p2, p3, u) {
  const v = 1 - u;
  return [
    v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0],
    v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1],
  ];
}

/** Flattens one bezier chain into points (n samples per segment). */
export function chainPoints(c, n = 48) {
  const pts = [];
  const nseg = (c.length - 2) / 6;
  for (let k = 0; k < nseg; k++) {
    const o = k * 6;
    const p0 = [c[o], c[o + 1]];
    const p1 = [c[o + 2], c[o + 3]];
    const p2 = [c[o + 4], c[o + 5]];
    const p3 = [c[o + 6], c[o + 7]];
    for (let i = k === 0 ? 0 : 1; i <= n; i++) pts.push(cubic(p0, p1, p2, p3, i / n));
  }
  return pts;
}

/**
 * All strokes as polylines: { pts:[[x,y]...], rev:[...] (pen order per point), w, len, g, side }.
 * Mirrored strokes appear twice (right half first).
 */
export function emblemPolylines() {
  const out = [];
  const push = (pts, t, w, mirror, g, id) => {
    const L = [0];
    for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const tot = L[L.length - 1] || 1;
    const rev = L.map((l) => t[0] + (t[1] - t[0]) * (l / tot));
    out.push({ pts, rev, w, len: tot, g, side: 1, id });
    if (mirror) out.push({ pts: pts.map(([x, y]) => [-x, y]), rev: rev.slice(), w, len: tot, g, side: -1, id });
  };
  for (const s of S) push(chainPoints(s.c, s.c.length > 20 ? 16 : 32), s.t, s.w, s.m, s.g, s.id);
  const r = ringStroke();
  push(r.pts, r.t, r.w, r.m, r.g, 'ring');
  return out;
}

/**
 * Closed silhouettes for fills (wing membranes, tail, torso + head): polygons in emblem units.
 * Used by the heat/mask raster, the fill particles and the SVG export.
 */
export function emblemSilhouettes() {
  const polys = [];
  const mirror = (pts) => pts.map(([x, y]) => [-x, y]);
  const wing = chainPoints(byId('wingLead').c, 32).concat(chainPoints(byId('wingTrail').c, 16).slice(1));
  polys.push({ g: 'wing', pts: wing }, { g: 'wing', pts: mirror(wing) });
  const tailR = chainPoints(byId('tail').c, 24);
  polys.push({ g: 'tail', pts: tailR.concat(mirror(tailR).reverse().slice(1)) });
  const torsoR = chainPoints(byId('torso').c, 32);
  const head = chainPoints(byId('head').c, 16);
  // left torso side (reversed: tail root -> left neck base), head (left neck -> right neck), right torso side
  polys.push({ g: 'body', pts: mirror(torsoR).reverse().concat(head.slice(1), torsoR.slice(1)) });
  return polys;
}

// drawP: the GLSL pen easing (mirrored here for emission times) and its inverse.
export function drawPjs(x) {
  x = Math.min(1, Math.max(0, x));
  return x + (x * x * (3 - 2 * x) - x) * 0.6;
}

export function invDrawP(P) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (drawPjs(m) < P) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
