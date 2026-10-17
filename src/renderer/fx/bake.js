// CPU-side assets, built once per session and cached at module level (context restores and tier
// switches reuse them): emblem distance bake, wordmark SDF, heat raster, particle / spark buffers.
import { EMB_EXT, EMB_R, emblemPolylines } from './emblem/strokes.js';
import { bakeEmblem, rasterHeat, sampleEmblem, sampleWord, mulberry32, lin } from './emblem/raster.js';
import { buildWordmark, loadWordmarkFont } from './emblem/wordmark.js';

const cache = { polys: null, bakes: new Map(), word: null, heats: new Map(), parts: new Map(), sparks: new Map() };

export { EMB_EXT, EMB_R };

export async function prepareFont() {
  return loadWordmarkFont();
}

export function polys() {
  if (!cache.polys) cache.polys = emblemPolylines();
  return cache.polys;
}

/** Raw distance bake (Float32 dist / rev / wid), cached per resolution. */
export function emblemBakeRaw(N) {
  let raw = cache.bakes.get(N);
  if (!raw) {
    raw = bakeEmblem(polys(), N, EMB_R);
    cache.bakes.set(N, raw);
  }
  return raw;
}

/**
 * Texture data for the bake: half-float RGBA (r dist, g pen order, b width) when float textures
 * are usable, otherwise an 8-bit fallback (dist / EMB_R, rev / 2, width / 1.2).
 */
export function emblemBakeTexData(N, toHalf, halfFloat) {
  const raw = emblemBakeRaw(N);
  const key = halfFloat ? 'half' : 'f8';
  if (raw[key]) return raw[key];
  if (halfFloat) {
    const half = new Uint16Array(N * N * 4);
    const one = toHalf(1);
    for (let i = 0; i < N * N; i++) {
      half[i * 4] = toHalf(raw.dist[i]);
      half[i * 4 + 1] = toHalf(raw.rev[i]);
      half[i * 4 + 2] = toHalf(raw.wid[i]);
      half[i * 4 + 3] = one;
    }
    raw.half = half;
  } else {
    const f8 = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      f8[i * 4] = Math.round(Math.min(1, raw.dist[i] / EMB_R) * 255);
      f8[i * 4 + 1] = Math.round(Math.min(1, raw.rev[i] / 2) * 255);
      f8[i * 4 + 2] = Math.round(Math.min(1, raw.wid[i] / 1.2) * 255);
      f8[i * 4 + 3] = 255;
    }
    raw.f8 = f8;
  }
  return raw[key];
}

export function wordmark() {
  if (!cache.word) cache.word = buildWordmark('PHOENIX');
  return cache.word;
}

export function heat(size) {
  let h = cache.heats.get(size);
  if (!h) {
    const w = wordmark();
    h = rasterHeat(polys(), w.canvas, w, size);
    cache.heats.set(size, h);
  }
  return h;
}

const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const VIOLET = lin(0x8b5cf6);
const PINK = lin(0xe879f9);
const LILAC = lin(0xa78bfa);
const CYAN = lin(0x67e8f9);

/**
 * Particle attribute arrays for a tier: emblem + word + embers + 4x40 pulse puffs.
 * Returns { position, seed, info, color, count, emberStart }.
 */
