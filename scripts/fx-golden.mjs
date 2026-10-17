#!/usr/bin/env node
// PHOENIX FX golden frames + calm / photosensitivity budget checks (spec 4.7 / 4.9).
// Serves dist/renderer (run `npx vite build` first), renders deterministic frames in headless
// Chromium with SwiftShader WebGL2 and checks the budgets by reading the canvas back.
//
//   node scripts/fx-golden.mjs [--out <dir>] [--tiers high,low] [--quick] [--no-variants] [--no-sweep]
//
// Frames: index.html?fxt=<s>&fxstate=<state>&fxp=<p|null>&fxq=<tier> (see src/renderer/fx/engine.js);
// inside one page the frame is re-targeted with window.__fxFrame(query) to avoid reloads.
// Budgets (exit 1 on violation):
//   - every frame: mean relative luminance <= 0.80
//   - behind UI panels (scrim rects; idle, home, installing): mean <= 0.06, p99 <= 0.25
//   - climax sweeps at 60 Hz: <= 1 flash per second, flash above half-peak <= 90 ms
//   - determinism (two renders identical), no render-target leak over 50 resizes, context loss
//     restores in place, no console errors
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);
const OUT = path.resolve(arg('out', '/tmp/claude-0/-home-user-vanity-/c7ecb4d9-e0be-54ff-8966-3bf390157e70/scratchpad/shots/fx-golden'));
const TIERS = arg('tiers', 'high,low').split(',');
const QUICK = flag('quick');
const DIST = path.join(ROOT, 'dist/renderer');
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('No build at dist/renderer – run "npx vite build" first.');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------------------- server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(DIST, `.${rel}`);
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const HIDE_UI = '#app,#titlebar,#toast-host,#modal-host,.fx-veil,.grain,.cursor-glow{display:none!important}';

const failures = [];
const rows = [];
const consoleErrors = [];
const fail = (msg) => failures.push(msg);

