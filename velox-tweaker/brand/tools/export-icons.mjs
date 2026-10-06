// Renders the app icon PNGs (for the .ico and the installer) from the brand SVGs.
//   node brand/tools/export-icons.mjs
// 16/20/24 px come from the pixel-fitted masters (mark-16.svg, src/fit/mark-20/24.svg),
// 32-256 px from per-size vector icons whose keyline is exactly 1 px (3 px at 256).
// Needs Playwright with Chromium (dev machine only; nothing here ships).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), brand = path.resolve(here, '..');
const pw = process.env.PLAYWRIGHT || 'playwright';
const { chromium } = await import(pw.startsWith('/') ? pathToFileURL(pw).href : pw);
const src = (n) => n === 16 ? 'mark-16.svg' : n <= 24 ? `src/fit/mark-${n}.svg` : `src/fit/app-icon-${n}.svg`;
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const b = await chromium.launch();
const p = await b.newPage({ deviceScaleFactor: 1 });
fs.mkdirSync(path.join(brand, 'export'), { recursive: true });
for (const n of sizes) {
  const svg = fs.readFileSync(path.join(brand, src(n)), 'utf8');
  await p.setViewportSize({ width: n, height: n });
  await p.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
  await p.screenshot({ path: path.join(brand, 'export', `app-icon-${n}.png`), omitBackground: true, clip: { x: 0, y: 0, width: n, height: n } });
}
await b.close();
console.log('export/app-icon-{' + sizes.join(',') + '}.png');
