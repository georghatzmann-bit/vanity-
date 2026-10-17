// Emblem rasters and particle sampling.
//  - bakeEmblem: distance/reveal-time texture of the strokes (WARP, verbatim algorithm)
//  - rasterHeat: blurred emblem + wordmark silhouette for the plasma heat (PLASMA drawHeat, adapted)
//  - sampleEmblem / sampleWord: particle targets; emblem particles sit ON the strokes and keep the
//    stroke's pen order (rev) as their assembly order, so the bird builds in pen order.
// Everything is deterministic (seeded PRNG) so frames are reproducible.
import { EMB_EXT, emblemPolylines, emblemSilhouettes } from './strokes.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iy) {
  let h = (ix * 374761393 + iy * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise (burn order). */
export function vnoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/**
 * Local "splat" distance bake: each segment only touches texels within R of itself.
 * Returns { N, dist, rev, wid } – dist in emblem units, rev = pen order of the nearest stroke point.
 */
export function bakeEmblem(polys, N = 512, R = 0.17) {
  const ext = EMB_EXT;
  const texel = (2 * ext) / N;
  const dist = new Float32Array(N * N).fill(R);
  const rev = new Float32Array(N * N).fill(2.0);
  const wid = new Float32Array(N * N).fill(1.0);
  const rT = Math.ceil(R / texel) + 1;
  for (const pl of polys) {
    const P = pl.pts;
    const V = pl.rev;
    for (let i = 0; i < P.length - 1; i++) {
      const ax = P[i][0];
      const ay = P[i][1];
      const bx = P[i + 1][0];
      const by = P[i + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const dd = dx * dx + dy * dy || 1e-12;
      const ra = V[i];
      const rb = V[i + 1];
      const x0 = Math.max(0, Math.floor((Math.min(ax, bx) + ext) / texel) - rT);
      const x1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + ext) / texel) + rT);
      const y0 = Math.max(0, Math.floor((Math.min(ay, by) + ext) / texel) - rT);
      const y1 = Math.min(N - 1, Math.ceil((Math.max(ay, by) + ext) / texel) + rT);
      for (let y = y0; y <= y1; y++) {
        const py = -ext + (y + 0.5) * texel;
        for (let x = x0; x <= x1; x++) {
          const px = -ext + (x + 0.5) * texel;
          let h = ((px - ax) * dx + (py - ay) * dy) / dd;
          h = h < 0 ? 0 : h > 1 ? 1 : h;
          const ex = px - ax - h * dx;
          const ey = py - ay - h * dy;
          const d = Math.sqrt(ex * ex + ey * ey);
          const idx = y * N + x;
          if (d < dist[idx]) {
            dist[idx] = d;
            rev[idx] = ra + h * (rb - ra);
            wid[idx] = pl.w;
          }
        }
      }
    }
  }
  return { N, dist, rev, wid };
}

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Logo-local frame used by the heat texture: emblem units, emblem centred at 0, the wordmark sits
 * below it at WORD_DY with height WORD_H (the boot / success layout).
 */
export const HEAT_BOX = { x0: -1.85, x1: 1.85, y0: -2.1, y1: 1.5 };
export const WORD_DY = -1.62;
export const WORD_H = 0.62;

