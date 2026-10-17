// Wordmark "PHOENIX": canvas 2D text in the bundled OFL font (Inter ExtraBold 800, see
// ../assets/Inter-OFL-LICENSE.txt) -> exact Euclidean distance transform (Felzenszwalb) -> SDF.
// WARP buildWordmark, adapted: bundled font (identical on every PC) and the alpha source canvas is
// returned too, for the wordmark particles.

const FONT_URL = new URL('../assets/inter-latin-800-normal.woff2', import.meta.url).href;
export const WORDMARK_FAMILY = 'PhoenixInter';
const INF = 1e20;
let fontPromise = null;

/** Loads the bundled font once (resolves false when unavailable – a system font is used then). */
export function loadWordmarkFont() {
  if (fontPromise) return fontPromise;
  fontPromise = (async () => {
    try {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
      const face = new FontFace(WORDMARK_FAMILY, `url("${FONT_URL}")`, { weight: '800', style: 'normal' });
      await face.load();
      document.fonts.add(face);
      return true;
    } catch (err) {
      console.warn('[fx] wordmark font unavailable, using a system font', err);
      return false;
    }
  })();
  return fontPromise;
}

function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 0; q < length; q++) f[q] = grid[offset + q * stride];
  let k = 0;
  for (let q = 1; q < length; q++) {
    let s;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, kk = 0; q < length; q++) {
    while (z[kk + 1] < q) kk++;
    const r = v[kk];
    grid[offset + q * stride] = f[r] + (q - r) * (q - r);
  }
}

function edt(data, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const v = new Uint16Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) edt1d(data, x, w, h, f, v, z);
  for (let y = 0; y < h; y++) edt1d(data, y * w, 1, w, f, v, z);
}

/**
 * Returns { W, H, SPREAD, data (Uint8 SDF, 0.5 = edge, rows top-down), aspect, inset, capFrac, canvas }.
 * canvas holds the white text on transparent (alpha = coverage) for particle sampling.
 */
export function buildWordmark(text = 'PHOENIX', { W = 1536, H = 288, SPREAD = 48 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const family = `${WORDMARK_FAMILY}, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif`;
  let fs = 200;
  const spacingEm = 0.26;
  const measure = () => {
    ctx.font = `800 ${fs}px ${family}`;
    const ws = [...text].map((ch) => ctx.measureText(ch).width);
    return { ws, total: ws.reduce((a, b) => a + b, 0) + spacingEm * fs * (text.length - 1) };
  };
  let m = measure();
  fs = Math.floor((fs * (W * 0.86)) / m.total);
  m = measure();
  const capM = ctx.measureText('H');
  const cap = capM.actualBoundingBoxAscent || fs * 0.7;
  const baseY = H / 2 + cap / 2;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  let x = (W - m.total) / 2;
  const left = x;
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, x, baseY);
    x += m.ws[i] + spacingEm * fs;
  });

  const img = ctx.getImageData(0, 0, W, H).data;
  const outer = new Float64Array(W * H);
  const inner = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = img[i * 4 + 3] / 255;
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, W, H);
  edt(inner, W, H);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]); // + outside (px)
    out[i] = Math.max(0, Math.min(255, Math.round((0.5 - d / (2 * SPREAD)) * 255)));
  }
  return { W, H, SPREAD, data: out, aspect: W / H, inset: left / W, capFrac: cap / H, fontPx: fs, canvas: cv };
}
