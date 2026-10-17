// PHOENIX emblem – the one canonical logo, defined as pen strokes (cubic bezier chains).
// Ported from the WARP prototype (S / ringStroke / emblemPolylines / drawPjs / invDrawP) and
// reshaped into a majestic rising phoenix (crown plumes, raised flame wings, long flame tail).
//
// Emblem units: the ring has radius 1.10, y points UP, the bird is mirrored around x = 0.
// Every stroke carries a reveal window t:[t0,t1] in "pen order" (0..1). Particles sampled along a
// stroke keep that value as their assembly order, the neon line draws in the same order, and the
// SVG export (svg.js) uses the very same polylines – so app icon, header logo and FX always match.

export const EMB_EXT = 1.45; // distance texture covers [-EXT, EXT]^2 (emblem units)
export const EMB_R = 0.2; // bake radius: the line glow must reach 0 here

// Each stroke: chain of cubic segments [x0,y0, c1x,c1y, c2x,c2y, x1,y1, c1x,c1y, c2x,c2y, x2,y2, ...]
// t: reveal window (pen order), w: line width factor, m: 1 = mirrored to the left half,
// g: group (body | crest | wing | tail | ring) for colouring, f: closed fill silhouette id (or null).
export const S = [
  // body: crown -> round head -> neck -> broad breast -> waist (mirrored -> torso with a real head)
  { c: [0, 0.86, 0.048, 0.86, 0.074, 0.82, 0.074, 0.775, 0.074, 0.73, 0.058, 0.7, 0.056, 0.665,
        0.062, 0.6, 0.135, 0.55, 0.14, 0.42, 0.145, 0.26, 0.075, 0.08, 0.042, -0.06, 0.026, -0.16, 0.012, -0.24, 0, -0.3], t: [0.0, 0.2], w: 1.0, m: 1, g: 'body' },
  // hooked beak
  { c: [-0.028, 0.775, -0.013, 0.76, -0.005, 0.735, 0, 0.705, 0.005, 0.735, 0.013, 0.76, 0.028, 0.775], t: [0.14, 0.2], w: 0.6, m: 0, g: 'body' },
  // crown of fire: centre flame (mirrored -> closed drop) and one swept flame per side
  { c: [0, 0.86, 0.04, 0.9, 0.035, 0.96, 0, 1.05], t: [0.12, 0.22], w: 0.75, m: 1, g: 'crest' },
  { c: [0.05, 0.85, 0.09, 0.88, 0.1, 0.93, 0.165, 0.99], t: [0.13, 0.24], w: 0.7, m: 1, g: 'crest' },
  // wing leading edge: shoulder -> tip (raised V wing)
  { c: [0.12, 0.47, 0.32, 0.56, 0.62, 0.7, 0.9, 1.0], t: [0.24, 0.46], w: 1.0, m: 1, g: 'wing', f: 'wing' },
  // wing trailing edge: four flame feathers back to the body
  { c: [0.9, 1.0, 0.86, 0.87, 0.76, 0.75, 0.68, 0.67,
        0.8, 0.72, 0.92, 0.75, 1.01, 0.8,
        0.93, 0.64, 0.77, 0.53, 0.64, 0.47,
        0.76, 0.48, 0.88, 0.5, 0.97, 0.53,
        0.85, 0.38, 0.67, 0.29, 0.54, 0.26,
        0.63, 0.24, 0.73, 0.22, 0.81, 0.21,
        0.62, 0.06, 0.28, 0.04, 0.1, 0.13], t: [0.46, 0.8], w: 0.9, m: 1, g: 'wing', f: 'wing' },
  // feather shafts fanning out from the shoulder
  { c: [0.14, 0.41, 0.3, 0.48, 0.5, 0.58, 0.68, 0.67], t: [0.5, 0.7], w: 0.55, m: 1, g: 'wing' },
  { c: [0.14, 0.33, 0.3, 0.36, 0.48, 0.42, 0.64, 0.47], t: [0.56, 0.74], w: 0.55, m: 1, g: 'wing' },
  { c: [0.13, 0.24, 0.26, 0.25, 0.4, 0.26, 0.54, 0.26], t: [0.62, 0.78], w: 0.55, m: 1, g: 'wing' },
  // tail: three long flame plumes trailing downward, tips flick outward
  { c: [0.05, -0.21, 0.19, -0.3, 0.31, -0.5, 0.35, -0.69,
        0.38, -0.81, 0.45, -0.91, 0.55, -0.97,
        0.42, -0.96, 0.31, -0.89, 0.25, -0.8,
        0.24, -0.9, 0.24, -0.98, 0.27, -1.06,
        0.18, -1.02, 0.12, -0.95, 0.09, -0.87,
        0.07, -0.96, 0.04, -1.04, 0, -1.1], t: [0.18, 0.52], w: 0.95, m: 1, g: 'tail', f: 'tail' },
  // tail flame shafts
  { c: [0.02, -0.29, 0.12, -0.42, 0.2, -0.6, 0.25, -0.8], t: [0.4, 0.56], w: 0.55, m: 1, g: 'tail' },
  { c: [0.0, -0.33, 0.03, -0.52, 0.06, -0.7, 0.09, -0.87], t: [0.44, 0.6], w: 0.55, m: 1, g: 'tail' },
  // heart flame on the chest
  { c: [0, 0.46, 0.022, 0.42, 0.045, 0.38, 0.055, 0.34, 0.05, 0.3, 0.028, 0.26, 0, 0.22], t: [0.82, 0.95], w: 0.65, m: 1, g: 'body' },
];

