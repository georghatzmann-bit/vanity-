// VELOX installer UI tests: drives native/setup-ui in Chromium with a mocked window.chrome.webview bridge
// (the same message protocol VeloxSetup.exe speaks, docs/ARCHITECTURE.md "Native host & installer").
//
//   node velox-tweaker/tests/native/run-setup-ui-tests.mjs [--headed]
//
// Screenshots (and a few frames of the intro animation) land in tests/native/screenshots/.
// Uses the globally installed Playwright with its preinstalled Chromium (never runs "playwright install").
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '../../native/setup-ui');
const SHOTS = path.join(HERE, 'screenshots');
const HEADED = process.argv.includes('--headed');

function loadPlaywright() {
  const tries = [() => createRequire(import.meta.url)('playwright'), () => createRequire('/opt/node22/lib/node_modules/')('playwright')];
  tries.push(() => createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'));
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  throw new Error('playwright not found');
}
const { chromium } = loadPlaywright();

// ------------------------------------------------------------------ tiny static server (like the virtual host)
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  // /host-splash.html = VELOX.exe's embedded start screen (native/host/splash.html)
  const file = rel === 'host-splash.html' ? path.resolve(UI, '../host/splash.html') : path.join(UI, rel);
  if ((rel !== 'host-splash.html' && !file.startsWith(UI)) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;

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
  install: { type: 'init', version: '1.1.0', mode: 'install', installedVersion: '', dir: 'C:\\Program Files\\VELOX', defaultDir: 'C:\\Program Files\\VELOX', sizeMB: 3, freeMB: 182345, running: false },
  update: { type: 'init', version: '1.1.0', mode: 'update', installedVersion: '1.0.0', dir: 'C:\\Program Files\\VELOX', defaultDir: 'C:\\Program Files\\VELOX', sizeMB: 3, freeMB: 182345, running: true },
  uninstall: { type: 'init', version: '1.1.0', mode: 'uninstall', installedVersion: '1.1.0', dir: 'C:\\Program Files\\VELOX', defaultDir: 'C:\\Program Files\\VELOX', sizeMB: 3, freeMB: 182345, running: false }
};

// The mock bridge: records page -> setup messages, answers "ready" with the scenario's init message.
function bridgeScript(init) {
  return `(() => {
    const listeners = [];
    window.__sent = [];
    window.__emit = (data) => listeners.forEach(fn => fn({ data }));
    window.chrome = window.chrome || {};
    window.chrome.webview = {
      postMessage(m) {
        window.__sent.push(JSON.parse(JSON.stringify(m)));
        if (m && m.type === 'ready') setTimeout(() => window.__emit(${JSON.stringify(init)}), 20);
      },
      addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
      removeEventListener() {}
    };
  })();`;
}

const browser = await chromium.launch({ headless: !HEADED });

async function open(scenario, { scale = 1, reduced = false, width = 880, height = 560 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: reduced ? 'reduce' : 'no-preference', locale: 'de-DE' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
  await page.addInitScript(bridgeScript(INIT[scenario]));
  await page.goto(BASE);
  return { page, context, errors };
}
const sent = (page) => page.evaluate(() => window.__sent);
const lastSent = async (page, type) => (await sent(page)).filter(m => m.type === type).pop();
const screen = (page) => page.evaluate(() => document.body.getAttribute('data-screen'));
const emit = (page, msg) => page.evaluate(m => window.__emit(m), msg);
async function shot(page, name) {
  if (!name.startsWith('intro-')) { await page.mouse.move(440, 300); await page.waitForTimeout(250); }   // no stray hover / tilt
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
async function waitScreen(page, name, timeout = 5000) {
  try { await page.waitForFunction(n => document.body.getAttribute('data-screen') === n && document.querySelector('.screen.active')?.getAttribute('data-screen') === n, name, { timeout }); return true; }
  catch { return false; }
}
async function settle(page, ms = 900) { await page.waitForTimeout(ms); }
async function skip(page) {
  await page.waitForTimeout(250);
  await page.mouse.click(440, 300);
}

/** Every visible element of the active screen lies inside the window and nothing scrolls. */
async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const W = innerWidth, H = innerHeight;
    const de = document.documentElement;
    if (de.scrollWidth > W || de.scrollHeight > H) out.push(`document scrolls ${de.scrollWidth}x${de.scrollHeight}`);
    const scr = document.querySelector('.screen.active');
    if (!scr) return ['no active screen'];
    if (scr.scrollHeight > scr.clientHeight + 1 || scr.scrollWidth > scr.clientWidth + 1) out.push(`screen overflows ${scr.scrollWidth}x${scr.scrollHeight} > ${scr.clientWidth}x${scr.clientHeight}`);
    for (const el of scr.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -0.5 || r.top < 39.5 || r.right > W + 0.5 || r.bottom > H + 0.5) out.push(`${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].join('.')} at ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
      // clipped text (ellipsis elements are allowed to cut)
      if (el.children.length === 0 && el.textContent.trim() && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.overflow !== 'visible')
        out.push(`text clipped in ${el.tagName.toLowerCase()}#${el.id}`);
    }
    // content blocks of the screen must not overlap each other
    const blocks = [...scr.querySelectorAll('.in, .meta')].filter(el => !el.parentElement.closest('.in') && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]') && el.getBoundingClientRect().height > 0);
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i].getBoundingClientRect(), b = blocks[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) out.push(`overlap: ${blocks[i].id || blocks[i].className} / ${blocks[j].id || blocks[j].className}`);
    }
    // the shared hero must sit inside the window too
    for (const id of ['hero', 'word']) {
      const el = document.getElementById(id);
      if (getComputedStyle(el).opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.top < 39.5 || r.right > W + 0.5 || r.bottom > H + 0.5) out.push(`${id} outside: ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
    }
    return out;
  });
}

/** Wait until the hero glide (760 ms) and the content entrance are over. */
async function quiet(page) { await page.waitForTimeout(1100); }

// ================================================================== 1. intro plays by itself and ends on Welcome
console.log('intro');
{
  const { page, context, errors } = await open('install');
  const frames = [120, 520, 880, 1180, 1430, 1600, 1800, 2050, 2350];
  const t0 = Date.now();
  for (let i = 0; i < frames.length; i++) {
    const wait = frames[i] - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    await shot(page, `intro-${String(i + 1).padStart(2, '0')}-${frames[i]}ms`);
  }
  ok((await sent(page)).some(m => m.type === 'ready'), 'page announces itself with "ready"');
  ok(await page.evaluate(() => document.getElementById('hero-rays').getAnimations().length > 0 && document.getElementById('hero-shock2').getAnimations().length > 0),
    'ignition: god rays and a second shock ring flare up');
  ok(await page.evaluate(() => document.getAnimations().length > 0 || window.__veloxSetup.intro.done), 'intro runs Web Animations');
  ok(await waitScreen(page, 'welcome', 4000), 'intro ends on its own and shows Welcome (< 4.5 s)');
  const introMs = Date.now() - t0;
  ok(introMs < 4600, `intro length ${introMs} ms`);
  await quiet(page);
  await shot(page, 'welcome-install');
  ok(await page.textContent('#btn-install-label') === 'Installieren', 'Welcome: big "Installieren" button');
  ok((await page.textContent('#w-meta')).includes('1.1.0'), 'Welcome: version from init shown');
  ok((await page.textContent('#tb-ver')) === 'v1.1.0', 'title bar shows the version');
  ok(await page.isVisible('#btn-options'), 'Welcome: "Optionen" link');
  ok(await page.isHidden('#update-note'), 'Welcome: no update note on a fresh install');
  ok(await page.evaluate(() => window.__veloxSetup.intro.anims.every(a => a.playState === 'finished' || a.playState === 'idle')), 'intro animations finished');
  // the logo really is drawn (not left at opacity 0 or scale 0 by the intro)
  const heroOk = await page.evaluate(() => {
    const h = document.getElementById('hero').getBoundingClientRect();
    const caps = [...document.querySelectorAll('.cap')].map(c => c.getBoundingClientRect().height);
    return getComputedStyle(document.getElementById('hero')).opacity === '1' && h.width > 100 && caps.every(x => x > 3);
  });
  ok(heroOk, 'logo is fully visible after the intro');

  // title bar
  await page.mouse.down({ button: 'left' }); await page.mouse.up();   // somewhere in the stage: nothing
  await page.mouse.move(300, 20); await page.mouse.down(); await page.mouse.up();
  ok(!!(await lastSent(page, 'drag')), 'title bar sends "drag"');
  await page.click('#btn-min');
  ok(!!(await lastSent(page, 'minimize')), 'minimize button sends "minimize"');
  ok(errors.length === 0, 'no console errors (intro + welcome): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 2. skip, options, install, progress, done
console.log('install flow');
{
  const { page, context, errors } = await open('install');
  const t0 = Date.now();
  await skip(page);
  ok(await waitScreen(page, 'welcome', 1500), 'click skips the intro');
  ok(Date.now() - t0 < 1500, 'skip reacts at once');
  ok(await page.evaluate(() => window.__veloxSetup.intro.anims.length === 0), 'skip cancels the intro animations');
  await quiet(page);

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
  let cometSeen = false;
  for (const [p, s, f] of steps) {
    await emit(page, { type: 'progress', percent: p, step: s, file: f });
    await page.waitForTimeout(120);
    if (p >= 34) cometSeen = cometSeen || await page.evaluate(() => window.__veloxSetup.fxParts() > 0);
    await page.waitForTimeout(100);
  }
  ok(cometSeen, 'progress: sparks peel off the head of the ring while it moves');
  await page.waitForTimeout(700);
  const pct = +(await page.textContent('#pct-num'));
  ok(pct > 30 && pct <= 61, `percent follows the messages smoothly (${pct}%)`);
  ok((await page.textContent('#p-file')) === 'data/tweaks/privacy.json', 'current file shown');
  ok((await page.textContent('#p-step')) === 'Dateien werden kopiert …', 'current step shown');
  const eqMoves = await page.evaluate(async () => {
    const y0 = document.getElementById('cap1').getAttribute('y');
    await new Promise(r => setTimeout(r, 300));
    return y0 !== document.getElementById('cap1').getAttribute('y');
  });
  ok(eqMoves, 'logo faders move like an equalizer while installing');
  ok(await page.evaluate(() => document.getElementById('v-main').getAttribute('d') !== 'M11 13 24 35 37 13'), 'the V follows the faders');
  await shot(page, 'progress');
  ok((await layoutProblems(page)).length === 0, 'progress: layout fits ' + (await layoutProblems(page)).join('; '));

  await emit(page, { type: 'progress', percent: 94, step: 'VELOX wird bei Windows angemeldet …', file: '' });
  await emit(page, { type: 'progress', percent: 100, step: 'Fertig', file: '' });
  await emit(page, { type: 'done', mode: 'install', launched: false });
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => document.getElementById('ring-glow').getAnimations().length > 0), 'ring flashes when it completes');
  ok(await waitScreen(page, 'done', 4000), 'done message leads to the Done screen');
  ok((await page.textContent('#pct-num')) === '100', 'ring ends at 100%');
  await page.waitForTimeout(800);
  const confettiDrawn = await page.evaluate(() => {
    const c = document.getElementById('fx'), g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++;
    return n;
  });
  ok(confettiDrawn > 200, `celebration burst is drawn (${confettiDrawn} px)`);
  await shot(page, 'done-celebration');
  await page.waitForTimeout(2600);
  ok(await page.evaluate(() => document.getElementById('cap1').getAttribute('y') === '9.50'), 'faders settle back into the V');
  await shot(page, 'done');
  ok((await page.textContent('#d-title')).includes('installiert'), 'Done: "Fertig! VELOX ist installiert."');
  ok(await page.isVisible('#btn-launch'), 'Done: "VELOX starten" button');
  await page.click('#btn-launch');
  ok(!!(await lastSent(page, 'launch')), '"VELOX starten" sends "launch"');
  ok(errors.length === 0, 'no console errors (install flow): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 3. launched automatically + error + retry
console.log('error');
{
  const { page, context, errors } = await open('install');
  await skip(page); await waitScreen(page, 'welcome'); await quiet(page);
  await page.click('#btn-install');
  await waitScreen(page, 'progress');
  await emit(page, { type: 'progress', percent: 20, step: 'Dateien werden kopiert …', file: 'core/Server.ps1' });
  await page.waitForTimeout(300);
  await emit(page, { type: 'error', message: 'Eine Datei konnte nicht geschrieben werden.', hint: 'Schließe alle VELOX-Fenster und versuche es noch einmal.' });
  ok(await waitScreen(page, 'error'), 'error message shows the Error screen');
  await quiet(page);
  ok((await page.textContent('#e-msg')) === 'Eine Datei konnte nicht geschrieben werden.', 'Error: message from setup');
  ok((await page.textContent('#e-hint')).startsWith('Schließe'), 'Error: what to do');
  ok(!(await page.isDisabled('#btn-close')), 'close works again after an error');
  await shot(page, 'error');
  ok((await layoutProblems(page)).length === 0, 'error: layout fits');
  await page.click('#btn-log');
  ok(!!(await lastSent(page, 'openLog')), '"Log öffnen" sends "openLog"');
  await page.click('#btn-retry');
  ok(await waitScreen(page, 'welcome'), '"Nochmal versuchen" goes back to Welcome');
  ok(!!(await lastSent(page, 'checkRunning')), 'retry re-checks for a running VELOX');
  await quiet(page);
  await page.click('#btn-install');
  await waitScreen(page, 'progress');
  ok((await page.textContent('#pct-num')) === '0', 'a new attempt starts at 0%');
  await emit(page, { type: 'done', mode: 'install', launched: true });
  ok(await waitScreen(page, 'done', 4000), 'done after a fast install (no progress messages)');
  await quiet(page);
  ok(await page.isHidden('#btn-launch'), 'launched=true hides "VELOX starten"');
  ok((await page.textContent('#d-sub')).includes('startet'), 'Done says VELOX is starting');
  await page.click('#btn-done-close');
  ok(!!(await lastSent(page, 'exit')), '"Schließen" sends "exit"');
  ok(errors.length === 0, 'no console errors (error flow): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 4. update with a running VELOX
console.log('update');
{
  const { page, context, errors } = await open('update');
  await skip(page); await waitScreen(page, 'welcome'); await quiet(page);
  ok((await page.textContent('#btn-install-label')) === 'Aktualisieren', 'Update: button says "Aktualisieren"');
  ok(await page.isVisible('#update-note') && (await page.textContent('#u-from')) === '1.0.0' && (await page.textContent('#u-to')) === '1.1.0', 'Update: 1.0.0 -> 1.1.0 shown');
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
  ok(await page.isHidden('#confirm') && (await screen(page)) === 'welcome' && !(await lastSent(page, 'install')), 'Esc cancels: nothing is installed');
  await page.click('#btn-install');
  await page.click('#c-ok');
  ok(await waitScreen(page, 'progress'), 'confirm starts the update');
  ok((await page.textContent('#p-title')).includes('aktualisiert'), 'progress title: "wird aktualisiert"');
  ok((await lastSent(page, 'install'))?.closeRunning === true, 'install with closeRunning=true');
  await emit(page, { type: 'progress', percent: 3, step: 'VELOX wird geschlossen …', file: '' });
  await emit(page, { type: 'done', mode: 'install', launched: false });
  ok(await waitScreen(page, 'done', 4000), 'update done');
  await quiet(page);
  ok((await page.textContent('#d-title')).includes('neuesten Stand'), 'Done: "auf dem neuesten Stand"');
  ok(errors.length === 0, 'no console errors (update): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 5. uninstall
console.log('uninstall');
{
  const { page, context, errors } = await open('uninstall');
  await skip(page);
  ok(await waitScreen(page, 'uninstall'), '/uninstall opens the uninstall screen');
  await quiet(page);
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
  await shot(page, 'uninstall-progress');
  await emit(page, { type: 'done', mode: 'uninstall', launched: false });
  ok(await waitScreen(page, 'done', 4000), 'uninstall done');
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
  const { page, context } = await open('uninstall');
  await skip(page); await waitScreen(page, 'uninstall'); await quiet(page);
  await page.click('#btn-u-cancel');
  ok(!!(await lastSent(page, 'close')), 'Abbrechen on the uninstall screen closes the setup');
  await context.close();
}

// ================================================================== 6. reduced motion
console.log('reduced motion');
{
  const { page, context, errors } = await open('install', { reduced: true });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.body.classList.contains('reduced')), 'prefers-reduced-motion is honoured');
  await shot(page, 'reduced-intro');
  ok(await waitScreen(page, 'welcome', 2500), 'calm intro ends quickly');
  const parts = await page.evaluate(() => {
    const c = document.getElementById('fx'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++; return n;
  });
  ok(parts === 0, 'no particles with reduced motion');
  await page.waitForTimeout(400);
  await page.click('#btn-install');
  await waitScreen(page, 'progress');
  await emit(page, { type: 'progress', percent: 50, step: 'Dateien werden kopiert …', file: 'x' });
  await page.waitForTimeout(200);
  ok((await page.textContent('#pct-num')) === '50', 'progress jumps without animation');
  ok(await page.evaluate(() => document.getElementById('cap1').getAttribute('y') === '9.5'), 'no equalizer with reduced motion');
  await emit(page, { type: 'done', mode: 'install', launched: false });
  ok(await waitScreen(page, 'done', 2000), 'done (reduced)');
  await page.waitForTimeout(500);
  await shot(page, 'reduced-done');
  ok(errors.length === 0, 'no console errors (reduced motion): ' + errors.join(' | '));
  await context.close();
}

// ================================================================== 7. layout at 100 % / 150 % and in a small work area
console.log('layout');
for (const cfg of [{ scale: 1, width: 880, height: 560, tag: '100' }, { scale: 1.5, width: 880, height: 560, tag: '150' }, { scale: 1.25, width: 760, height: 470, tag: 'small' }]) {
  for (const sc of ['install', 'update', 'uninstall']) {
    const { page, context, errors } = await open(sc, cfg);
    await skip(page);
    const home = sc === 'uninstall' ? 'uninstall' : 'welcome';
    await waitScreen(page, home); await quiet(page);
    const screens = [home];
    let probs = await layoutProblems(page);
    ok(probs.length === 0, `${cfg.tag}% ${sc}/${home}: fits ${probs.join('; ')}`);
    if (sc === 'install') {
      await page.click('#btn-options'); await waitScreen(page, 'options'); await quiet(page);
      probs = await layoutProblems(page);
      ok(probs.length === 0, `${cfg.tag}% options: fits ${probs.join('; ')}`);
      await emit(page, { type: 'folder', dir: 'C:\\Users\\Ein-sehr-langer-Benutzername\\AppData\\Local\\Programs\\Noch ein Unterordner\\VELOX', error: '', freeMB: 1234 });
      probs = await layoutProblems(page);
      ok(probs.length === 0, `${cfg.tag}% options with a very long path: fits ${probs.join('; ')}`);
      if (cfg.tag === '150') await shot(page, 'options-150');
      await page.click('#btn-install2'); await waitScreen(page, 'progress');
      await emit(page, { type: 'progress', percent: 40, step: 'Dateien werden kopiert …', file: 'data/tweaks/ein/sehr/langer/pfad/zu/einer/datei/die/nicht/passt/privacy-and-telemetry.json' });
      await quiet(page);
      probs = await layoutProblems(page);
      ok(probs.length === 0, `${cfg.tag}% progress: fits ${probs.join('; ')}`);
      await emit(page, { type: 'done', mode: 'install', launched: false });
      await waitScreen(page, 'done', 4000); await quiet(page);
      probs = await layoutProblems(page);
      ok(probs.length === 0, `${cfg.tag}% done: fits ${probs.join('; ')}`);
      await emit(page, { type: 'error', message: 'Für VELOX ist auf Laufwerk C: nicht genug Platz frei. Es werden etwa 3 MB gebraucht.', hint: 'Mach etwas Platz frei (zum Beispiel den Papierkorb leeren) oder wähle unter „Optionen“ einen anderen Ort. Dann versuche es noch einmal.' });
      await waitScreen(page, 'error'); await quiet(page);
      probs = await layoutProblems(page);
      ok(probs.length === 0, `${cfg.tag}% error with long text: fits ${probs.join('; ')}`);
      if (cfg.tag !== '100') await shot(page, `error-${cfg.tag}`);
    } else if (cfg.tag !== '100') await shot(page, `${sc}-${cfg.tag}`);
    if (cfg.tag === 'small' && sc === 'install') await shot(page, 'small-error');
    ok(errors.length === 0, `${cfg.tag}% ${sc}: no console errors ${errors.join(' | ')}`);
    await context.close();
  }
}

// ================================================================== 8. VELOX.exe start screen (host/splash.html)
console.log('VELOX.exe start screen');
{
  for (const scale of [1, 1.5]) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 840 }, deviceScaleFactor: scale });
    const page = await context.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(bridgeScript({ type: 'noop' }));
    await page.goto(BASE.replace('index.html', 'host-splash.html'));   // VELOX.exe shows it with NavigateToString
    await page.waitForTimeout(300);
    ok((await sent(page)).some(m => m.type === 'splash-ready'), `splash (${scale}x): announces "splash-ready"`);
    await emit(page, { type: 'mode', test: true });
    ok(await page.evaluate(() => document.body.classList.contains('test')), 'splash: Testmodus is marked');
    ok(await page.evaluate(() => ['.cap.c1', '.tracks.t1', '.v', '.name'].every(q => document.querySelector(q).getAnimations().length > 0)),
      'splash: tracks, caps, V and name have their entrance animation');
    if (scale === 1) { await page.waitForTimeout(1400); await shot(page, 'host-splash'); }
    await emit(page, { type: 'error', title: 'VELOX startet nicht', message: 'Der VELOX-Motor hat sich nach 45 Sekunden noch nicht gemeldet.', log: Array.from({ length: 40 }, (_, i) => 'Zeile ' + i + ' der Ausgabe').join('\n'), canTest: true });
    await page.waitForTimeout(500);
    ok(await page.isVisible('#b-retry') && await page.isVisible('#b-test') && await page.isVisible('#b-log'), 'splash error: "Erneut versuchen", "Testmodus", "Log öffnen"');
    ok((await page.textContent('#err-text')).includes('45 Sekunden'), 'splash error: message shown');
    const fits = await page.evaluate(() => { const d = document.documentElement; return d.scrollWidth <= innerWidth && d.scrollHeight <= innerHeight; });
    ok(fits, `splash error (${scale}x): no page scrolling`);
    if (scale === 1) await shot(page, 'host-splash-error');
    await page.click('#b-retry'); await page.click('#b-test'); await page.click('#b-log');
    const types = (await sent(page)).map(m => m.type);
    ok(types.includes('retry') && types.includes('test') && types.includes('openlog'), 'splash buttons send retry / test / openlog');
    await emit(page, { type: 'error', title: 'x', message: 'y', log: '', canTest: false });
    ok(await page.isHidden('#b-test'), 'no Testmodus button when already in the Testmodus');
    await emit(page, { type: 'starting', text: 'VELOX wird neu gestartet …' });
    ok((await page.textContent('#status')) === 'VELOX wird neu gestartet …', 'splash: restart status');
    ok(errors.length === 0, 'splash: no console errors ' + errors.join(' | '));
    await context.close();
  }
}

{
  const context = await browser.newContext({ viewport: { width: 1360, height: 840 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.addInitScript(bridgeScript({ type: 'noop' }));
  await page.goto(BASE.replace('index.html', 'host-splash.html'));
  await page.waitForTimeout(400);
  const calm = await page.evaluate(() => ['.cap.c1', '.tracks.t1', '.v', '.name'].every(q => document.querySelector(q).getAnimations().length === 0));
  const visible = await page.evaluate(() => getComputedStyle(document.querySelector('.name')).opacity === '1' && getComputedStyle(document.querySelector('.cap.c2')).opacity === '1');
  ok(calm && visible, 'splash with reduced motion: no entrance / loop animations, logo and name fully visible');
  await context.close();
}

// ================================================================== 9. frame budget of the intro (informational + sanity)
console.log('performance');
{
  const { page, context } = await open('install');
  const stats = await page.evaluate(() => new Promise(resolve => {
    const t = []; const start = performance.now();
    function f(now) { t.push(now); if (now - start < 2400) requestAnimationFrame(f); else resolve(t); }
    requestAnimationFrame(f);
  }));
  const gaps = stats.slice(1).map((x, i) => x - stats[i]).sort((a, b) => a - b);
  const p95 = gaps[Math.floor(gaps.length * 0.95)];
  const fps = Math.round(1000 * (stats.length - 1) / (stats[stats.length - 1] - stats[0]));
  console.log(`  info  intro: ${fps} fps average, p95 frame ${p95.toFixed(1)} ms (headless software rendering)`);
  ok(fps >= 30, `intro keeps a smooth frame rate even in headless Chromium (${fps} fps)`);
  await context.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
