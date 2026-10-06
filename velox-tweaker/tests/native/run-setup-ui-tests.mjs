// VELOX native UI tests: drives native/setup-ui (the installer) and native/host/start (VELOX.exe's start
// screen) in Chromium with a mocked window.chrome.webview bridge - the same message protocol VeloxSetup.exe and
// VELOX.exe speak (docs/ARCHITECTURE.md section 11). Both pages run brand/intro.js from their brand/ copies.
//
//   node velox-tweaker/tests/native/run-setup-ui-tests.mjs [--headed]
//
// Chromium is started with --autoplay-policy=no-user-gesture-required, exactly like both native hosts start
// WebView2, so the intro's sound really plays; one block runs without it (the "Ton: klicken" fallback).
// Screenshots and intro frames land in tests/native/screenshots/ (frame names carry the measured intro time).
// Uses the globally installed Playwright with its preinstalled Chromium (never runs "playwright install").
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../..');
const SETUP_UI = path.join(APP, 'native/setup-ui');
const HOST_START = path.join(APP, 'native/host/start');
const SHOTS = path.join(HERE, 'screenshots');
const HEADED = process.argv.includes('--headed');
const AUTOPLAY = '--autoplay-policy=no-user-gesture-required';

function loadPlaywright() {
  const tries = [() => createRequire(import.meta.url)('playwright'), () => createRequire('/opt/node22/lib/node_modules/')('playwright')];
  tries.push(() => createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'));
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  throw new Error('playwright not found');
}
const { chromium } = loadPlaywright();

// ------------------------------------------------------------------ static server (like the virtual hosts)
//   /...        native/setup-ui      (https://setup.velox.example/ in VeloxSetup.exe)
//   /start/...  native/host/start    (https://start.velox.example/ in VELOX.exe)
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const [root, sub] = rel.startsWith('start/') ? [HOST_START, rel.slice(6)] : [SETUP_UI, rel];
  const file = path.join(root, path.normalize(sub));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ harness
let pass = 0, fail = 0;
const failures = [];
function ok(cond, what) {
  if (cond) { pass++; console.log('  ok    ' + what); }
  else { fail++; failures.push(what); console.log('  FAIL  ' + what); }
}
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const INIT = {
  install: { type: 'init', version: '1.2.0', mode: 'install', installedVersion: '', dir: 'C:\\Program Files\\VELOX', defaultDir: 'C:\\Program Files\\VELOX', sizeMB: 3, freeMB: 182345, running: false },
  update: { type: 'init', version: '1.2.0', mode: 'update', installedVersion: '1.1.1', dir: 'C:\\Program Files\\VELOX', defaultDir: 'C:\\Program Files\\VELOX', sizeMB: 3, freeMB: 182345, running: true },
  uninstall: { type: 'init', version: '1.2.0', mode: 'uninstall', installedVersion: '1.2.0', dir: 'C:\\Program Files\\VELOX', defaultDir: 'C:\\Program Files\\VELOX', sizeMB: 3, freeMB: 182345, running: false },
};

// The mock bridge: records page -> host messages, answers "ready" with the scenario's init message.
// It also records CSP violations (the pages run under a strict CSP: script-src/style-src 'self').
function bridgeScript(init) {
  return `(() => {
    const listeners = [];
    window.__sent = [];
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    window.__emit = (data) => listeners.forEach(fn => fn({ data }));
    window.chrome = window.chrome || {};
    window.chrome.webview = {
      postMessage(m) {
        window.__sent.push(Object.assign({ at: performance.now() }, JSON.parse(JSON.stringify(m))));
        if (m && m.type === 'ready' && ${JSON.stringify(!!init)}) setTimeout(() => window.__emit(${JSON.stringify(init || null)}), 20);
      },
      addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
      removeEventListener() {}
    };
  })();`;
}

const autoplayBrowser = await chromium.launch({ headless: !HEADED, args: [AUTOPLAY] });
const strictBrowser = await chromium.launch({ headless: !HEADED });   // default policy: audio needs a gesture

async function openPage(url, init, { scale = 1, reduced = false, width = 880, height = 560, browser = autoplayBrowser } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: reduced ? 'reduce' : 'no-preference', locale: 'de-DE' });
  const page = await context.newPage();
  const errors = [];
  // (the tests' own pixel reads of the tick canvases trigger Chromium's willReadFrequently hint: not the page's)
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/willReadFrequently/.test(m.text())) errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
  page.on('response', r => { if (r.status() >= 400) errors.push('http ' + r.status() + ': ' + r.url()); });
  await page.addInitScript(bridgeScript(init));
  await page.goto(url);
  return { page, context, errors };
}
const openSetup = (scenario, opts = {}) => openPage(`${ORIGIN}/index.html${opts.query || (scenario === 'uninstall' ? '?mode=uninstall' : '')}`, INIT[scenario], opts);
const openSplash = (query, opts = {}) => openPage(`${ORIGIN}/start/splash.html?${query}`, null, { width: 1360, height: 880, ...opts });

