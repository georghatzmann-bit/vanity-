// Regenerates the two images the site draws from its own pages:
//   assets/img/bios-phone.webp  - the BIOS checklist on a phone (shown on the home page)
//   assets/img/og.png           - the social preview (OpenGraph), 1200x630
// Usage: node website/tests/make-assets.mjs   (needs ImageMagick "convert" for the webp)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadPlaywright, startServer, site, SAMPLE_FRAGMENT } from './lib.mjs';

const { chromium } = loadPlaywright();
const server = await startServer();
const browser = await chromium.launch();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-assets-'));
try {
  // 1. phone screenshot of the checklist (dark theme, 390 css px wide, 2x)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(server.url + 'bios.html#' + SAMPLE_FRAGMENT);
  await page.waitForSelector('#bios-app:not([hidden])');
  // a realistic moment: one item already ticked off, scrolled to the checklist
  await page.locator('.item[data-code="sb"] .tick').click();
  await page.evaluate(() => { const h = document.getElementById('core-title'); window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 96); });
  await page.waitForTimeout(300);
  const png = path.join(tmp, 'phone.png');
  await page.screenshot({ path: png });
  execFileSync('convert', [png, '-strip', '-quality', '80', '-define', 'webp:method=6', path.join(site, 'assets/img/bios-phone.webp')]);
  await page.evaluate(() => localStorage.clear());
  await ctx.close();

  // 2. OpenGraph image: the wordmark on ink, one line of text
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await og.setContent(`<!doctype html><html><body style="margin:0;background:#0C0D0F;width:1200px;height:630px;position:relative;overflow:hidden;font-family:'Segoe UI','Noto Sans','DejaVu Sans',sans-serif">
    <img src="${server.url}brand/wordmark.svg" style="position:absolute;left:52px;top:170px;width:720px;height:auto">
    <div style="position:absolute;left:96px;top:392px;width:40px;height:3px;background:#FF5A1F"></div>
    <div style="position:absolute;left:96px;top:416px;color:#ECE9E2;font-size:40px;font-weight:600;letter-spacing:-0.5px">Der kostenlose PC-Tweaker für Windows</div>
    <div style="position:absolute;left:96px;top:474px;color:#8E8B85;font-size:26px">472 erklärte Tweaks · Presets · KI-Optimierer · alles rückgängig</div>
  </body></html>`);
  await og.waitForTimeout(300);
  await og.screenshot({ path: path.join(site, 'assets/img/og.png') });
  execFileSync('convert', [path.join(site, 'assets/img/og.png'), '-strip', '-colors', '64', path.join(site, 'assets/img/og.png')]);
  console.log('assets written: assets/img/bios-phone.webp, assets/img/og.png');
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
