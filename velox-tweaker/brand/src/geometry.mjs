// VELOX "Versatz" letterforms. One grid, one cut, one offset.
// Units: cap height 100, y grows downwards (0 = cap line, 100 = baseline).
// Every glyph is drawn upright on the grid, split by one horizontal cut, then
// sheared forward. The pieces above the cut are set ahead by OFFSET.
//
// Two masters share the outlines:
//   LARGE - cut band 44..52, offset 7     (wordmark at >= 24 px cap height, intro)
//   SMALL - cut band 43.75..56.25 (= rows 7..9 of a 16 px cap), offset 6.25 (= 1 px),
//           horizontals snapped to the 16 px grid (sidebar, title bars, < 24 px cap)

export const SHEAR_DEG = 9;
export const SHEAR = Math.tan(SHEAR_DEG * Math.PI / 180);

export const LARGE = { cutTop: 44, cutBot: 52, offset: 7, snap: 0 };
export const SMALL = { cutTop: 43.75, cutBot: 56.25, offset: 6.25, snap: 6.25 };

const r2 = (n) => Math.round(n * 100) / 100;

function superellipse(cx, cy, rx, ry, n, steps) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push([cx + rx * Math.sign(c) * Math.pow(Math.abs(c), 2 / n),
              cy + ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / n)]);
  }
  return pts;
}

// upright outlines on the 100-unit grid
function glyphs(snap) {
  const s = (y) => (snap ? Math.round(y / snap) * snap : y);
  return {
    V: { w: 84, polys: [[[0, 0], [25, 0], [42, 64], [59, 0], [84, 0], [55, 100], [29, 100]]] },
    E: { w: 60, polys: [[[0, 0], [60, 0], [60, s(19)], [24, s(19)], [24, s(37)], [53, s(37)], [53, s(61)], [24, s(61)], [24, s(81)], [60, s(81)], [60, 100], [0, 100]]] },
    L: { w: 56, polys: [[[0, 0], [24, 0], [24, s(81)], [56, s(81)], [56, 100], [0, 100]]] },
    O: { w: 88, ring: { outer: superellipse(44, 50, 44, 50, 4.2, 720), inner: superellipse(44, 50, 20, 31, 3.2, 720) } },
    X: { w: 84, polys: [[[0, 0], [26, 0], [42, 27.59], [58, 0], [84, 0], [55, 50], [84, 100], [58, 100], [42, 72.41], [26, 100], [0, 100], [29, 50]]] },
  };
}
export const GLYPHS = glyphs(0);

// Split a simple polygon by y = c, keep 'above' (y <= c) or 'below' (y >= c).
export function split(poly, c, keep) {
  const inside = (p) => (keep === 'above' ? p[1] <= c + 1e-9 : p[1] >= c - 1e-9);
  const n = poly.length;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    ring.push({ p: a, in: inside(a), x: false });
    const da = a[1] - c, db = b[1] - c;
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      ring.push({ p: [a[0] + (b[0] - a[0]) * t, c], in: true, x: true });
    }
  }
  if (!ring.some((v) => v.in)) return [];
  if (!ring.some((v) => !v.in)) return [poly];
  const idxOf = (v) => ring.indexOf(v);
  const sorted = ring.filter((v) => v.x).sort((u, v) => u.p[0] - v.p[0]);
  const partner = new Map();
  for (let i = 0; i + 1 < sorted.length; i += 2) { partner.set(sorted[i], sorted[i + 1]); partner.set(sorted[i + 1], sorted[i]); }
  const isExit = (v) => !ring[(idxOf(v) + 1) % ring.length].in;
  const used = new Set();
  const pieces = [];
  for (const start of ring) {
    if (!start.in || used.has(start)) continue;
    if (start.x && isExit(start)) continue;
    const piece = [];
    let v = start, guard = 0;
    while (guard++ < 10000) {
      if (used.has(v)) break;
      used.add(v); piece.push(v.p);
      if (v.x && isExit(v)) { v = partner.get(v); continue; }
      v = ring[(idxOf(v) + 1) % ring.length];
    }
    if (piece.length >= 3) pieces.push(piece);
  }
  return pieces;
}

function arc(poly, c, keep) {
  const p = split(poly, c, keep)[0];
  let k = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    if (Math.abs(a[1] - c) < 1e-9 && Math.abs(b[1] - c) < 1e-9) { k = (i + 1) % p.length; break; }
  }
  return p.slice(k).concat(p.slice(0, k));
}

function ringPieces(ring, c, keep) {
  const o = arc(ring.outer, c, keep);
  const i = arc(ring.inner, c, keep);
  const oEnd = o[o.length - 1];
  const inner = Math.abs(i[0][0] - oEnd[0]) < Math.abs(i[i.length - 1][0] - oEnd[0]) ? i : i.slice().reverse();
  return [o.concat(inner)];
}

// letter positions: left edge of each upright glyph box; tight, optically set
export const WORD = [
  { ch: 'V', x: 0 },
  { ch: 'E', x: 90 },
  { ch: 'L', x: 162 },
  { ch: 'O', x: 220 },
  { ch: 'X', x: 318 },
];

export const sheared = ([x, y], dx = 0) => [x + (100 - y) * SHEAR + dx, y];

export function glyphPieces(ch, master = LARGE) {
  const g = glyphs(master.snap)[ch];
  if (g.ring) return { top: ringPieces(g.ring, master.cutTop, 'above'), bot: ringPieces(g.ring, master.cutBot, 'below') };
  const top = [], bot = [];
  for (const poly of g.polys) { top.push(...split(poly, master.cutTop, 'above')); bot.push(...split(poly, master.cutBot, 'below')); }
  return { top, bot };
}

export function toPath(pieces, ox = 0, dx = 0, map = (p) => p) {
  return pieces.map((pc) => {
    const pts = pc.map((p) => map(sheared([p[0] + ox, p[1]], dx)));
    const out = [];
    for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) out.push(p); }
    return 'M' + out.map((p) => r2(p[0]) + ' ' + r2(p[1])).join('L') + 'Z';
  }).join('');
}

// horizontal extent of a set of (upright) pieces on the line y, after shear
export function extentAt(pieces, y, ox = 0, dx = 0) {
  let lo = Infinity, hi = -Infinity, mass = 0;
  for (const pc of pieces) {
    const xs = [];
    for (let i = 0; i < pc.length; i++) {
      const a = pc[i], b = pc[(i + 1) % pc.length];
      if ((a[1] - y) * (b[1] - y) < 0 || (a[1] === y && b[1] !== y)) {
        const t = (y - a[1]) / (b[1] - a[1]);
        xs.push(a[0] + (b[0] - a[0]) * t);
      }
    }
    xs.sort((u, v) => u - v);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = sheared([xs[i] + ox, y], dx)[0], x1 = sheared([xs[i + 1] + ox, y], dx)[0];
      lo = Math.min(lo, x0); hi = Math.max(hi, x1); mass += x1 - x0;
    }
  }
  return { lo, hi, mass };
}

export function wordWidth(master = LARGE) {
  const last = WORD[WORD.length - 1];
  return last.x + GLYPHS[last.ch].w + 100 * SHEAR + master.offset;
}