const sent = (page) => page.evaluate(() => window.__sent);
const lastSent = async (page, type) => (await sent(page)).filter(m => m.type === type).pop();
const emit = (page, msg) => page.evaluate(m => window.__emit(m), msg);
const cspViolations = (page) => page.evaluate(() => window.__csp);
async function shot(page, name) {
  if (!name.startsWith('intro-') && !name.startsWith('host-intro-')) { await page.mouse.move(2, 300); await page.waitForTimeout(150); }
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
async function waitScreen(page, name, timeout = 5000) {
  try { await page.waitForFunction(n => document.body.getAttribute('data-screen') === n && document.querySelector('.screen.active')?.getAttribute('data-screen') === n, name, { timeout }); return true; }
  catch { return false; }
}
const introOf = 'window.__veloxSetup.intro';
async function waitSettled(page, timeout = 4000) {
  try { await page.waitForFunction(() => document.querySelector('.vx')?.classList.contains('vx--settled'), null, { timeout }); return true; }
  catch { return false; }
}
async function started(page, expr = introOf) { await page.waitForFunction(e => { const i = eval(e); return i && i.startedAt !== null; }, expr, { timeout: 5000 }); }
/** Let the screen's arrival animation (460 ms) finish. */
const quiet = (page) => page.waitForTimeout(600);
async function skipIntro(page) { await started(page); await page.keyboard.press('Escape'); await waitSettled(page, 1500); await quiet(page); }

/** Visible elements of the active screen: inside the window, under the wordmark, no clipped text, no scrolling. */
async function layoutProblems(page, scope = '.screen.active') {
  return page.evaluate((scope) => {
    const out = [];
    const W = innerWidth, H = innerHeight;
    const de = document.documentElement;
    if (de.scrollWidth > W || de.scrollHeight > H) out.push(`document scrolls ${de.scrollWidth}x${de.scrollHeight}`);
    const scr = document.querySelector(scope);
    if (!scr) return ['no ' + scope];
    const word = document.querySelector('.vx-word');
    // the word's ink: the svg has a 24-unit margin around the glyphs (intro.js M = 24 of a 100-unit cap)
    let inkBottom = 0;
    if (word) { const r = word.getBoundingClientRect(); inkBottom = r.top + r.height * (124 / 148); }
    for (const el of scr.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const tag = `${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].join('.')}`;
      if (r.left < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) out.push(`${tag} outside at ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
      if (r.top < inkBottom - 0.5) out.push(`${tag} overlaps the wordmark (top ${Math.round(r.top)} < ${Math.round(inkBottom)})`);
      if (el.children.length === 0 && el.textContent.trim() && cs.textOverflow !== 'ellipsis' && cs.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && el.tagName !== 'PRE')
        out.push(`text clipped in ${tag}`);
      if (el.tagName === 'BUTTON' && r.height > 40) out.push(`button wraps: ${tag} ${Math.round(r.height)} px high`);
    }
    return out;
  }, scope);
}

/** Old identity anywhere on the page: violet / cyan, gradients, glows. */
async function oldLook(page) {
  return page.evaluate(() => {
    const bad = [];
    const OLD = [/124,\s*92,\s*255/, /34,\s*211,\s*238/, /142,\s*115,\s*255/, /156,\s*134,\s*255/, /232,\s*234,\s*240/, /15,\s*17,\s*21\)/];
    for (const el of [document.documentElement, ...document.querySelectorAll('*')]) {
      const cs = getComputedStyle(el);
      for (const p of ['color', 'background-color', 'border-top-color', 'border-left-color', 'outline-color', 'fill', 'stroke', 'box-shadow', 'background-image', 'filter']) {
        const v = cs.getPropertyValue(p);
        if (OLD.some(rx => rx.test(v))) bad.push(`${el.tagName.toLowerCase()}#${el.id} ${p}: ${v}`);
        if (p === 'background-image' && /gradient/.test(v)) bad.push(`${el.tagName.toLowerCase()}#${el.id} gradient`);
        if (p === 'filter' && /drop-shadow|blur/.test(v)) bad.push(`${el.tagName.toLowerCase()}#${el.id} filter ${v}`);
      }
    }
    return bad.slice(0, 5);
  });
}

/** Colours of the pixels in a tick-row canvas (counts). */
async function tickColours(page, sel) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel + ' canvas');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const n = { signal: 0, risk: 0, bone: 0, line: 0, other: 0 };
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
      if (k === '255,90,31') n.signal++; else if (k === '242,90,128') n.risk++; else if (k === '236,233,226') n.bone++; else if (k === '42,44,49') n.line++; else n.other++;
    }
    return n;
  }, sel);
}

// ================================================================== static: no old look in the sources
console.log('sources');
{
  const files = ['native/setup-ui/index.html', 'native/setup-ui/setup.css', 'native/setup-ui/setup.js', 'native/host/start/splash.html', 'native/host/start/splash.css', 'native/host/start/splash.js'];
  const bad = files.filter(f => /7C5CFF|22D3EE|8E73FF|9C86FF|B6A6FF|E8EAF0|0F1115|linear-gradient|radial-gradient|confetti|aurora|drop-shadow/i.test(fs.readFileSync(path.join(APP, f), 'utf8')));
  ok(bad.length === 0, 'no old purple / cyan / gradients / confetti / aurora in the setup and start-screen sources ' + bad.join(', '));
  const inline = files.filter(f => f.endsWith('.html')).filter(f => /<style|<script(?![^>]*\bsrc=)|\sstyle=|\son[a-z]+=/i.test(fs.readFileSync(path.join(APP, f), 'utf8')));
  ok(inline.length === 0, 'no inline <style>, inline <script>, style= or on*= attributes (strict CSP) ' + inline.join(', '));
  for (const [dir, list] of [['native/setup-ui/brand', ['glyphs.js', 'intro.css', 'intro.js', 'kit.css', 'sound.js', 'ticks.js', 'tokens.css']], ['native/host/start/brand', ['glyphs.js', 'intro.css', 'intro.js', 'sound.js', 'tokens.css']]]) {
    const same = list.filter(f => Buffer.compare(fs.readFileSync(path.join(APP, dir, f)), fs.readFileSync(path.join(APP, 'brand', f))) === 0);
    ok(same.length === list.length, `${dir}: byte-identical copies of brand/ (${same.length}/${list.length})`);
  }
}