async function openPage(query, width, height, { hideUi = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`[${query}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext/.test(m.text())) consoleErrors.push(`[${query}] ${m.text().slice(0, 300)}`);
  });
  await page.goto(`${BASE}?${query}`);
  if (hideUi) await page.addStyleTag({ content: HIDE_UI });
  if (query.includes('fxt=')) await page.waitForFunction(() => window.__fxReady === true, null, { timeout: 120000 });
  return { ctx, page };
}

const scrimFor = (w, h) => [Math.round(w * 0.22), Math.round(h * 0.26), Math.round(w * 0.56), Math.round(h * 0.48)];
const FRAMES = [
  ...[0.4, 1.2, 2.2, 2.8, 3.2, 3.6, 4.0, 5.5, 6.4].map((t) => ({ name: `boot-${t.toFixed(1)}`, q: `fxt=${t}&fxstate=boot` })),
  { name: 'idle', q: 'fxt=8&fxstate=idle', scrim: true },
  { name: 'home', q: 'fxt=8&fxstate=home', scrim: true },
  ...[0, 0.25, 0.5, 0.75, 1].map((p) => ({ name: `installing-${p.toFixed(2)}`, q: `fxt=10&fxstate=installing&fxp=${p}`, scrim: true })),
  { name: 'installing-null', q: 'fxt=10&fxstate=installing&fxp=null', scrim: true },
  ...[0.2, 1, 3].map((t) => ({ name: `success+${t}`, q: `fxt=${t}&fxstate=success` })),
  ...[0.5, 2.5].map((t) => ({ name: `error+${t}`, q: `fxt=${t}&fxstate=error`, scrim: true })),
  { name: 'warp-peak', q: 'fxt=0.35&fxstate=warp' },
  { name: 'idle-t3600', q: 'fxt=3600&fxstate=idle', scrim: true },
];

const fmt = (v, d = 3) => (v == null ? '-' : Number(v).toFixed(d));

async function shootSet(tier, width, height, frames, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const first = frames[0];
  const { ctx, page } = await openPage(`${first.q}&fxq=${tier}`, width, height);
  for (const f of frames) {
    const scr = f.scrim ? scrimFor(width, height).join(',') : '';
    const q = `${f.q}&fxq=${tier}${scr ? `&fxscrim=${scr}` : ''}`;
    await page.evaluate((qq) => window.__fxFrame(qq), q);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const file = path.join(dir, `${f.name}.png`);
    await page.screenshot({ path: file });
    const st = tier === 'static' ? null : await page.evaluate(() => window.__fxStats());
    const row = { tier, size: `${width}x${height}`, frame: f.name, mean: st?.mean, p99: st?.p99, center: st?.center?.mean, scrMean: st?.scrims?.[0]?.mean, scrP99: st?.scrims?.[0]?.p99, ok: true };
    if (st) {
      if (st.mean > 0.8) {
        row.ok = false;
        fail(`${tier} ${f.name}: frame mean luminance ${fmt(st.mean)} > 0.80`);
      }
      if (f.scrim && st.scrims[0] && (st.scrims[0].mean > 0.06 || st.scrims[0].p99 > 0.25)) {
        row.ok = false;
        fail(`${tier} ${f.name}: behind-panel luminance mean ${fmt(st.scrims[0].mean)} (<=0.06) p99 ${fmt(st.scrims[0].p99)} (<=0.25)`);
      }
    }
    rows.push(row);
  }
  return { ctx, page };
}

// ------------------------------------------------------------------------------------- main sets
const W = 1280;
const H = 800;
const frames = QUICK ? FRAMES.filter((f) => /boot-3.2|boot-3.6|home|installing-0.50|success\+1|error\+2.5|warp/.test(f.name)) : FRAMES;
for (const tier of TIERS) {
  const t0 = Date.now();
  const { ctx, page } = await shootSet(tier, W, H, frames, path.join(OUT, tier));
  // determinism + robustness checks on this page
  await page.evaluate((q) => window.__fxFrame(q), `fxt=3.2&fxstate=boot&fxq=${tier}`);
  const det1 = await page.evaluate(() => window.__fxDeterminism());
  await page.evaluate((q) => window.__fxFrame(q), `fxt=3600&fxstate=idle&fxq=${tier}`);
  const det2 = await page.evaluate(() => window.__fxDeterminism());
  if (det1 !== 0 || det2 !== 0) fail(`${tier}: determinism – ${det1} / ${det2} differing bytes between identical renders`);
  const leak = await page.evaluate(() => window.__fxResizeLeak(50));
  if (leak && leak.after > leak.before) fail(`${tier}: render-target leak over 50 resizes (${leak.before} -> ${leak.after} textures)`);
  // perf: GPU-synced ms per frame (SwiftShader – relative numbers only)
  const perf = await page.evaluate(async (tierName) => {
    const gl = window.__fx.renderer.gl;
    const px = new Uint8Array(4);
    const measure = (q, n = 5) => {
      window.__fxFrame(q);
      const ts = [];
      for (let i = 0; i < n; i++) {
        window.__fx.renderer.plasmaValid = false;
        const a = performance.now();
        window.__fx.renderAt(window.__fxTest.t + i / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        ts.push(performance.now() - a);
      }
      ts.sort((x, y) => x - y);
      return ts[ts.length >> 1];
    };
    return {
      idle: measure(`fxt=20&fxstate=idle&fxq=${tierName}`),
      installing: measure(`fxt=20&fxstate=installing&fxp=0.6&fxq=${tierName}`),
      introPeak: measure(`fxt=3.6&fxstate=boot&fxq=${tierName}`),
      size: window.__fx.info.size,
    };
  }, tier);
  const lr = await page.evaluate(() => window.__fxLoseRestore());
  if (lr && (!lr.rendered || lr.after !== lr.state)) fail(`${tier}: context loss/restore lost the state (${JSON.stringify(lr)})`);
  rows.push({ tier, size: `${W}x${H}`, frame: '(checks)', note: `det ${det1}/${det2}, leak ${leak ? `${leak.before}->${leak.after}` : '-'}, restore ${lr ? (lr.rendered ? 'ok' : 'FAIL') : '-'}, perf idle ${fmt(perf.idle, 0)} ms, installing ${fmt(perf.installing, 0)} ms, intro peak ${fmt(perf.introPeak, 0)} ms @ ${perf.size.w}x${perf.size.h}`, ok: true });
  await ctx.close();
  console.log(`[golden] ${tier}: ${frames.length} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// --------------------------------------------------------------------------------- flash sweeps
if (!flag('no-sweep')) {
  const { ctx, page } = await openPage('fxt=3.3&fxstate=boot&fxq=high', 800, 500);
  const sweep = async (q0, from, to) =>
    page.evaluate(
      async ({ q0, from, to }) => {
        const out = [];
        for (let t = from; t <= to + 1e-6; t += 1 / 60) {
          window.__fxFrame(`${q0}&fxt=${t.toFixed(4)}`);
          const s = window.__fxStats();
          window.__fxFrame(`${q0}&fxt=${t.toFixed(4)}&fxnoflash=1`);
          const n = window.__fxStats();
          out.push([t, s.mean, s.center.mean, s.center.mean - n.center.mean]);
        }
        return out;
      },
      { q0, from, to },
    );
  const analyse = (name, series) => {
    const means = series.map((s) => s[2]);
    const peak = Math.max(...series.map((s) => s[1]));
    const base = Math.min(...means);
    const top = Math.max(...means);
    // flash duration: time the flash term (with minus without flash) stays above half its peak
    const fd = series.map((s) => s[3]);
    const fdMax = Math.max(...fd);
    let above = 0;
    for (const d of fd) if (fdMax > 0.01 && d > fdMax * 0.5) above++;
    const durMs = (above * 1000) / 60;
    // flashes: opposing changes >= 0.1 (relative luminance of the centre region)
    let flashes = 0;
    let lastMin = means[0];
    let rising = false;
    let peakVal = means[0];
    for (const m of means) {
      if (!rising && m - lastMin >= 0.1) {
        rising = true;
        peakVal = m;
      } else if (rising) {
        peakVal = Math.max(peakVal, m);
        if (peakVal - m >= 0.1) {
          flashes++;
          rising = false;
          lastMin = m;
        }
      } else lastMin = Math.min(lastMin, m);
    }
    const span = series[series.length - 1][0] - series[0][0];
    const ok = peak <= 0.8 && flashes <= Math.max(1, Math.ceil(span)) && durMs <= 90;
    if (peak > 0.8) fail(`${name}: frame mean luminance peak ${fmt(peak)} > 0.80`);
    if (flashes > Math.max(1, Math.ceil(span))) fail(`${name}: ${flashes} flashes in ${span.toFixed(1)} s (max 1/s)`);
    if (durMs > 90) fail(`${name}: flash above half-peak for ${durMs.toFixed(0)} ms (> 90 ms)`);
    rows.push({ tier: 'high', size: '800x500', frame: `${name} (60 Hz sweep)`, mean: peak, center: top, note: `flashes ${flashes} in ${span.toFixed(1)} s, centre ${fmt(base)}->${fmt(top)}, flash term +${fmt(fdMax)} above half-peak ${durMs.toFixed(0)} ms`, ok });
  };
  analyse('boot climax 3.30–4.40 s', await sweep('fxstate=boot&fxq=high', 3.3, 4.4));
  analyse('success 0.20–1.30 s', await sweep('fxstate=success&fxq=high', 0.2, 1.3));
  analyse('ignition 0.00–1.00 s', await sweep('fxstate=boot&fxq=high', 0.0, 1.0));
  await ctx.close();
}

// ------------------------------------------------------------------------------------- variants
if (!flag('no-variants')) {
  const V = path.join(OUT, 'variants');
  const sets = [
    { tier: 'ultra', w: W, h: H, frames: [FRAMES[4], FRAMES[9], FRAMES[13]], dir: 'ultra' },
    { tier: 'static', w: W, h: H, frames: [FRAMES[0], FRAMES[10], FRAMES[13], { name: 'success+1', q: 'fxt=1&fxstate=success' }, { name: 'error+2.5', q: 'fxt=2.5&fxstate=error' }], dir: 'static' },
    { tier: 'high', w: W, h: H, frames: [0.4, 1.0, 1.6, 2.5, 3.1].map((t) => ({ name: `short-${t}`, q: `fxt=${t}&fxstate=boot&fxintro=short` })), dir: 'short-intro' },
    { tier: 'high', w: W, h: H, frames: [{ name: 'rm-boot-0.2', q: 'fxt=0.2&fxstate=boot&fxrm=1' }, { name: 'rm-boot-1.0', q: 'fxt=1&fxstate=boot&fxrm=1' }, { name: 'rm-success+1', q: 'fxt=1&fxstate=success&fxrm=1' }, { name: 'rm-home', q: 'fxt=8&fxstate=home&fxrm=1', scrim: true }], dir: 'reduced-motion' },
    { tier: 'high', w: 1920, h: 1080, frames: [FRAMES[4], FRAMES[10], FRAMES[13]], dir: '1080p' },
    { tier: 'high', w: 800, h: 1200, frames: [FRAMES[4], FRAMES[13], FRAMES[18]], dir: 'portrait' },
    { tier: 'high', w: 3840, h: 2160, frames: [FRAMES[4], FRAMES[10]], dir: '4k' },
  ];
  for (const s of sets) {
    const { ctx } = await shootSet(s.tier, s.w, s.h, s.frames, path.join(V, s.dir));
    await ctx.close();
    console.log(`[golden] variants ${s.dir} done`);
  }
}

// -------------------------------------------------------------------------------- tier detection
{
  const { ctx, page } = await openPage('screen=home&lag=0', 1280, 800, { hideUi: false });
  let info = null;
  try {
    await page.waitForFunction(() => window.__phoenix && window.__phoenix.fx && window.__phoenix.fx.attached, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    info = await page.evaluate(() => window.__phoenix.fx.info);
  } catch (err) {
    info = { error: String(err) };
  }
  rows.push({ tier: info?.tier || '?', size: '1280x800', frame: '(auto tier, effects=ultra)', note: JSON.stringify(info), ok: !info?.error });
  await page.screenshot({ path: path.join(OUT, 'app-home-auto-tier.png') });
  await ctx.close();
}

await browser.close();
server.close();

// ---------------------------------------------------------------------------------------- report
for (const e of consoleErrors) fail(`console: ${e}`);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n${pad('tier', 7)}${pad('size', 11)}${pad('frame', 30)}${pad('mean', 7)}${pad('p99', 7)}${pad('centre', 8)}${pad('panel', 7)}${pad('pnlP99', 8)}ok`);
for (const r of rows) {
  console.log(`${pad(r.tier, 7)}${pad(r.size, 11)}${pad(r.frame, 30)}${pad(fmt(r.mean), 7)}${pad(fmt(r.p99), 7)}${pad(fmt(r.center), 8)}${pad(fmt(r.scrMean), 7)}${pad(fmt(r.scrP99), 8)}${r.ok ? 'yes' : 'NO'}${r.note ? `  ${r.note}` : ''}`);
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ rows, failures }, null, 2));
console.log(`\nShots: ${OUT}`);
if (failures.length) {
  console.log(`\nBUDGET VIOLATIONS (${failures.length}):\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('\nAll FX budgets passed.');
