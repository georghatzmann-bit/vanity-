#!/usr/bin/env node
// Renders velox.ico (16..256 px) and velox-256.png from the brand kit (velox-tweaker/brand), the single
// source of truth for the app icon. Same sources as brand/tools/export-icons.mjs:
//   16 px       brand/mark-16.svg              (pixel master: every pixel on or off)
//   20, 24 px   brand/src/fit/mark-20/24.svg   (pixel-fitted masters, drawn by rule in brand/src/pixelfit.mjs)
//   32 - 256 px brand/src/fit/app-icon-<n>.svg (brand/app-icon.svg with every horizontal edge and the
//                                                keyline snapped to whole pixels at that size)
// Chromium renders each size 1:1 (no resampling), ImageMagick unpacks the pixels, and the frames are packed
// into one .ico. The result is compared with brand/export/app-icon-<n>.png.
//   node native/assets/make-icon.mjs   (needs the global Playwright + ImageMagick "convert")
import { createRequire } from 'node:module';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const brand = path.resolve(here, '../../brand');
function loadPlaywright() {
  const tries = [() => createRequire(import.meta.url)('playwright'), () => createRequire('/opt/node22/lib/node_modules/')('playwright')];
  tries.push(() => createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'));
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  throw new Error('Playwright not found (expected a global install).');
}
const { chromium } = loadPlaywright();

const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const source = (n) => (n === 16 ? 'mark-16.svg' : n <= 24 ? `src/fit/mark-${n}.svg` : `src/fit/app-icon-${n}.svg`);
const svg = (n) => fs.readFileSync(path.join(brand, source(n)), 'utf8');

// ICO with classic 32-bit DIB frames up to 48 px (every Windows API and .NET's Icon class reads
// them) and PNG-compressed frames from 64 px up (Vista+), which keeps the file - and both exes - small.
function packIco(frames) {
  const blobs = frames.map(({ size, png }) => {
    if (size >= 64) return fs.readFileSync(png);
    const raw = execFileSync('convert', [png, '-depth', '8', 'RGBA:-'], { maxBuffer: 1 << 24 });
    const rowAnd = Math.ceil(size / 32) * 4;
    const dib = Buffer.alloc(40 + size * size * 4 + rowAnd * size);
    dib.writeUInt32LE(40, 0); dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14); dib.writeUInt32LE(0, 16);
    dib.writeUInt32LE(size * size * 4 + rowAnd * size, 20);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const src = ((size - 1 - y) * size + x) * 4;   // DIB rows are bottom-up
        const dst = 40 + (y * size + x) * 4;
        dib[dst] = raw[src + 2]; dib[dst + 1] = raw[src + 1]; dib[dst + 2] = raw[src]; dib[dst + 3] = raw[src + 3];
      }
    }
    return dib;   // AND mask stays all zero: the alpha channel decides
  });
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(blobs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += blobs[i].length;
  });
  return Buffer.concat([head, ...blobs]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-icon-'));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const pngs = [];
  for (const s of SIZES) {
    await page.setViewportSize({ width: s, height: s });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg(s)}</body></html>`);
    const file = path.join(tmp, `icon-${s}.png`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
    pngs.push(file);
    // same pixels as the kit's export (decoded RGBA, so PNG encoder differences do not count)
    const ref = path.join(brand, 'export', `app-icon-${s}.png`);
    if (fs.existsSync(ref)) {
      const a = execFileSync('convert', [file, '-depth', '8', 'RGBA:-'], { maxBuffer: 1 << 24 });
      const b = execFileSync('convert', [ref, '-depth', '8', 'RGBA:-'], { maxBuffer: 1 << 24 });
      console.log(`${String(s).padStart(3)} px  ${source(s).padEnd(26)} ${Buffer.compare(a, b) === 0 ? 'identical to brand/export' : 'DIFFERS from brand/export/app-icon-' + s + '.png'}`);
    }
  }
  const out = path.join(here, 'velox.ico');
  fs.writeFileSync(out, packIco(SIZES.map((s, i) => ({ size: s, png: pngs[i] }))));
  fs.copyFileSync(path.join(tmp, 'icon-256.png'), path.join(here, 'velox-256.png'));
  console.log('wrote ' + out + ' (' + fs.statSync(out).size + ' bytes)');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
