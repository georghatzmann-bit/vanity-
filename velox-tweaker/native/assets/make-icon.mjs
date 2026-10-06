#!/usr/bin/env node
// Renders velox.ico (16..256 px) from the VELOX logo: a dark rounded tile with the fader-V
// (same drawing as the favicon in ui/index.html). Chromium renders each size as PNG with real
// anti-aliasing; ImageMagick packs them into one .ico. Small sizes use slightly bolder strokes so
// the three faders stay readable at 16 px.
//   node native/assets/make-icon.mjs   (needs the global Playwright + ImageMagick "convert")
import { createRequire } from 'node:module';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function loadPlaywright() {
  const tries = [() => createRequire(import.meta.url)('playwright'), () => createRequire('/opt/node22/lib/node_modules/')('playwright')];
  tries.push(() => createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'));
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  throw new Error('Playwright not found (expected a global install).');
}
const { chromium } = loadPlaywright();

const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

function svg(size) {
  const small = size <= 24;
  const mid = size > 24 && size <= 48;
  const track = small ? 3.4 : mid ? 3 : 2.6;
  const v = small ? 6.4 : mid ? 5.6 : 5;
  const trackOpacity = small ? 0.55 : 0.42;
  const r = size <= 32 ? 9 : 11;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1B1F2A"/><stop offset="1" stop-color="#12141B"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy=".55" r=".5"><stop offset="0" stop-color="#7C5CFF" stop-opacity=".28"/><stop offset="1" stop-color="#7C5CFF" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="48" height="48" rx="${r}" fill="url(#g)"/>
  ${size >= 32 ? '<rect width="48" height="48" rx="' + r + '" fill="url(#glow)"/>' : ''}
  ${size >= 48 ? '<rect x=".5" y=".5" width="47" height="47" rx="' + (r - 0.5) + '" fill="none" stroke="#fff" stroke-opacity=".07"/>' : ''}
  <path d="M11 6v36M24 6v36M37 6v36" stroke="#7C5CFF" stroke-opacity="${trackOpacity}" stroke-width="${track}" stroke-linecap="round"/>
  <path d="M11 13 24 35 37 13" fill="none" stroke="#7C5CFF" stroke-width="${v}" stroke-linecap="round" stroke-linejoin="round"/>
  <g fill="#E8EAF0"><rect x="5" y="9.5" width="12" height="7" rx="2.4"/><rect x="18" y="31.5" width="12" height="7" rx="2.4"/><rect x="31" y="9.5" width="12" height="7" rx="2.4"/></g>
</svg>`;
}

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
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg(s)}</body></html>`);
    const file = path.join(tmp, `icon-${s}.png`);
    await page.locator('svg').screenshot({ path: file, omitBackground: true });
    pngs.push(file);
  }
  const out = path.join(here, 'velox.ico');
  fs.writeFileSync(out, packIco(SIZES.map((s, i) => ({ size: s, png: pngs[i] }))));
  fs.copyFileSync(path.join(tmp, 'icon-256.png'), path.join(here, 'velox-256.png'));
  console.log('wrote ' + out + ' (' + fs.statSync(out).size + ' bytes)');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