export function particles(tier) {
  const key = `${tier.emblem}/${tier.word}/${tier.embers}/${tier.sizeMul}`;
  let p = cache.parts.get(key);
  if (p) return p;
  const rng = mulberry32(0x9e3779b9);
  const bake = emblemBakeRaw(tier.bake);
  const E = sampleEmblem(tier.emblem, rng, bake, { polys: polys(), sizeMul: tier.sizeMul });
  const Wd = sampleWord(wordmark().canvas, tier.word, rng, { sizeMul: tier.sizeMul });
  const PUFF = 160;
  const N = E.n + Wd.n + tier.embers + PUFF;
  const position = new Float32Array(N * 3);
  const seed = new Float32Array(N * 4);
  const info = new Float32Array(N * 4);
  const color = new Float32Array(N * 3);
  let i = 0;
  const put = (x, y, g, inf0, inf1, inf2, inf3, c0, c1, c2) => {
    position[i * 3] = x;
    position[i * 3 + 1] = y;
    position[i * 3 + 2] = g;
    seed[i * 4] = rng();
    seed[i * 4 + 1] = rng();
    seed[i * 4 + 2] = rng();
    seed[i * 4 + 3] = rng();
    info[i * 4] = inf0;
    info[i * 4 + 1] = inf1;
    info[i * 4 + 2] = inf2;
    info[i * 4 + 3] = inf3;
    color[i * 3] = c0;
    color[i * 3 + 1] = c1;
    color[i * 3 + 2] = c2;
    i++;
  };
  for (let k = 0; k < E.n; k++) {
    put(E.pos[k * 2], E.pos[k * 2 + 1], 0, E.info[k * 4], E.info[k * 4 + 1], E.info[k * 4 + 2], E.info[k * 4 + 3], E.col[k * 3], E.col[k * 3 + 1], E.col[k * 3 + 2]);
  }
  for (let k = 0; k < Wd.n; k++) {
    put(Wd.pos[k * 2], Wd.pos[k * 2 + 1], 1, Wd.info[k * 4], Wd.info[k * 4 + 1], Wd.info[k * 4 + 2], Wd.info[k * 4 + 3], Wd.col[k * 3], Wd.col[k * 3 + 1], Wd.col[k * 3 + 2]);
  }
  const emberStart = i;
  for (let k = 0; k < tier.embers; k++) {
    let c = mix3(VIOLET, PINK, rng());
    let br = 0.9 + rng() * 1.6;
    if (rng() < 0.02) {
      c = CYAN;
      br = 1.4;
    }
    const size = (rng() < 0.1 ? 3.8 + rng() * 3.0 : 1.8 + rng() * 1.8) * tier.sizeMul;
    put(0, 0, 2, 0, 0, 0, size, c[0] * br, c[1] * br, c[2] * br);
  }
  for (let k = 0; k < PUFF; k++) {
    const c = mix3(LILAC, PINK, rng());
    const br = 1.2 + rng() * 1.2;
    put(Math.floor(k / 40), 0, 3, 0, 0, 0, (1.6 + rng() * 1.6) * tier.sizeMul, c[0] * br, c[1] * br, c[2] * br);
  }
  p = { position, seed, info, color, count: N, emberStart };
  cache.parts.set(key, p);
  return p;
}

/** Spark streak instances: ignition (kind 0), climax / burst (kind 1), pen sparks (kind 2). */
export function sparks(tier) {
  const key = `${tier.sparks}/${tier.pen}`;
  let s = cache.sparks.get(key);
  if (s) return s;
  const rng = mulberry32(0x51f15e);
  const P = polys();
  const lenSum = P.reduce((a, p) => a + p.len, 0);
  const pick = () => {
    let r = rng() * lenSum;
    let pl = P[0];
    for (const p of P) {
      if (r < p.len) {
        pl = p;
        break;
      }
      r -= p.len;
    }
    const j = Math.floor(rng() * (pl.pts.length - 1));
    const u = rng();
    const a = pl.pts[j];
    const b = pl.pts[j + 1];
    return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, rev: pl.rev[j] + (pl.rev[j + 1] - pl.rev[j]) * u, g: pl.g };
  };
  const NS = tier.sparks;
  const NP = tier.pen;
  const N = NS + NP;
  const iSeed = new Float32Array(N * 4);
  const iInfo = new Float32Array(N * 4);
  const iOrigin = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    let ox = 0;
    let oy = 0;
    let ang;
    let v0;
    let t0;
    let w;
    let kind;
    if (k < NS * 0.12) {
      kind = 0;
      ang = rng() * Math.PI * 2;
      v0 = 0.6 + rng() * 1.6;
      t0 = rng() * 0.12;
      w = 0.7 + rng() * 0.6;
    } else if (k < NS) {
      kind = 1;
      let p = pick();
      if (p.g === 'ring' && rng() < 0.6) p = pick();
      ox = p.x;
      oy = p.y;
      ang = Math.atan2(oy + 0.05, ox) + (rng() - 0.5) * 0.9;
      v0 = 1.2 + Math.pow(rng(), 0.6) * 3.4;
      t0 = rng() * rng() * 0.22;
      w = 0.8 + rng() * 1.1;
    } else {
      kind = 2;
      const p = pick();
      ox = p.x;
      oy = p.y;
      ang = rng() * Math.PI * 2;
      v0 = 0.08 + Math.pow(rng(), 1.5) * 0.5;
      t0 = Math.min(0.999, p.rev) + rng() * 0.01;
      w = 0.5 + rng() * 0.5;
    }
    iSeed[k * 4] = rng();
    iSeed[k * 4 + 1] = rng();
    iSeed[k * 4 + 2] = rng();
    iSeed[k * 4 + 3] = rng();
    iInfo[k * 4] = t0;
    iInfo[k * 4 + 1] = ang;
    iInfo[k * 4 + 2] = v0;
    iInfo[k * 4 + 3] = w * tier.sparkW;
    iOrigin[k * 3] = ox;
    iOrigin[k * 3 + 1] = oy;
    iOrigin[k * 3 + 2] = kind;
  }
  s = { iSeed, iInfo, iOrigin, count: N };
  cache.sparks.set(key, s);
  return s;
}
