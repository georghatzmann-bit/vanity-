// Pixel masters of the app icon for 16-32 px - hand-fitted by rule, not rasterised.
// At these sizes the real outline (heavy arms, slope ~0.29) stood both arms up as two
// near-vertical "ears" over a centred orange "nose" and read as a face. The masters are
// therefore drawn constructively: a V of two 3 px arms that converge one column every two
// rows (16 px: every 2-3) down to a point, cut on whole rows; the upper (bone) half sits 2 px ahead, the lower
// (signal) foot continues the same diagonals 2 px behind it. Every pixel is on or off.
import { split, GLYPHS } from './geometry.mjs';

const SPEC = {        // cap rows, rows above the cut, cut rows, offset, arm width, columns per row, point width, x nudge
  16: { cap: 11, up: 5, gap: 1, off: 2, aw: 3, slope: 0.4, bw: 3, nudge: 0 },
  20: { cap: 13, up: 6, gap: 1, off: 2, aw: 3, slope: 0.5, bw: 3, nudge: 0 },
  24: { cap: 16, up: 7, gap: 2, off: 2, aw: 3, slope: 0.5, bw: 3, nudge: 0 },
  32: { cap: 20, up: 9, gap: 2, off: 2, aw: 4, slope: 0.45, bw: 4, nudge: 0 },
};

export function fitMark(N, C) {
  const sp = SPEC[N];
  const grid = Array.from({ length: N }, () => new Array(N).fill(0));
  const span = (r) => Math.floor(r * sp.slope);
  const Wtop = 2 * span(sp.cap - 1) + sp.bw;               // the uncut V's width at the cap line
  const x0 = Math.floor((N - Wtop - sp.off) / 2) + sp.nudge, y0 = Math.floor((N - sp.cap) / 2);
  for (let r = 0; r < sp.cap; r++) {
    const isUp = r < sp.up, isLo = r >= sp.up + sp.gap;
    if (!isUp && !isLo) continue;
    const xl = x0 + span(r), xr = x0 + Wtop - 1 - span(r), a1 = xl + sp.aw - 1, b0 = xr - sp.aw + 1;
    for (let x = xl; x <= xr; x++) {
      if (x <= a1 || x >= b0 || b0 - a1 <= 1) grid[y0 + r][x + (isUp ? sp.off : 0)] = isUp ? 1 : 2;
    }
  }
  const runs = [];
  for (let py = 0; py < N; py++) {
    let px = 0;
    while (px < N) {
      const v = grid[py][px];
      if (!v) { px++; continue; }
      let e = px; while (e < N && grid[py][e] === v) e++;
      runs.push(`<rect x="${px}" y="${py}" width="${e - px}" height="1" fill="${v === 1 ? C.bone : C.signal}"/>`);
      px = e;
    }
  }
  const rad = Math.max(2.5, N * 0.2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">\n` +
    `  <title>VELOX</title>\n` +
    `  <rect x="0.5" y="0.5" width="${N - 1}" height="${N - 1}" rx="${rad - 0.5}" fill="${C.tile}" stroke="${C.key}" stroke-width="1"/>\n` +
    `  <g shape-rendering="crispEdges">\n    ${runs.join('\n    ')}\n  </g>\n</svg>\n`;
  return { svg, grid };
}

// 32-48 px: the real outline (brand shear), but every horizontal edge - cap line, both
// edges of the cut, baseline - is moved onto a whole pixel row, and the forward offset is
// a whole number of pixels. Only the diagonals are anti-aliased; the cut stays a clean gap.
const VSPEC = {
  32: { cap: 20, up: 9, gap: 2, off: 2 },
  40: { cap: 24, up: 11, gap: 2, off: 2 },
  48: { cap: 29, up: 13, gap: 2, off: 2 },
};
export function fitVectorMark(N, C, SHEAR_FULL) {
  const sp = VSPEC[N];
  const V = GLYPHS.V.polys[0];
  const CT = 44, CB = 52;
  const tops = split(V, CT, 'above');
  // the V's inner apex dips 12 units into the lower half; at these sizes it is a 1 px speck - close it
  const bots = split(V, CB, 'below').map((pc) => pc.filter(([x, y]) => !(x === 42 && y === 64)));
  const s = sp.cap / 100;
  const y0 = Math.round((N - sp.cap) / 2);
  const yUp = (y) => y0 + y / CT * sp.up;
  const yLo = (y) => y0 + sp.up + sp.gap + (y - CB) / (100 - CB) * (sp.cap - sp.up - sp.gap);
  const vw = (84 + 100 * SHEAR_FULL) * s + sp.off;
  const x0 = (N - vw) / 2 - 0.4;
  const r = (n) => Math.round(n * 1000) / 1000;
  const path = (pcs, up) => pcs.map((pc) => 'M' + pc.map(([x, y]) => {
    const X = x0 + (x + (100 - y) * SHEAR_FULL) * s + (up ? sp.off : 0);
    return r(X) + ' ' + r(up ? yUp(y) : yLo(y));
  }).join('L') + 'Z').join('');
  const rad = N * 0.2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">\n` +
    `  <title>VELOX</title>\n` +
    `  <rect x="0.5" y="0.5" width="${N - 1}" height="${N - 1}" rx="${r(rad - 0.5)}" fill="${C.tile}" stroke="${C.key}" stroke-width="1"/>\n` +
    `  <path fill="${C.bone}" d="${path(tops, true)}"/><path fill="${C.signal}" d="${path(bots, false)}"/>\n</svg>\n`;
}