export function ringStroke() {
  // arc from the bottom (-90 deg) up to 34 deg on the right; mirrored -> gap at the top for the crown
  const R = 1.1;
  const a0 = -Math.PI / 2;
  const a1 = (34 / 180) * Math.PI;
  const n = 140;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    pts.push([Math.cos(a) * R, Math.sin(a) * R]);
  }
  return { pts, t: [0.66, 1.0], w: 0.5, m: 1, g: 'ring' };
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
 * All strokes as polylines: { pts:[[x,y]...], rev:[...] (pen order per point), w, len, g, side, f }.
 * Mirrored strokes appear twice (right half first).
 */
export function emblemPolylines() {
  const out = [];
  const push = (pts, t, w, mirror, g, f) => {
    const L = [0];
    for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const tot = L[L.length - 1] || 1;
    const rev = L.map((l) => t[0] + (t[1] - t[0]) * (l / tot));
    out.push({ pts, rev, w, len: tot, g, side: 1, f: f || null });
    if (mirror) out.push({ pts: pts.map(([x, y]) => [-x, y]), rev: rev.slice(), w, len: tot, g, side: -1, f: f || null });
  };
  for (const s of S) push(chainPoints(s.c), s.t, s.w, s.m, s.g, s.f);
  const r = ringStroke();
  push(r.pts, r.t, r.w, r.m, r.g, null);
  return out;
}

/**
 * Closed silhouettes for fills (wing membranes, tail, torso): arrays of polygons in emblem units.
 * Used by the heat/mask raster, the fill particles and the SVG export.
 */
export function emblemSilhouettes() {
  const polys = [];
  const mirror = (pts) => pts.map(([x, y]) => [-x, y]);
  // wings: leading edge + trailing edge (closes along the body)
  const lead = chainPoints(S.find((s) => s.f === 'wing').c, 32);
  const trail = chainPoints(S.filter((s) => s.f === 'wing')[1].c, 24);
  const wing = lead.concat(trail.slice(1));
  polys.push({ g: 'wing', pts: wing }, { g: 'wing', pts: mirror(wing) });
  // tail: right outline + mirrored left outline reversed
  const tailR = chainPoints(S.find((s) => s.f === 'tail').c, 24);
  polys.push({ g: 'tail', pts: tailR.concat(mirror(tailR).reverse().slice(1)) });
  // torso
  const bodyR = chainPoints(S[0].c, 32);
  polys.push({ g: 'body', pts: bodyR.concat(mirror(bodyR).reverse().slice(1)) });
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