// ================================================================== 1. installer: full intro with sound, welcome arrives under the word
console.log('installer intro');
{
  const { page, context, errors } = await openSetup('install');
  await started(page);
  const info = await page.evaluate(() => { const i = window.__veloxSetup.intro; return { variant: i.variant, audible: i.audible, blocked: i.blocked, keys: i.keysActive }; });
  ok(info.variant === 'full', 'installer plays the full intro');
  ok(info.audible === true && info.blocked === false, `sound plays without a click (autoplay flag, like SetupWindow.cs): audible=${info.audible} blocked=${info.blocked}`);
  ok((await page.textContent('.vx-sound span')) === 'Ton an', 'sound button: "Ton an"');
  ok(info.keys, 'intro listens for M / Esc while it runs');
  // frames at the beats of the sequence; the name carries the measured intro time
  const beats = [60, 200, 330, 470, 860, 935, 1010, 1300, 1650, 2100];
  for (let i = 0; i < beats.length; i++) {
    await page.waitForFunction(ms => performance.now() - window.__veloxSetup.intro.startedAt >= ms, beats[i], { timeout: 5000, polling: 'raf' });
    const t = await page.evaluate(() => Math.round(performance.now() - window.__veloxSetup.intro.startedAt));
    await shot(page, `intro-${String(i + 1).padStart(2, '0')}-${String(t).padStart(4, '0')}ms`);
    if (beats[i] === 470) ok(await page.evaluate(() => getComputedStyle(document.querySelector('.vx-slot')).opacity === '0'), 'welcome stays hidden while the intro runs');
  }
  ok(await waitSettled(page, 1000), 'intro settles (1.6 s)');
  ok(await page.evaluate(() => { const i = window.__veloxSetup.intro; return performance.now() - i.startedAt < 2600; }), 'settled within the full variant\'s timeline');
  ok(!(await page.evaluate(() => window.__veloxSetup.intro.keysActive)), 'the intro releases the keyboard when it settles (M in the form changes nothing)');
  const w0 = await page.evaluate(() => JSON.stringify(document.querySelector('.vx-word').getBoundingClientRect()));
  await quiet(page);
  ok((await page.evaluate(() => getComputedStyle(document.querySelector('.vx-slot')).opacity)) === '1', 'welcome arrives under the settled word (same surface)');
  ok(w0 === await page.evaluate(() => JSON.stringify(document.querySelector('.vx-word').getBoundingClientRect())), 'the word does not move when the welcome arrives');
  await shot(page, 'welcome-install');
  ok((await page.textContent('#btn-install-label')) === 'Installieren', 'Welcome: "Installieren"');
  ok((await page.textContent('#w-dir')) === 'C:\\Program Files\\VELOX' && (await page.textContent('#u-to')) === '1.2.0' && (await page.textContent('#w-size')).includes('frei'), 'Welcome: readouts Ziel / Größe / Version from init');
  ok((await page.textContent('#tb-ver')) === '1.2.0', 'title bar shows the version');
  ok(await page.isHidden('#update-note'), 'Welcome: no "from -> to" on a fresh install');
  ok((await sent(page)).some(m => m.type === 'ready'), 'page announces itself with "ready"');
  ok(await page.evaluate(() => [...document.querySelectorAll('.btn.primary')].filter(b => b.offsetParent).length === 1), 'exactly one orange (primary) button on the screen');
  ok((await page.evaluate(() => getComputedStyle(document.getElementById('btn-install')).color)) === 'rgb(12, 13, 15)', 'primary button: ink text on signal (never bone on orange)');
  ok((await layoutProblems(page)).length === 0, 'welcome: layout fits ' + (await layoutProblems(page)).join('; '));
  await page.keyboard.press('m');
  ok(!(await lastSent(page, 'sound')), 'M after the settle does nothing (no sound message)');
  // title bar
  await page.mouse.move(300, 18); await page.mouse.down(); await page.mouse.up();
  ok(!!(await lastSent(page, 'drag')), 'title bar sends "drag"');
  await page.click('#btn-min');
  ok(!!(await lastSent(page, 'minimize')), 'minimize button sends "minimize"');
  ok((await oldLook(page)).length === 0, 'no old purple / cyan / gradient / glow on the welcome ' + (await oldLook(page)).join(' | '));
  ok((await cspViolations(page)).length === 0, 'no CSP violations ' + (await cspViolations(page)).join(' | '));
  ok(errors.length === 0, 'no console errors or warnings (intro + welcome): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 2. skip, mute
console.log('installer intro: skip and mute');
{
  const { page, context, errors } = await openSetup('install');
  await started(page);
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await page.keyboard.press('Escape');
  ok(await waitSettled(page, 400), `Esc skips to the settled word at once (${Date.now() - t0} ms)`);
  await quiet(page);
  ok(await page.isVisible('#btn-install'), 'after skipping, the welcome is there');
  await shot(page, 'intro-skipped');
  ok(errors.length === 0, 'no console errors (skip): ' + errors.join(' | '));
  await context.close();
}
{
  const { page, context } = await openSetup('install');
  await started(page);
  await page.waitForTimeout(250);
  await page.mouse.click(600, 300);
  ok(await waitSettled(page, 400), 'a click on the intro skips it');
  await context.close();
}
{
  const { page, context, errors } = await openSetup('install');
  await started(page);
  await page.waitForTimeout(200);
  await page.keyboard.press('m');
  await page.waitForTimeout(80);
  const s1 = await page.evaluate(() => ({ muted: window.__veloxSetup.intro.muted, label: document.querySelector('.vx-sound span').textContent, pressed: document.querySelector('.vx-sound').getAttribute('aria-pressed') }));
  ok(s1.muted && s1.label === 'Ton aus' && s1.pressed === 'false', 'M mutes during the intro: "Ton aus"');
  ok((await lastSent(page, 'sound'))?.on === false, 'mute is reported to the setup: sound{on:false}');
  await shot(page, 'intro-muted');
  await page.click('.vx-sound');
  ok(!(await page.evaluate(() => window.__veloxSetup.intro.muted)) && (await lastSent(page, 'sound'))?.on === true, 'the sound button turns it back on: sound{on:true}');
  ok(errors.length === 0, 'no console errors (mute): ' + errors.join(' | '));
  await context.close();
}
{
  const { page, context } = await openSetup('install', { query: '?sound=0' });
  await started(page);
  const s = await page.evaluate(() => ({ muted: window.__veloxSetup.intro.muted, audible: window.__veloxSetup.intro.audible, label: document.querySelector('.vx-sound span').textContent }));
  ok(s.muted && !s.audible && s.label === 'Ton aus', 'settings.json startSound=false (?sound=0): the intro starts muted');
  await context.close();
}
{
  const { page, context } = await openSetup('install', { browser: strictBrowser });
  await started(page);
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => ({ blocked: window.__veloxSetup.intro.blocked, label: document.querySelector('.vx-sound span').textContent }));
  ok(s.blocked && s.label === 'Ton: klicken', 'without the autoplay flag the intro runs silent and offers "Ton: klicken"');
  await shot(page, 'intro-autoplay-blocked');
  await context.close();
}

// ================================================================== 3. options, install, progress (tick row), done
console.log('install flow');
{
  const { page, context, errors } = await openSetup('install');
  await skipIntro(page);
  await page.click('#btn-options');
  ok(await waitScreen(page, 'options'), 'Optionen opens the options screen');
  await quiet(page);
  ok((await page.textContent('#o-dir')) === 'C:\\Program Files\\VELOX', 'Options: default folder C:\\Program Files\\VELOX');
  ok((await page.textContent('#o-space')).includes('frei'), 'Options: free space shown');
  ok(await page.isChecked('#o-desktop') && await page.isChecked('#o-startmenu') && await page.isChecked('#o-launch'), 'Options: all switches on by default');
  await shot(page, 'options');
  await page.click('#btn-browse');
  ok((await lastSent(page, 'browse'))?.dir === 'C:\\Program Files\\VELOX', 'Ändern sends "browse" with the current folder');
  await emit(page, { type: 'folder', dir: 'D:\\Spiele\\VELOX', error: '', freeMB: 900000 });
  ok((await page.textContent('#o-dir')) === 'D:\\Spiele\\VELOX', 'folder reply updates the path');
  await emit(page, { type: 'folder', dir: 'D:\\Spiele\\VELOX', error: 'In diesen Ordner kann VELOX nicht installiert werden.', freeMB: -1 });
  ok(await page.isVisible('#o-dir-error'), 'folder error is shown');
  ok((await page.evaluate(() => getComputedStyle(document.getElementById('o-dir-error')).color)) === 'rgb(242, 90, 128)', 'folder error in "Riskant" rose, not orange');
  await shot(page, 'options-folder-error');
  await emit(page, { type: 'folder', dir: 'D:\\Spiele\\VELOX', error: '', freeMB: 900000 });
  ok(await page.isHidden('#o-dir-error'), 'a good folder clears the error');
  await page.click('label:has(#o-desktop)');
  ok(!(await page.isChecked('#o-desktop')), 'desktop switch toggles');
  await page.keyboard.press('Escape');
  ok(await waitScreen(page, 'welcome'), 'Esc goes back to Welcome');
  await page.click('#btn-options');
  await waitScreen(page, 'options');
  await page.click('#btn-install2');
  ok(await waitScreen(page, 'progress'), 'Installieren shows the progress screen');
  const inst = await lastSent(page, 'install');
  ok(inst && inst.dir === 'D:\\Spiele\\VELOX' && inst.desktop === false && inst.startMenu === true && inst.launch === true && inst.closeRunning === true, 'install message carries the options: ' + JSON.stringify(inst));
  ok(await page.isDisabled('#btn-close'), 'close button is locked while installing');
  await page.click('#btn-close', { force: true });
  ok(!(await lastSent(page, 'close')), 'no "close" while installing');
  const steps = [[1, 'Vorbereiten …', ''], [8, 'Dateien werden kopiert …', 'core/Engine.ps1'], [34, 'Dateien werden kopiert …', 'ui/js/pages/tweaks.js'], [61, 'Dateien werden kopiert …', 'data/tweaks/privacy.json']];
  for (const [p, s, f] of steps) { await emit(page, { type: 'progress', percent: p, step: s, file: f }); await page.waitForTimeout(160); }
  await page.waitForTimeout(700);
  ok((await page.textContent('#p-bar .vx-ticks-pct')) === '61 %', 'tick row readout follows the messages (61 %)');
  ok((await page.getAttribute('#p-bar .vx-ticks', 'aria-valuenow')) === '61', 'progressbar aria-valuenow 61');
  ok((await page.textContent('#p-bar .vx-ticks-status')) === 'Dateien werden kopiert', 'current step shown (without the trailing ellipsis)');
  ok((await page.textContent('#p-file')) === 'data/tweaks/privacy.json', 'current file shown in mono');
  const c61 = await tickColours(page, '#p-bar');
  ok(c61 && c61.signal > 0 && c61.bone > 0 && c61.line > 0, `tick row: done ticks bone, the current one orange, the rest hairline (${JSON.stringify(c61)})`);
  await shot(page, 'progress');
  ok((await layoutProblems(page)).length === 0, 'progress: layout fits ' + (await layoutProblems(page)).join('; '));
  await emit(page, { type: 'progress', percent: 94, step: 'VELOX wird bei Windows angemeldet …', file: '' });
  await emit(page, { type: 'progress', percent: 100, step: 'Fertig', file: '' });
  await emit(page, { type: 'done', mode: 'install', launched: false });
  await page.waitForTimeout(500);
  const cDone = await tickColours(page, '#p-bar');
  ok(cDone && cDone.signal === 0 && cDone.line === 0 && cDone.bone > 0, `at 100 % the row is all bone, no orange (${JSON.stringify(cDone)})`);
  await shot(page, 'progress-complete');
  ok(await waitScreen(page, 'done', 3000), 'done message leads to the Done screen');
  await quiet(page);
  await shot(page, 'done');
  ok((await page.textContent('#d-title')).includes('installiert'), 'Done: "Fertig. VELOX ist installiert."');
  ok((await page.textContent('#d-bar .vx-ticks-status')) === 'Installiert' && (await tickColours(page, '#d-bar')).signal === 0, 'Done: the finished tick row stays as a quiet trace (all bone)');
  ok(await page.isVisible('#btn-launch'), 'Done: "VELOX starten" button');
  ok(await page.evaluate(() => document.querySelectorAll('canvas.fx, .confetti, .aurora, .ring').length === 0), 'no confetti, rings or aurora anywhere');
  ok((await layoutProblems(page)).length === 0, 'done: layout fits ' + (await layoutProblems(page)).join('; '));
  await page.click('#btn-launch');
  ok(!!(await lastSent(page, 'launch')), '"VELOX starten" sends "launch"');
  ok((await oldLook(page)).length === 0, 'no old look on progress / done ' + (await oldLook(page)).join(' | '));
  ok(errors.length === 0, 'no console errors (install flow): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 4. error + retry, launched automatically
console.log('error');
{
  const { page, context, errors } = await openSetup('install');
  await skipIntro(page);
  await page.click('#btn-install');
  await waitScreen(page, 'progress');
  await emit(page, { type: 'progress', percent: 20, step: 'Dateien werden kopiert …', file: 'core/Server.ps1' });
  await page.waitForTimeout(500);
  await emit(page, { type: 'error', message: 'Eine Datei konnte nicht geschrieben werden.', hint: 'Schließe alle VELOX-Fenster und versuche es noch einmal.' });
  ok(await waitScreen(page, 'error'), 'error message shows the Error screen');
  await quiet(page);
  ok((await page.textContent('#e-msg')) === 'Eine Datei konnte nicht geschrieben werden.', 'Error: message from setup');
  ok((await page.textContent('#e-hint')).startsWith('Schließe'), 'Error: what to do');
  const ce = await tickColours(page, '#e-bar');
  ok(ce && ce.risk > 0 && ce.signal === 0, `Error: the tick row stops where it failed, its current tick rose (${JSON.stringify(ce)})`);
  ok((await page.textContent('#e-bar .vx-ticks-status')).includes('20 %'), 'Error: "Abgebrochen bei 20 %"');
  ok(!(await page.isDisabled('#btn-close')), 'close works again after an error');
  await shot(page, 'error');
  ok((await layoutProblems(page)).length === 0, 'error: layout fits ' + (await layoutProblems(page)).join('; '));
  await page.click('#btn-log');
  ok(!!(await lastSent(page, 'openLog')), '"Log öffnen" sends "openLog"');
  await page.click('#btn-retry');
  ok(await waitScreen(page, 'welcome'), '"Nochmal versuchen" goes back to Welcome');
  ok(!!(await lastSent(page, 'checkRunning')), 'retry re-checks for a running VELOX');
  await quiet(page);
  await page.click('#btn-install');
  await waitScreen(page, 'progress');
  ok((await page.textContent('#p-bar .vx-ticks-pct')) === '0 %', 'a new attempt starts at 0 %');
  await emit(page, { type: 'done', mode: 'install', launched: true });
  ok(await waitScreen(page, 'done', 3000), 'done after a fast install (no progress messages)');
  await quiet(page);
  ok(await page.isHidden('#btn-launch'), 'launched=true hides "VELOX starten"');
  ok((await page.textContent('#d-sub')).includes('startet'), 'Done says VELOX is starting');
  ok(await page.evaluate(() => document.getElementById('btn-done-close').classList.contains('primary')), '"Schließen" becomes the primary button');
  await page.click('#btn-done-close');
  ok(!!(await lastSent(page, 'exit')), '"Schließen" sends "exit"');
  ok(errors.length === 0, 'no console errors (error flow): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 5. update with a running VELOX
console.log('update');
{
  const { page, context, errors } = await openSetup('update');
  await skipIntro(page);
  ok((await page.textContent('#btn-install-label')) === 'Aktualisieren', 'Update: button says "Aktualisieren"');
  ok((await page.textContent('#w-title')).includes('neue Version'), 'Update: "Eine neue Version von VELOX ist da."');
  ok(await page.isVisible('#update-note') && (await page.textContent('#u-from')) === '1.1.1' && (await page.textContent('#u-to')) === '1.2.0', 'Update: Version 1.1.1 → 1.2.0 in the readout');
  ok(await page.isVisible('#running-note'), 'Update: running VELOX is mentioned');
  await shot(page, 'update');
  ok((await layoutProblems(page)).length === 0, 'update: layout fits ' + (await layoutProblems(page)).join('; '));
  await page.click('#btn-options'); await waitScreen(page, 'options');
  ok(await page.isDisabled('#btn-browse'), 'Update: folder cannot be changed');
  await page.keyboard.press('Escape'); await waitScreen(page, 'welcome'); await quiet(page);
  await page.click('#btn-install');
  ok(await page.isVisible('#confirm'), 'asks before closing the running VELOX');
  await page.waitForTimeout(400);
  await shot(page, 'update-confirm');
  await page.keyboard.press('Escape');
  ok(await page.isHidden('#confirm') && !(await lastSent(page, 'install')), 'Esc cancels: nothing is installed');
  await page.click('#btn-install');
  await page.click('#c-ok');
  ok(await waitScreen(page, 'progress'), 'confirm starts the update');
  ok((await page.textContent('#p-title')).includes('aktualisiert'), 'progress title: "wird aktualisiert"');
  ok((await lastSent(page, 'install'))?.closeRunning === true, 'install with closeRunning=true');
  await emit(page, { type: 'progress', percent: 3, step: 'VELOX wird geschlossen …', file: '' });
  await emit(page, { type: 'done', mode: 'install', launched: false });
  ok(await waitScreen(page, 'done', 3000), 'update done');
  await quiet(page);
  ok((await page.textContent('#d-title')).includes('neuesten Stand'), 'Done: "auf dem neuesten Stand"');
  ok((await page.textContent('#d-bar .vx-ticks-status')) === 'Aktualisiert', 'Done trace: "Aktualisiert"');
  ok(errors.length === 0, 'no console errors (update): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 6. uninstall
console.log('uninstall');
{
  const { page, context, errors } = await openSetup('uninstall');
  await started(page);
  ok((await page.evaluate(() => window.__veloxSetup.intro.variant)) === 'short', 'uninstalling plays the short intro');
  await skipIntro(page);
  ok(await waitScreen(page, 'uninstall'), '/uninstall opens the uninstall screen');
  ok(await page.isChecked('#u-keep'), '"Einstellungen und Sicherungen behalten" is on by default');
  ok((await page.textContent('.callout')).includes('Sicherungen'), 'explains that tweaks stay active and where to undo them');
  ok((await page.textContent('#u-sub')).includes('C:\\Program Files\\VELOX'), 'shows the folder being removed');
  ok((await page.textContent('#tb-title')) === 'VELOX entfernen', 'title bar: "VELOX entfernen"');
  await shot(page, 'uninstall');
  ok((await layoutProblems(page)).length === 0, 'uninstall: layout fits ' + (await layoutProblems(page)).join('; '));
  await page.click('label:has(#u-keep)');
  await page.click('#btn-uninstall');
  ok(await waitScreen(page, 'progress'), 'Entfernen shows progress');
  const u = await lastSent(page, 'uninstall');
  ok(u && u.keepData === false && u.closeRunning === true, 'uninstall message: ' + JSON.stringify(u));
  ok((await page.textContent('#p-title')).includes('entfernt'), 'progress title: "wird entfernt"');
  for (const p of [12, 40, 85]) { await emit(page, { type: 'progress', percent: p, step: 'Dateien werden entfernt …', file: 'ui/index.html' }); await page.waitForTimeout(150); }
  await page.waitForTimeout(500);
  await shot(page, 'uninstall-progress');
  await emit(page, { type: 'done', mode: 'uninstall', launched: false });
  ok(await waitScreen(page, 'done', 3000), 'uninstall done');
  await quiet(page);
  ok((await page.textContent('#d-title')).includes('entfernt'), 'Done: "VELOX wurde entfernt."');
  ok(await page.isHidden('#btn-launch') && await page.isHidden('#d-hint'), 'no "VELOX starten" after uninstalling');
  await shot(page, 'uninstall-done');
  await page.click('#btn-done-close');
  ok(!!(await lastSent(page, 'exit')), 'close after uninstall sends "exit"');
  ok(errors.length === 0, 'no console errors (uninstall): ' + errors.join(' | '));
  await context.close();
}
{
  const { page, context } = await openSetup('uninstall');
  await skipIntro(page);
  await page.click('#btn-u-cancel');
  ok(!!(await lastSent(page, 'close')), 'Abbrechen on the uninstall screen closes the setup');
  await context.close();
}

// ================================================================== 7. reduced motion
console.log('reduced motion');
{
  const { page, context, errors } = await openSetup('install', { reduced: true });
  await started(page);
  ok((await page.evaluate(() => window.__veloxSetup.intro.variant)) === 'reduced', 'prefers-reduced-motion: the calm variant (fade, no strike)');
  await page.waitForTimeout(300);
  await shot(page, 'reduced-intro');
  ok(await waitSettled(page, 1200), 'calm intro settles within 0.8 s');
  await quiet(page);
  const anims = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && /arrive/.test(a.animationName || '')).length);
  ok(anims === 0, 'no slide-in animations with reduced motion');
  await page.click('#btn-install');
  await waitScreen(page, 'progress');
  await emit(page, { type: 'progress', percent: 50, step: 'Dateien werden kopiert …', file: 'x' });
  await page.waitForTimeout(120);
  ok((await tickColours(page, '#p-bar')).signal > 0 && (await page.textContent('#p-bar .vx-ticks-pct')) === '50 %', 'progress jumps without easing');
  await emit(page, { type: 'done', mode: 'install', launched: false });
  ok(await waitScreen(page, 'done', 600), 'done at once (reduced)');
  await page.waitForTimeout(300);
  await shot(page, 'reduced-done');
  ok(errors.length === 0, 'no console errors (reduced motion): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 8. every screen at 100 % / 150 % / small work area
console.log('layout');
const LONG_DIR = 'C:\\Users\\Ein-sehr-langer-Benutzername\\AppData\\Local\\Programs\\Noch ein Unterordner\\VELOX';
const LONG_ERR = { type: 'error', message: 'Für VELOX ist auf Laufwerk C: nicht genug Platz frei. Es werden etwa 3 MB gebraucht.', hint: 'Mach etwas Platz frei (zum Beispiel den Papierkorb leeren) oder wähle unter „Optionen“ einen anderen Ort. Dann versuche es noch einmal.' };
for (const cfg of [{ scale: 1, width: 880, height: 560, tag: '100' }, { scale: 1.5, width: 880, height: 560, tag: '150' }, { scale: 1.25, width: 760, height: 470, tag: 'small' }]) {
  const check = async (page, what, file) => {
    const probs = await layoutProblems(page);
    ok(probs.length === 0, `${cfg.tag}% ${what}: fits ${probs.join('; ')}`);
    if (file) await shot(page, `${file}-${cfg.tag}`);
  };
  for (const sc of ['install', 'update', 'uninstall']) {
    const { page, context, errors } = await openSetup(sc, cfg);
    await skipIntro(page);
    const home = sc === 'uninstall' ? 'uninstall' : 'welcome';
    await waitScreen(page, home);
    await check(page, `${sc}/${home}`, `${sc}`);
    if (sc === 'install') {
      await page.click('#btn-options'); await waitScreen(page, 'options'); await quiet(page);
      await check(page, 'options');
      await emit(page, { type: 'folder', dir: LONG_DIR, error: '', freeMB: 1234 });
      await check(page, 'options with a very long path', 'options');
      await page.click('#btn-install2'); await waitScreen(page, 'progress');
      await emit(page, { type: 'progress', percent: 40, step: 'Dateien werden kopiert …', file: 'data/tweaks/ein/sehr/langer/pfad/zu/einer/datei/die/nicht/passt/privacy-and-telemetry.json' });
      await page.waitForTimeout(700);
      await check(page, 'progress', 'progress');
      await emit(page, { type: 'error', ...LONG_ERR });
      await waitScreen(page, 'error'); await quiet(page);
      await check(page, 'error with long text (after progress)', 'error');
      await page.click('#btn-retry'); await waitScreen(page, 'welcome'); await quiet(page);
      await page.click('#btn-install'); await waitScreen(page, 'progress');
      await emit(page, { type: 'done', mode: 'install', launched: false });
      await waitScreen(page, 'done', 3000); await quiet(page);
      await check(page, 'done', 'done');
    } else if (sc === 'update') {
      await page.click('#btn-install'); await page.waitForTimeout(400);
      const dlg = await page.evaluate(() => { const r = document.querySelector('.dialog').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
      ok(dlg, `${cfg.tag}% update confirm dialog inside the window`);
      if (cfg.tag !== '100') await shot(page, `update-confirm-${cfg.tag}`);
    } else {
      await page.click('#btn-uninstall'); await waitScreen(page, 'progress');
      await emit(page, { type: 'progress', percent: 70, step: 'Dateien werden entfernt …', file: 'ui/index.html' });
      await page.waitForTimeout(600);
      await check(page, 'uninstall progress');
      await emit(page, { type: 'done', mode: 'uninstall', launched: false });
      await waitScreen(page, 'done', 3000); await quiet(page);
      await check(page, 'uninstall done', 'uninstall-done');
    }
    ok(errors.length === 0, `${cfg.tag}% ${sc}: no console errors ${errors.join(' | ')}`);
    await context.close();
  }
}

// ================================================================== 9. VELOX.exe start screen (native/host/start)
console.log('VELOX.exe start screen');
{
  const { page, context, errors } = await openSplash('v=1.2.0&variant=full&sound=1&test=0');
  await started(page, 'window.__intro');
  ok((await sent(page)).some(m => m.type === 'splash-ready'), 'start screen announces "splash-ready"');
  const s = await page.evaluate(() => ({ v: window.__intro.variant, a: window.__intro.audible, label: document.querySelector('.vx-label-r').textContent }));
  ok(s.v === 'full' && s.a, `variant=full from the URL, sound plays without a click (audible=${s.a})`);
  ok(s.label === 'Version 1.2.0', 'version label: "Version 1.2.0"');
  ok(await page.isHidden('#mode'), 'no Testmodus label in the real mode');
  const beats = [150, 300, 450, 900, 940, 1050, 1400, 1800];
  for (let i = 0; i < beats.length; i++) {
    await page.waitForFunction(ms => performance.now() - window.__intro.startedAt >= ms, beats[i], { timeout: 5000, polling: 'raf' });
    const t = await page.evaluate(() => Math.round(performance.now() - window.__intro.startedAt));
    await shot(page, `host-intro-${String(i + 1).padStart(2, '0')}-${String(t).padStart(4, '0')}ms`);
  }
  await emit(page, { type: 'status', text: 'Tweaks werden eingelesen …' });
  ok((await page.textContent('.vx-status')) === 'Tweaks werden eingelesen …', 'VELOX_STATUS text goes to intro.status()');
  await shot(page, 'host-splash');
  // M during the start screen: the host forwards it to the app (&sound=off)
  await page.keyboard.press('m');
  ok((await lastSent(page, 'sound'))?.on === false, 'M on the start screen: sound{on:false} to the host');
  await page.keyboard.press('m');
  ok((await lastSent(page, 'sound'))?.on === true, 'M again: sound{on:true}');
  // hand-over
  const tReady = await page.evaluate(() => performance.now());
  await emit(page, { type: 'ready' });
  await page.waitForFunction(() => window.__sent.some(m => m.type === 'continue'), null, { timeout: 3000 }).catch(() => {});
  const ho = await page.evaluate(() => ({ h: window.__sent.find(m => m.type === 'handover'), c: window.__sent.find(m => m.type === 'continue') }));
  ok(ho.h && ho.h.ms >= 400 && ho.h.ms <= 460, `"ready" is answered with handover{ms} (${ho.h && ho.h.ms} ms after the settle)`);
  ok(ho.c && ho.c.at - tReady >= 400 && ho.c.at - tReady < 700, `"continue" when intro.done() resolves (${ho.c ? Math.round(ho.c.at - tReady) : '-'} ms after ready)`);
  ok(!(await page.evaluate(() => window.__intro.keysActive)), 'the hand-over releases the keyboard');
  await shot(page, 'host-handover-end');
  ok((await oldLook(page)).length === 0, 'start screen: no old look ' + (await oldLook(page)).join(' | '));
  ok((await cspViolations(page)).length === 0, 'start screen: no CSP violations ' + (await cspViolations(page)).join(' | '));
  ok(errors.length === 0, 'start screen: no console errors ' + errors.join(' | '));
  await context.close();
}
{
  // ready arrives while the full intro still runs: done() waits for the settle, the host gets the rest announced
  const { page, context } = await openSplash('v=1.2.0&variant=full&sound=1&test=0');
  await started(page, 'window.__intro');
  await page.waitForTimeout(300);
  await emit(page, { type: 'ready' });
  await page.waitForFunction(() => window.__sent.some(m => m.type === 'continue'), null, { timeout: 4000 }).catch(() => {});
  const r = await page.evaluate(() => ({ h: window.__sent.find(m => m.type === 'handover'), c: window.__sent.find(m => m.type === 'continue'), s: window.__intro.startedAt }));
  ok(r.h && r.h.ms > 1500 && r.h.ms < 1800, `early ready: the page announces the rest of the intro + hand-over (${r.h && r.h.ms} ms; host cap = min(ms + 250, 2300))`);
  ok(r.c && r.c.at - r.s >= 1600 + 400 && r.c.at - r.s < 1600 + 430 + 400, `early ready: "continue" after settle + hand-over (${r.c ? Math.round(r.c.at - r.s) : '-'} ms after the start), never a struck-through word`);
  await context.close();
}
{
  const { page, context, errors } = await openSplash('v=1.2.0&variant=short&sound=0&test=1');
  await started(page, 'window.__intro');
  const s = await page.evaluate(() => ({ v: window.__intro.variant, m: window.__intro.muted, a: window.__intro.audible, label: document.querySelector('.vx-sound span').textContent }));
  ok(s.v === 'short', 'variant=short (every start after the first)');
  ok(s.m && !s.a && s.label === 'Ton aus', 'settings.json startSound=false (?sound=0): starts muted, "Ton aus"');
  ok(await page.isVisible('#mode') && (await page.textContent('#mode')) === 'Testmodus', 'Testmodus label (top left, on the word\'s margin)');
  await emit(page, { type: 'mode', test: false });
  ok(await page.isHidden('#mode'), 'mode{test:false} hides it');
  await emit(page, { type: 'mode', test: true });
  ok(await waitSettled(page, 1500), 'short intro settles (0.76 s)');
  ok(errors.length === 0, 'short start screen: no console errors ' + errors.join(' | '));
  await context.close();
}
for (const cfg of [{ width: 1360, height: 880, scale: 1, tag: '1360' }, { width: 1360, height: 880, scale: 1.5, tag: '1360-150' }, { width: 900, height: 600, scale: 1, tag: 'min' }, { width: 900, height: 600, scale: 1.5, tag: 'min-150' }]) {
  const { page, context, errors } = await openSplash('v=1.2.0&variant=full&sound=1&test=0', cfg);
  await started(page, 'window.__intro');
  await page.waitForTimeout(300);
  await emit(page, { type: 'error', title: 'VELOX startet nicht', message: 'Der VELOX-Motor hat sich nach 45 Sekunden noch nicht gemeldet. Oft hilft ein zweiter Versuch oder ein Neustart des PCs. Wenn nicht, schau ins Log.', log: Array.from({ length: 40 }, (_, i) => 'Zeile ' + i + ' der Ausgabe von PowerShell').join('\n'), canTest: true });
  ok(await waitSettled(page, 400), `error (${cfg.tag}): the intro skips to the settled word at once`);
  await page.waitForTimeout(600);
  ok(await page.isVisible('#b-retry') && await page.isVisible('#b-test') && await page.isVisible('#b-log'), `error (${cfg.tag}): "Erneut versuchen", "Testmodus", "Log öffnen"`);
  ok(await page.evaluate(() => document.getElementById('error').parentElement.classList.contains('vx-slot')), `error (${cfg.tag}): the panel sits in the intro's slot, under the word`);
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.vx-load')).visibility === 'hidden'), `error (${cfg.tag}): the loader steps aside`);
  const probs = await layoutProblems(page, '#error');
  ok(probs.length === 0, `error (${cfg.tag}): fits the window ${probs.join('; ')}`);
  ok(await page.evaluate(() => { const l = document.getElementById('err-log'); return l.scrollTop > 0 && l.scrollTop + l.clientHeight >= l.scrollHeight - 2; }), `error (${cfg.tag}): the log is scrolled to its end`);
  await shot(page, `host-splash-error-${cfg.tag}`);
  if (cfg.tag === '1360') {
    await page.click('#b-retry'); await page.click('#b-test'); await page.click('#b-log');
    const types = (await sent(page)).map(m => m.type);
    ok(types.includes('retry') && types.includes('test') && types.includes('openlog'), 'error buttons send retry / test / openlog');
    await emit(page, { type: 'error', title: 'x', message: 'y', log: '', canTest: false });
    ok(await page.isHidden('#b-test'), 'no Testmodus button when already in the Testmodus');
    await emit(page, { type: 'starting', text: 'VELOX wird neu gestartet …' });
    await page.waitForTimeout(100);
    ok((await page.textContent('.vx-status')) === 'VELOX wird neu gestartet …' && await page.isHidden('#error') && await page.evaluate(() => getComputedStyle(document.querySelector('.vx-load')).visibility === 'visible'), 'starting{text}: error gone, loader and status back');
    ok((await oldLook(page)).length === 0, 'error screen: no old look ' + (await oldLook(page)).join(' | '));
  }
  ok(errors.length === 0, `error (${cfg.tag}): no console errors ${errors.join(' | ')}`);
  await context.close();
}
{
  // a later load of the start screen (backend died after the app was shown): the still end pose, no sound, no keys
  const { page, context, errors } = await openSplash('v=1.2.0&variant=still&sound=1&test=0');
  await started(page, 'window.__intro');
  const s = await page.evaluate(() => ({ v: window.__intro.variant, keys: window.__intro.keysActive, soundHidden: document.querySelector('.vx-sound').hidden, skipHidden: document.querySelector('.vx-skip').hidden }));
  ok(s.v === 'still' && !s.keys && s.soundHidden && s.skipHidden, 'variant=still: no intro, no sound button, no skip, no key listener');
  await emit(page, { type: 'error', title: 'VELOX wurde unerwartet beendet', message: 'Der VELOX-Motor im Hintergrund läuft nicht mehr (Code 1). Deine Änderungen sind gesichert – starte ihn einfach neu.', log: 'Zeile 1\nZeile 2', canTest: true });
  await page.waitForTimeout(600);
  await shot(page, 'host-splash-error-still');
  ok(errors.length === 0, 'still start screen: no console errors ' + errors.join(' | '));
  await context.close();
}
{
  const { page, context, errors } = await openSplash('v=1.2.0&variant=full&sound=1&test=0', { reduced: true });
  await started(page, 'window.__intro');
  ok((await page.evaluate(() => window.__intro.variant)) === 'reduced', 'start screen with reduced motion: the calm variant');
  ok(await waitSettled(page, 1200), 'calm start screen settles within 0.8 s');
  await page.waitForTimeout(200);
  await shot(page, 'host-splash-reduced');
  ok(errors.length === 0, 'reduced start screen: no console errors ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 10. frame rate of the intro (informational + sanity)
console.log('performance');
{
  const { page, context } = await openSetup('install');
  await started(page);
  const stats = await page.evaluate(() => new Promise(resolve => {
    const t = []; const start = performance.now();
    function f(now) { t.push(now); if (now - start < 1800) requestAnimationFrame(f); else resolve(t); }
    requestAnimationFrame(f);
  }));
  const gaps = stats.slice(1).map((x, i) => x - stats[i]).sort((a, b) => a - b);
  const p95 = gaps[Math.floor(gaps.length * 0.95)];
  const fps = Math.round(1000 * (stats.length - 1) / (stats[stats.length - 1] - stats[0]));
  console.log(`  info  installer intro: ${fps} fps average, p95 frame ${p95.toFixed(1)} ms (headless software rendering)`);
  ok(fps >= 30, `installer intro keeps a smooth frame rate in headless Chromium (${fps} fps)`);
  await context.close();
}

await autoplayBrowser.close();
await strictBrowser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
