// SVG export of the canonical PHOENIX emblem (same strokes as the FX neon line and particles).
// Used for the titlebar logo, the app icon and the static FX tier.
//
//   emblemSvg({ size: 64 })                       -> '<svg ...>…</svg>' (neon line art on transparent bg)
//   emblemSvg({ size: 22, detail: 'simple' })     -> bolder, fewer lines for tiny sizes
//   emblemPaths({ detail })                       -> { strokes: [{ d, w, g }], fills: [{ d, g }], viewBox }
//
// Coordinates: emblem units x100, y flipped (SVG y points down). viewBox "-120 -120 240 240".
import { S, TAIL, ringStroke, emblemSilhouettes } from './strokes.js';

const K = 100;
const f = (v) => {
  const r = Math.round(v * K * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const P = (x, y) => `${f(x)} ${f(-y)}`;

function chainD(c, mirror) {
  const sx = mirror ? -1 : 1;
  let d = `M${P(c[0] * sx, c[1])}`;
  for (let o = 2; o + 5 < c.length; o += 6) {
    d += `C${P(c[o] * sx, c[o + 1])} ${P(c[o + 2] * sx, c[o + 3])} ${P(c[o + 4] * sx, c[o + 5])}`;
  }
  return d;
}

function polyD(pts) {
  let d = `M${P(pts[0][0], pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${P(pts[i][0], pts[i][1])}`;
  return `${d}Z`;
}

/** Path data of the emblem. detail 'simple' drops the thin inner shafts for small sizes. */
export function emblemPaths({ detail = 'full' } = {}) {
  const simple = detail === 'simple';
  const strokes = [];
  for (const s of S) {
    if (simple && s.w < 0.62) continue;
    if (s.id === 'tailCentre') continue; // the tail outline is one path in the SVG (two pen strokes in the FX)
    const c = s.id === 'tailSide' ? TAIL : s.c;
    strokes.push({ d: chainD(c, false), w: s.w, g: s.g });
    if (s.m) strokes.push({ d: chainD(c, true), w: s.w, g: s.g });
  }
  const r = ringStroke();
  const R = Math.hypot(r.pts[0][0], r.pts[0][1]);
  const a1 = r.pts[r.pts.length - 1];
  // ring: one arc through the bottom, gap at the top
  const ring = `M${P(-a1[0], a1[1])}A${f(R)} ${f(R)} 0 1 0 ${P(a1[0], a1[1])}`;
  strokes.push({ d: ring, w: r.w, g: 'ring' });
  const fills = emblemSilhouettes().map((s) => ({ d: polyD(s.pts), g: s.g }));
  return { strokes, fills, viewBox: '-120 -120 240 240' };
}

let uid = 0;

/**
 * Returns an SVG string of the neon emblem.
 * opts: size (px), detail ('full'|'simple', auto below 40 px), color, glow (bool), fill (membrane
 * opacity 0..1), minStrokePx (minimum visible line width), title (accessible name; omitted = aria-hidden).
 */
export function emblemSvg({
  size = 64,
  detail,
  color = '#EDE9FE',
  glowColor = '#8B5CF6',
  glow = size >= 40,
  fill = 0.16,
  minStrokePx = size <= 24 ? 1.15 : 0.9,
  title = '',
  className = '',
} = {}) {
  const det = detail || (size < 40 ? 'simple' : 'full');
  const { strokes, fills, viewBox } = emblemPaths({ detail: det });
  const unitsPerPx = 240 / size;
  const id = `phx-emb-${++uid}`;
  const sw = (w) => f(Math.max(0.019 * w * (det === 'simple' ? 1.6 : 1), (minStrokePx * unitsPerPx * (0.55 + 0.45 * w)) / K));
  const lines = strokes.map((s) => `<path d="${s.d}" stroke-width="${sw(s.w)}"/>`).join('');
  const membranes = fill > 0 ? `<g fill="url(#${id}-m)" opacity="${fill}">${fills.map((s) => `<path d="${s.d}"/>`).join('')}</g>` : '';
  const glowLayer = glow
    ? `<g filter="url(#${id}-g)" stroke="${glowColor}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.9">${lines}</g>`
    : '';
  const a11y = title ? `role="img" aria-label="${title.replace(/"/g, '&quot;')}"` : 'aria-hidden="true" focusable="false"';
  return `<svg xmlns="http://www.w3.org/2000/svg" ${className ? `class="${className}" ` : ''}width="${size}" height="${size}" viewBox="${viewBox}" ${a11y}>
<defs>
<linearGradient id="${id}-m" x1="0" y1="-110" x2="0" y2="110" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#C4B5FD"/><stop offset="0.6" stop-color="#8B5CF6"/><stop offset="1" stop-color="#D946EF"/></linearGradient>
${glow ? `<filter id="${id}-g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${f(Math.max(0.02, 2.2 * unitsPerPx / K))}"/></filter>` : ''}
</defs>
${membranes}${glowLayer}<g stroke="${color}" fill="none" stroke-linecap="round" stroke-linejoin="round">${lines}</g>
</svg>`;
}
