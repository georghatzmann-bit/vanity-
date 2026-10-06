// Browser checks for brand/intro.js and brand/ticks.js (dev only; needs Playwright + Chromium).
//   PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.mjs node brand/tools/verify.mjs
// Serves brand/ on a free local port, then checks: autoplay-blocked state and replay, skip,
// mute (M, remembered), the keyboard released after done() and after the installer settles,
// no replay over installer content, status/progress/done, the hand-over end pose, the still
// variant, reduced motion, slot keyboard safety, the host page's variables left alone, CSP,
// device-pixel snapping at 125/150 %, the tick row, and real-time frame timing (no frame over
// 20 ms after the intro starts, no long tasks).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const brand = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pw = process.env.PLAYWRIGHT || 'playwright';
const { chromium } = await import(pw.startsWith('/') ? pathToFileURL(pw).href : pw);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
// a host page with its own palette (to prove mounting the intro does not retheme it)
const HOST = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'">
<link rel="stylesheet" href="host.css"></head><body><div id="stage"></div><script type="module" src="host.js"></script></body></html>`;
const HOST_CSS = ':root{--bg:#123456;--accent:#7C5CFF;--err:#FF4D6D;--shadow:0 0 1px red;--brand:#ABCDEF}html,body{margin:0;height:100%}#stage{width:880px;height:560px}';
const HOST_JS = `import { VeloxIntro } from './intro.js';
const cs = () => { const s = getComputedStyle(document.documentElement); return ['--bg','--accent','--err','--shadow','--brand'].map((n) => s.getPropertyValue(n).trim()).join('|'); };
window.__before = cs();
window.__intro = VeloxIntro.mount(document.getElementById('stage'), { variant: 'short', sound: false });
window.__intro.ready.then(() => { window.__after = cs(); });`;
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const virt = { '/host.html': [HOST, 'text/html'], '/host.css': [HOST_CSS, 'text/css'], '/host.js': [HOST_JS, 'text/javascript'] }[u];
  if (virt) { res.writeHead(200, { 'Content-Type': virt[1], 'Cache-Control': 'no-store' }); res.end(virt[0]); return; }
  const f = path.join(brand, path.normalize(u).replace(/^([/\\])+/, ''));
  if (!f.startsWith(brand) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const base = `${origin}/preview.html`;

const results = [];
const ok = (name, cond, info = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
async function open(browser, q, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.w || 880, height: opts.h || 560 }, deviceScaleFactor: opts.dpr || 1, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') p.errors.push(m.text()); });
  await p.addInitScript(() => {
    window.__csp = []; window.__lt = []; window.__fr = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective));
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) { /* not supported */ }
    const loop = (ts) => { window.__fr.push(ts); if (window.__fr.length < 300) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await p.goto(q.startsWith('/') ? origin + q : `${base}?${q}`);
  if (q.includes('capture=1')) await p.waitForFunction(() => window.__vx);
  else await p.waitForFunction(() => window.__intro && window.__intro.startedAt !== null);
  return p;
}
const settledP = (p) => p.evaluate(() => document.querySelector('.vx').classList.contains('vx--settled'));
const soundLabel = (p) => p.evaluate(() => { const b = document.querySelector('.vx-sound'); return [b.querySelector('span').textContent, b.getAttribute('aria-pressed'), b.hidden]; });

// ---- autoplay blocked (default policy)
{
  const b = await chromium.launch();
  const p = await open(b, 'variant=full');
  await p.waitForTimeout(400);
  const s0 = await p.evaluate(() => ({ a: __intro.audible, b: __intro.blocked, s: __intro.startedAt }));
  ok('autoplay blocked: intro runs silent and says so', s0.a === false && s0.b === true);
  const lab = await soundLabel(p);
  ok('... the button reads "Ton: klicken", not pressed', lab[0] === 'Ton: klicken' && lab[1] === 'false', lab.join(' / '));
  await p.keyboard.press('m'); await p.waitForTimeout(200);
  const s1 = await p.evaluate(() => ({ a: __intro.audible, m: __intro.muted, s: __intro.startedAt, ls: localStorage.getItem('velox.sound') }));
  ok('... M unlocks instead of muting: replay from the start, with sound', s1.m === false && s1.a === true && s1.s > s0.s + 300 && s1.ls !== 'off', JSON.stringify(s1));
  ok('... then the button reads "Ton an"', (await soundLabel(p))[0] === 'Ton an');

  const c = await open(b, 'variant=full');
  await c.waitForTimeout(400);
  const c0 = await c.evaluate(() => __intro.startedAt);
  await c.mouse.click(700, 420); await c.waitForTimeout(200);
  const c1 = await c.evaluate(() => ({ a: __intro.audible, s: __intro.startedAt }));
  ok('first click before the settle replays the intro with sound', c1.s > c0 + 300 && c1.a === true);
  await c.mouse.click(700, 420); await c.waitForTimeout(100);
  ok('a second click does not replay', (await c.evaluate(() => __intro.startedAt)) === c1.s);
  ok('no CSP violations, no errors', (await c.evaluate(() => __csp.length)) === 0 && c.errors.length === 0, c.errors.join('; '));

  // installer: content in the slot -> never a replay, even right after the settle
  const s = await open(b, 'variant=full&place=header');
  await s.waitForFunction(() => document.querySelector('.vx').classList.contains('vx--settled'));
  const st0 = await s.evaluate(() => __intro.startedAt);
  await s.click('.pv-welcome p'); await s.waitForTimeout(250);
  ok('installer: a click on the welcome text after the settle does not restart the intro', (await s.evaluate(() => __intro.startedAt)) === st0 && (await settledP(s)));
  ok('installer: the keyboard is released once settled', (await s.evaluate(() => __intro.keysActive)) === false);
  const ls0 = await s.evaluate(() => localStorage.getItem('velox.sound'));
  await s.keyboard.press('m');
  ok('installer: M after the settle changes nothing', (await s.evaluate(() => localStorage.getItem('velox.sound'))) === ls0);

  // keys and mute
  const q = await open(b, 'variant=full');
  await q.waitForTimeout(300);
  const t = Date.now(); await q.keyboard.press('Escape');
  await q.waitForFunction(() => document.querySelector('.vx').classList.contains('vx--settled'));
  ok('Esc skips to the settled state', Date.now() - t < 250, `${Date.now() - t} ms`);
  await q.keyboard.press('m');
  ok('M mutes and stores it (after the settle: no longer blocked)', await q.evaluate(() => __intro.muted && localStorage.getItem('velox.sound') === 'off'));
  await q.reload(); await q.waitForFunction(() => window.__intro && window.__intro.startedAt !== null);
  ok('mute survives a reload', await q.evaluate(() => __intro.muted));
  await q.keyboard.press('m');
  await q.evaluate(() => { __intro.status('System wird gelesen'); __intro.progress(0.5); });
  await q.waitForTimeout(80);
  const stt = await q.evaluate(() => [document.querySelector('.vx-status').textContent, document.querySelector('.vx-pct').textContent]);
  ok('status() and progress()', stt[0] === 'System wird gelesen' && stt[1].startsWith('50'), stt.join(' | '));
  const d = await q.evaluate(() => { const t0 = performance.now(); return __intro.done().then(() => performance.now() - t0); });
  ok('done() waits for the settle, then resolves after snap + retract', d > 1000 && d < 3500, `${d.toFixed(0)} ms`);
  ok('hand-over end pose is the canonical wordmark (no line in the cut)', await q.evaluate(() => getComputedStyle(document.querySelector('.vx-blade')).opacity === '0'));
  ok('the keyboard is released after done()', (await q.evaluate(() => __intro.keysActive)) === false);
  const lsBefore = await q.evaluate(() => localStorage.getItem('velox.sound'));
  await q.keyboard.press('m');
  ok('M anywhere in the app after done() leaves velox.sound alone', (await q.evaluate(() => localStorage.getItem('velox.sound'))) === lsBefore, String(lsBefore));
  await q.evaluate(() => __intro.destroy());
  ok('destroy() removes the intro', await q.evaluate(() => !document.querySelector('.vx')));

  // still
  const v = await open(b, 'variant=still');
  const vs = await v.evaluate(() => ({ btn: document.querySelector('.vx-sound').hidden, seg: getComputedStyle(document.querySelector('.vx-seg')).opacity, keys: __intro.keysActive }));
  ok('still: no sound button, no resting segment, no keyboard listener', vs.btn === true && vs.seg === '0' && vs.keys === false, JSON.stringify(vs));

  const r = await open(b, 'variant=full', { reduced: true });
  ok('prefers-reduced-motion gives the calm fade', await r.evaluate(() => document.querySelector('.vx').classList.contains('vx--reduced')));
  const e = await open(b, 'variant=full&place=header');
  await e.waitForTimeout(200); await e.focus('.pv-primary'); await e.keyboard.press('Enter');
  ok('Enter on an installer button does not skip the intro', !(await settledP(e)));

  // the host page keeps its own palette
  const h = await open(b, '/host.html');
  await h.waitForFunction(() => window.__after);
  const hv = await h.evaluate(() => [window.__before, window.__after]);
  ok('mounting the intro leaves the host page\'s --bg/--accent/--err/--shadow/--brand alone', hv[0] === hv[1] && hv[0].startsWith('#123456'), hv[1]);
  await b.close();
}

// ---- device pixels at 125 / 150 %: the blade is solid signal, whole device pixels, no fringe
{
  const b = await chromium.launch();
  for (const dpr of [1, 1.25, 1.5]) {
    const p = await open(b, 'capture=1&variant=full&place=hero', { dpr });
    await p.evaluate(() => window.__vx.ready);
    await p.evaluate(() => window.__vx.seek(245));
    const buf = await p.screenshot({ clip: { x: 10, y: 0, width: 1, height: 560 } });
    const px = await p.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data, out = [];
      for (let y = 0; y < img.height; y++) { const i = y * img.width * 4; const r = d[i], gg = d[i + 1], bb = d[i + 2]; if (Math.abs(r - 12) + Math.abs(gg - 13) + Math.abs(bb - 15) > 12) out.push([r, gg, bb]); }
      return out;
    }, buf.toString('base64'));
    const pure = px.length > 0 && px.every(([r, g, bl]) => r === 255 && g === 90 && bl === 31);
    ok(`blade at ${dpr * 100} %: ${px.length} device rows, all pure signal`, pure && px.length === Math.round(2 * dpr), JSON.stringify(px.slice(0, 4)));
    const tk = await open(b, 'capture=1&variant=full&place=header&install=0.42', { dpr });
    await tk.evaluate(() => window.__vx.ready);
    await tk.evaluate(() => window.__vx.seek(2100));
    const cv = await tk.evaluate(() => { const c = document.querySelector('.vx-ticks-canvas'), r = c.getBoundingClientRect(); return { w: c.width, cssw: r.width, x: r.left * devicePixelRatio, dpr: devicePixelRatio }; });
    // (tolerance 0.05 device px: Chromium lays out in 1/64 CSS px units)
    ok(`tick row at ${dpr * 100} %: canvas pixels are device pixels`, Math.abs(cv.w - cv.cssw * cv.dpr) < 0.05 && Math.abs(cv.x - Math.round(cv.x)) < 0.05, JSON.stringify(cv));
  }
  await b.close();
}

// ---- frame timing with audio running (autoplay allowed, as VELOX.exe/VeloxSetup.exe configure WebView2)
{
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p0 = await open(b, 'variant=full');
  ok('autoplay allowed: "Ton an" from the first frame, audible', (await soundLabel(p0))[0] === 'Ton an' && (await p0.evaluate(() => __intro.audible)));
  for (const [v, w, h] of [['full', 880, 560], ['full', 1360, 880], ['short', 880, 560], ['reduced', 880, 560]]) {
    const p = await open(b, `variant=${v}&size=fill`, { w, h });
    await p.waitForTimeout(2600);
    const m = await p.evaluate(() => {
      const f = window.__fr, s0 = window.__intro.startedAt, d = [];
      for (let i = 1; i < f.length; i++) if (f[i - 1] >= s0) d.push(f[i] - f[i - 1]);
      return { n: d.length, over: d.filter((x) => x > 20).length, max: Math.max(...d), lt: window.__lt.filter(([t, du]) => t + du > s0).length, audible: window.__intro.audible };
    });
    ok(`${v} ${w}x${h}: 60 fps, no long tasks`, m.over === 0 && m.lt === 0, `${m.n} frames, max ${m.max.toFixed(1)} ms, >20 ms: ${m.over}, long tasks: ${m.lt}, sound: ${m.audible}`);
  }
  await b.close();
}
server.close();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
