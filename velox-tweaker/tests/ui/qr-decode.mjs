// Independent QR decoder for the tests (tests/ui/run-ui-tests.mjs, tests/ui/qr-selftest.mjs).
// Written separately from ui/js/qr.js: it reads a module matrix (from a screenshot via readPng +
// sampleModules, or from another encoder), checks the format BCH code, unmasks, de-interleaves the
// blocks, verifies every Reed-Solomon block (all syndromes zero) and parses byte-mode data.
// No error correction: a test code is rendered perfectly, so any error is a bug.
import zlib from 'node:zlib';

// ---------------------------------------------------------------- PNG (8-bit, non-interlaced)
export function readPng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let off = 8; let w = 0; let h = 0; let ct = 0; let depth = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; if (data[12] !== 0) throw new Error('interlaced PNG'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error('PNG bit depth ' + depth);
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!bpp) throw new Error('PNG colour type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  const lum = (x, y) => {
    const i = y * stride + x * bpp;
    if (bpp <= 2) return out[i];
    return 0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2];
  };
  return { width: w, height: h, lum };
}

/**
 * Module matrix from an image of the code (dark modules on a light quiet zone). Finds the top-left
 * finder pattern, takes its width as 7 modules, and samples every module centre. `inset` (pixels)
 * skips a frame of the picture, e.g. the page behind a tile's rounded corners.
 */
export function sampleModules(img, inset = 0) {
  const { width, height, lum } = img;
  let min = 255; let max = 0;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) { const v = lum(x, y); if (v < min) min = v; if (v > max) max = v; }
  const thr = (min + max) / 2;
  const dark = (x, y) => lum(Math.min(width - 1, Math.max(0, Math.round(x))), Math.min(height - 1, Math.max(0, Math.round(y)))) < thr;
  // first dark pixel in reading order = the finder's top-left corner
  let x0 = -1; let y0 = -1;
  outer: for (let y = inset; y < height - inset; y++) for (let x = inset; x < width - inset; x++) if (dark(x, y)) { x0 = x; y0 = y; break outer; }
  if (x0 < 0) throw new Error('no dark pixel');
  // the finder's top row is 7 dark modules wide
  const yRow = y0 + 1;
  let x1 = x0; while (x1 < width && dark(x1, yRow)) x1++;
  const mod = (x1 - x0) / 7;
  // the right edge of the top-right finder gives the size
  let xr = width - 1 - inset; while (xr > x0 && !dark(xr, yRow)) xr--;
  const n = Math.round((xr + 1 - x0) / mod);
  if (n < 21 || (n - 17) % 4 !== 0) throw new Error('implausible size ' + n + ' (module ' + mod.toFixed(2) + ' px)');
  // the exact module pitch from the outer edges of the finders (the finder width alone is off by up to 1 px)
  const modX = (xr + 1 - x0) / n;
  let yb = height - 1 - inset; while (yb > y0 && !dark(x0 + 1, yb)) yb--;
  const modY = (yb + 1 - y0) / n;
  const m = [];
  for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(dark(x0 + (c + 0.5) * modX, y0 + (r + 0.5) * modY)); m.push(row); }
  return m;
}

// ---------------------------------------------------------------- decoding
const BLOCKS = { // [ecc per block, blocks] per version 1..40 for L, M, Q, H (ISO/IEC 18004, written out again here on purpose)
  L: [[7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4], [20, 4], [24, 4], [26, 4], [30, 4], [22, 6], [24, 6], [28, 6], [30, 6], [28, 7], [28, 8], [28, 8], [28, 9], [30, 9], [30, 10], [26, 12], [28, 12], [30, 12], [30, 13], [30, 14], [30, 15], [30, 16], [30, 17], [30, 18], [30, 19], [30, 19], [30, 20], [30, 21], [30, 22], [30, 24], [30, 25]],
  M: [[10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5], [30, 5], [22, 8], [22, 9], [24, 9], [24, 10], [28, 10], [28, 11], [26, 13], [26, 14], [26, 16], [26, 17], [28, 17], [28, 18], [28, 20], [28, 21], [28, 23], [28, 25], [28, 26], [28, 28], [28, 29], [28, 31], [28, 33], [28, 35], [28, 37], [28, 38], [28, 40], [28, 43], [28, 45], [28, 47], [28, 49]],
  Q: [[13, 1], [22, 1], [18, 2], [26, 2], [18, 4], [24, 4], [18, 6], [22, 6], [20, 8], [24, 8], [28, 8], [26, 10], [24, 12], [20, 16], [30, 12], [24, 17], [28, 16], [28, 18], [26, 21], [30, 20], [28, 23], [30, 23], [30, 25], [30, 27], [30, 29], [28, 34], [30, 34], [30, 35], [30, 38], [30, 40], [30, 43], [30, 45], [30, 48], [30, 51], [30, 53], [30, 56], [30, 59], [30, 62], [30, 65], [30, 68]],
  H: [[17, 1], [28, 1], [22, 2], [16, 4], [22, 4], [28, 4], [26, 5], [26, 6], [24, 8], [28, 8], [24, 11], [28, 11], [22, 16], [24, 16], [24, 18], [30, 16], [28, 19], [28, 21], [26, 25], [28, 25], [30, 25], [24, 34], [30, 30], [30, 32], [30, 35], [30, 37], [30, 40], [30, 42], [30, 45], [30, 48], [30, 51], [30, 54], [30, 57], [30, 60], [30, 63], [30, 66], [30, 70], [30, 74], [30, 77], [30, 81]]
};
const LEVEL_BY_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