/** Draws the emblem silhouette (membranes filled, strokes drawn) into ctx with the given transform. */
function drawSilhouette(ctx, toPx, scalePx, polys, sils, alphaFill = 0.55, lineW = 0.035) {
  ctx.fillStyle = `rgba(255,255,255,${alphaFill})`;
  for (const s of sils) {
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => {
      const [px, py] = toPx(x, y);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pl of polys) {
    ctx.lineWidth = Math.max(1, lineW * pl.w * scalePx);
    ctx.beginPath();
    pl.pts.forEach(([x, y], i) => {
      const [px, py] = toPx(x, y);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
}

/**
 * Heat texture (RGBA8, rows bottom-up = y up): R = soft emblem heat, G = sharp emblem mask,
 * B = soft wordmark heat, A = sharp wordmark mask. Covers HEAT_BOX in logo-local units.
 */
export function rasterHeat(polys, wordCanvas, wordInfo, size = 256) {
  const bw = HEAT_BOX.x1 - HEAT_BOX.x0;
  const bh = HEAT_BOX.y1 - HEAT_BOX.y0;
  const w = size;
  const h = Math.round((size * bh) / bw);
  const sils = emblemSilhouettes();
  const scalePx = w / bw;
  const toPx = (x, y) => [(x - HEAT_BOX.x0) * scalePx, (HEAT_BOX.y1 - y) * scalePx];
  const layer = (blur, fillA, word) => {
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (blur) ctx.filter = `blur(${blur}px)`;
    if (!word) drawSilhouette(ctx, toPx, scalePx, polys, sils, fillA, 0.05);
    else if (wordCanvas) {
      const ww = WORD_H * wordInfo.aspect;
      const [x0, y0] = toPx(-ww / 2, WORD_DY + WORD_H / 2);
      ctx.globalAlpha = fillA;
      ctx.drawImage(wordCanvas, x0, y0, ww * scalePx, WORD_H * scalePx);
      ctx.globalAlpha = 1;
    }
    return ctx.getImageData(0, 0, w, h).data;
  };
  const softE = layer(Math.max(2, size / 64), 0.7, false);
  const sharpE = layer(Math.max(1, size / 256), 0.9, false);
  const softW = layer(Math.max(2, size / 64), 0.8, true);
  const sharpW = layer(Math.max(1, size / 256), 0.9, true);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w; // flip: texture row 0 = bottom (y0)
    for (let x = 0; x < w; x++) {
      const i = (src + x) * 4;
      const o = (y * w + x) * 4;
      data[o] = softE[i];
      data[o + 1] = sharpE[i];
      data[o + 2] = softW[i];
      data[o + 3] = sharpW[i];
    }
  }
  return { w, h, data };
}

// sRGB hex -> linear rgb
export function lin(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const PAL = {
  violet: lin(0x8b5cf6),
  lilac: lin(0xa78bfa),
  pale: lin(0xddd6fe),
  magenta: lin(0xd946ef),
  pink: lin(0xe879f9),
  cyan: lin(0x67e8f9),
  indigo: lin(0x6d28d9),
  white: [1.0, 0.95, 1.0],
};

function gauss(rng) {
  // Box–Muller (deterministic)
  const u = Math.max(1e-6, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function colourFor(g, x, y, rng) {
  const ax = Math.abs(x);
  let c;
  if (g === 'body') c = y > 0.62 ? mix3(PAL.pale, PAL.white, 0.5) : mix3(PAL.pale, PAL.white, 0.35 * sstep(-0.3, 0.6, y));
  else if (g === 'crest') c = mix3(PAL.pale, PAL.pink, 0.25);
  else if (g === 'wing') {
    const wt = sstep(0.12, 0.95, ax);
    c = mix3(PAL.pale, PAL.lilac, sstep(0.0, 0.4, wt));
    c = mix3(c, PAL.violet, sstep(0.35, 0.8, wt) * 0.7);
    c = mix3(c, PAL.pink, sstep(0.75, 1.0, wt) * (0.35 + 0.5 * vnoise(x * 7, y * 7)));
  } else if (g === 'tail') c = mix3(PAL.lilac, PAL.magenta, sstep(-0.3, -1.0, y) * 0.8);
  else c = mix3(PAL.violet, PAL.indigo, 0.35); // ring
  if (rng() < 0.015) c = mul3(PAL.cyan, 1.2);
  return c;
}

/**
 * Emblem particles. Returns typed arrays: pos (x,y local), info (order, burn, edge, size), col.
 * ~72 % sit on the strokes (order = pen order), ~28 % fill the wing / tail / torso membranes
 * (order = pen order of the nearest stroke, from the bake).
 */
export function sampleEmblem(n, rng, bake, opts = {}) {
  const polys = opts.polys || emblemPolylines();
  const sils = emblemSilhouettes();
  const sizeMul = opts.sizeMul || 1;
  const pos = new Float32Array(n * 2);
  const info = new Float32Array(n * 4);
  const col = new Float32Array(n * 3);
  // stroke length weights (ring counts less – it is a thin frame)
  const weights = polys.map((p) => p.len * (p.g === 'ring' ? 0.55 : 0.6 + 0.4 * p.w));
  const total = weights.reduce((a, b) => a + b, 0);
  const nStroke = Math.round(n * 0.72);
  const bakeRev = (x, y) => {
    const N = bake.N;
    const ix = Math.min(N - 1, Math.max(0, Math.floor(((x + EMB_EXT) / (2 * EMB_EXT)) * N)));
    const iy = Math.min(N - 1, Math.max(0, Math.floor(((y + EMB_EXT) / (2 * EMB_EXT)) * N)));
    const r = bake.rev[iy * N + ix];
    return r > 1.5 ? 0.6 : r;
  };
  let k = 0;
  const put = (x, y, order, edge, size, c, k2) => {
    pos[k * 2] = x;
    pos[k * 2 + 1] = y;
    const dist = Math.hypot(x, (y - 0.1) * 1.1);
    const burn = clamp01(0.45 * vnoise(x * 3.0 + 7, y * 3.0 + 3) + 0.55 * (1 - dist / 1.15) + (rng() - 0.5) * 0.1);
    info[k * 4] = clamp01(order);
    info[k * 4 + 1] = burn;
    info[k * 4 + 2] = edge;
    info[k * 4 + 3] = size * sizeMul;
    col[k * 3] = c[0] * k2;
    col[k * 3 + 1] = c[1] * k2;
    col[k * 3 + 2] = c[2] * k2;
    k++;
  };
  for (let i = 0; i < nStroke; i++) {
    let r = rng() * total;
    let pi = 0;
    for (; pi < polys.length - 1; pi++) {
      if (r < weights[pi]) break;
      r -= weights[pi];
    }
    const pl = polys[pi];
    const seg = Math.floor(rng() * (pl.pts.length - 1));
    const u = rng();
    const a = pl.pts[seg];
    const b = pl.pts[seg + 1];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    const spread = gauss(rng) * (0.006 + 0.007 * pl.w);
    const x = a[0] + tx * u - (ty / tl) * spread;
    const y = a[1] + ty * u + (tx / tl) * spread;
    const order = pl.rev[seg] + (pl.rev[seg + 1] - pl.rev[seg]) * u;
    const c = colourFor(pl.g, x, y, rng);
    const size = 1.15 + rng() * 0.55;
    put(x, y, order, 1, size, c, pl.g === 'ring' ? 0.75 : 1.2);
  }
  // membrane fill (rejection sampling inside the silhouettes)
  const boxes = sils.map((s) => {
    let x0 = 9;
    let y0 = 9;
    let x1 = -9;
    let y1 = -9;
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) };
  });
  const areaTot = boxes.reduce((a, b) => a + b.area, 0);
  let guard = 0;
  while (k < n && guard++ < n * 40) {
    let r = rng() * areaTot;
    let si = 0;
    for (; si < boxes.length - 1; si++) {
      if (r < boxes[si].area) break;
      r -= boxes[si].area;
    }
    const bx = boxes[si];
    const x = bx.x0 + rng() * (bx.x1 - bx.x0);
    const y = bx.y0 + rng() * (bx.y1 - bx.y0);
    if (!pointInPoly(x, y, sils[si].pts)) continue;
    const c = colourFor(sils[si].g, x, y, rng);
    put(x, y, bakeRev(x, y) + 0.02, 0, 1.6 + rng() * 0.9, c, 0.32);
  }
  while (k < n) put(0, 0, 0.5, 0, 0.0001, [0, 0, 0], 0); // degenerate fallback (never visible)
  return { pos, info, col, n };
}

/** Wordmark particles from the wordmark alpha canvas; order = x (ignites left to right). */
export function sampleWord(canvas, n, rng, opts = {}) {
  const sizeMul = opts.sizeMul || 1;
  const w = canvas.width;
  const h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3]);
  const fill = [];
  const edge = [];
  const step = Math.max(1, Math.floor(w / 1024));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (A(x, y) < 128) continue;
      fill.push(x, y);
      const e = 2 * step;
      if (A(x + e, y) < 128 || A(x - e, y) < 128 || A(x, y + e) < 128 || A(x, y - e) < 128) edge.push(x, y);
    }
  }
  const pos = new Float32Array(n * 2);
  const info = new Float32Array(n * 4);
  const col = new Float32Array(n * 3);
  const aspect = w / h;
  const nEdge = Math.round(n * 0.4);
  for (let i = 0; i < n; i++) {
    const useEdge = i < nEdge && edge.length > 0;
    const src = useEdge ? edge : fill;
    if (!src.length) break;
    const kk = Math.floor(rng() * (src.length / 2)) * 2;
    const u = (src[kk] + rng() * step) / w;
    const v = (src[kk + 1] + rng() * step) / h;
    // word-local units: box height 1, width = aspect, centred
    pos[i * 2] = (u - 0.5) * aspect;
    pos[i * 2 + 1] = 0.5 - v;
    info[i * 4] = clamp01(u * 0.85 + rng() * 0.15);
    info[i * 4 + 1] = clamp01(0.65 * vnoise(u * 14.0, v * 3.0) + 0.35 * rng());
    info[i * 4 + 2] = useEdge ? 1 : 0;
    info[i * 4 + 3] = (useEdge ? 1.15 + rng() * 0.35 : 1.3 + rng() * 0.6) * sizeMul;
    let c = mix3(PAL.pale, PAL.lilac, 0.25 + 0.5 * sstep(0.2, 0.8, u));
    if (useEdge) c = mix3(c, PAL.white, 0.5);
    const k2 = useEdge ? 0.85 : 0.42;
    col[i * 3] = c[0] * k2;
    col[i * 3 + 1] = c[1] * k2;
    col[i * 3 + 2] = c[2] * k2;
  }
  return { pos, info, col, n };
}