function formatWord(data5) {
  let g = data5 << 10;
  for (let i = 14; i >= 10; i--) if ((g >> i) & 1) g ^= 0x537 << (i - 10);
  return ((data5 << 10) | g) ^ 0x5412;
}

function functionMap(ver) {
  const n = ver * 4 + 17;
  const f = Array.from({ length: n }, () => new Array(n).fill(false));
  const mark = (r0, c0, h, w) => { for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < n && c < n) f[r][c] = true; };
  mark(0, 0, 9, 9); mark(0, n - 8, 9, 8); mark(n - 8, 0, 8, 9);   // finders + separators + format areas
  mark(6, 0, 1, n); mark(0, 6, n, 1);                            // timing
  if (ver >= 2) {
    const k = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((n - 13) / (2 * k - 2)) * 2;
    const pos = [6]; for (let i = k - 1; i >= 1; i--) pos.splice(1, 0, n - 7 - (k - 1 - i) * step);
    pos.sort((a, b) => a - b);
    for (const r of pos) for (const c of pos) { if ((r < 9 && c < 9) || (r < 9 && c > n - 9) || (r > n - 9 && c < 9)) continue; mark(r - 2, c - 2, 5, 5); }
  }
  if (ver >= 7) { mark(0, n - 11, 6, 3); mark(n - 11, 0, 3, 6); }
  return f;
}

function masked(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

// GF(256) with exp/log tables (a different construction than the encoder's bitwise multiply)
const EXP = new Array(512); const LOG = new Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
function syndromesZero(block, eccLen) {
  for (let i = 0; i < eccLen; i++) {
    let s = 0;
    for (const b of block) s = (s === 0 ? 0 : EXP[LOG[s] + i]) ^ b;
    if (s !== 0) return false;
  }
  return true;
}

/** Decodes a module matrix (boolean[row][col], true = dark). Returns { text, version, ecc, mask }. */
export function decodeMatrix(m) {
  const n = m.length;
  const ver = (n - 17) / 4;
  if (!Number.isInteger(ver) || ver < 1 || ver > 40) throw new Error('bad size ' + n);
  // format: bits 14..0 around the top-left finder (bit 14 first)
  const coords = [];
  for (let c = 0; c <= 5; c++) coords.push([8, c]);
  coords.push([8, 7], [8, 8], [7, 8]);
  for (let r = 5; r >= 0; r--) coords.push([r, 8]);
  let word = 0; for (const [r, c] of coords) word = (word << 1) | (m[r][c] ? 1 : 0);
  let best = null;
  for (let d = 0; d < 32; d++) { const fw = formatWord(d); if (fw === word) best = d; }
  if (best === null) throw new Error('format bits invalid: ' + word.toString(2));
  const ecc = LEVEL_BY_BITS[best >> 3]; const mask = best & 7;
  const fn = functionMap(ver);
  const bits = [];
  let up = true;
  for (let c = n - 1; c > 0; c -= 2) {
    if (c === 6) c = 5;
    for (let i = 0; i < n; i++) {
      const r = up ? n - 1 - i : i;
      for (const cc of [c, c - 1]) { if (fn[r][cc]) continue; bits.push((m[r][cc] ? 1 : 0) ^ (masked(mask, r, cc) ? 1 : 0)); }
    }
    up = !up;
  }
  const total = Math.floor(bits.length / 8);
  const bytes = []; for (let i = 0; i < total; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; bytes.push(v); }
  const [eccLen, nb] = BLOCKS[ecc][ver - 1];
  const dataTotal = total - eccLen * nb;
  const shortData = Math.floor(dataTotal / nb); const longCount = dataTotal % nb;
  const sizes = Array.from({ length: nb }, (_, i) => shortData + (i >= nb - longCount ? 1 : 0));
  const blocks = sizes.map(() => []);
  let k = 0;
  for (let i = 0; i < shortData + 1; i++) for (let b = 0; b < nb; b++) if (i < sizes[b]) blocks[b].push(bytes[k++]);
  for (let i = 0; i < eccLen; i++) for (let b = 0; b < nb; b++) blocks[b].push(bytes[k++]);
  blocks.forEach((b, i) => { if (!syndromesZero(b, eccLen)) throw new Error('Reed-Solomon check failed in block ' + i); });
  const data = []; blocks.forEach((b, i) => data.push(...b.slice(0, sizes[i])));
  let p = 0; const read = (len) => { let v = 0; for (let i = 0; i < len; i++) { const byte = data[p >> 3]; v = (v << 1) | ((byte >> (7 - (p & 7))) & 1); p++; } return v; };
  const mode = read(4);
  if (mode !== 4) throw new Error('not byte mode: ' + mode);
  const len = read(ver < 10 ? 8 : 16);
  const out = []; for (let i = 0; i < len; i++) out.push(read(8));
  return { text: Buffer.from(out).toString('utf8'), version: ver, ecc, mask };
}
