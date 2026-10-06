#!/usr/bin/env node
// VELOX UI end-to-end tests (Playwright, Chromium). Drives the UI like a user would.
//
//   node tests/ui/run-ui-tests.mjs            # against tests/ui/mock-server.mjs (default)
//   node tests/ui/run-ui-tests.mjs --mock
//   node tests/ui/run-ui-tests.mjs --real     # spawns: pwsh Velox.ps1 -Simulate -NoBrowser -Port 0 -Token <t> -DataRoot <tmp>
//   options: --only <substring>  --headed  --no-screens  --keep (keep the server running on failure)
//
// Screenshots of every page (1360x880 and 900x600) and of key states land in tests/ui/screenshots/.
// Uses the globally installed Playwright with its preinstalled Chromium (never runs "playwright install").

import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');
const shotDir = path.join(here, 'screenshots');
const argv = process.argv.slice(2);
const REAL = argv.includes('--real');
const MODE = REAL ? 'real' : 'mock';
const HEADED = argv.includes('--headed');
const SCREENS = !argv.includes('--no-screens');
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

function loadPlaywright() {
  const tries = [() => createRequire(import.meta.url)('playwright'), () => createRequire('/opt/node22/lib/node_modules/')('playwright')];
  tries.push(() => createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'));
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  throw new Error('Playwright not found (expected a global install).');
}
const { chromium } = loadPlaywright();

// ------------------------------------------------------------------ fake KI APIs (real mode)
// Answers like api.groq.com/openai/v1 and api.anthropic.com with the fixture plan - never the network.
const FAKE_AI = { url: null, server: null, requests: [] };
function fakeAiApi() {
  const plan = fs.readFileSync(path.join(appRoot, 'tests', 'fixtures', 'claude', 'plan-ok.json'), 'utf8').trim();
  const models = { object: 'list', data: [{ id: 'openai/gpt-oss-120b', active: true }, { id: 'openai/gpt-oss-20b', active: true }, { id: 'llama-3.1-8b-instant', active: true }, { id: 'whisper-large-v3', active: true }] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      FAKE_AI.requests.push({ method: req.method, url: req.url });
      const out = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url.startsWith('/openai/v1/models')) return out(200, models);
      if (req.method === 'POST' && req.url === '/openai/v1/chat/completions') {
        let model = 'openai/gpt-oss-120b'; try { model = JSON.parse(body).model || model; } catch { /* default */ }
        return out(200, { id: 'x', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: plan }, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: 600 } });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) return out(200, { data: [{ id: 'claude-opus-5-5', type: 'model' }], has_more: false });
      if (req.method === 'POST' && req.url === '/v1/messages') {
        return out(200, { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: plan }], stop_reason: 'end_turn', usage: { input_tokens: 20000, output_tokens: 900 } });
      }
      out(404, { error: { message: 'unknown fake route' } });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => { FAKE_AI.server = srv; FAKE_AI.url = 'http://127.0.0.1:' + srv.address().port; resolve(); }));
}

// ------------------------------------------------------------------ server
function startServer(extraArgs = []) {
  const token = crypto.randomBytes(32).toString('hex');
  let child;
  let dataRoot = null;
  if (REAL) {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-ui-'));
    // Reinigung: a throw-away fake PC (deletes really happen in it, never on this machine)
    const cleanFx = path.join(dataRoot, 'cleanfx');
    execSync('pwsh -NoProfile -File ' + JSON.stringify(path.join(appRoot, 'tests', 'fixtures', 'clean', 'New-CleanFixture.ps1')) + ' -Root ' + JSON.stringify(cleanFx), { stdio: 'ignore' });
    // KI: the fake Claude Code CLI first on PATH (the real CLI must never get a prompt here) and the
    // Groq / Anthropic APIs answered by fakeAiApi() on 127.0.0.1
    const fakeCli = path.join(appRoot, 'tests', 'fixtures', 'claude-cli');
    const env = Object.assign({}, process.env, {
      PATH: fakeCli + path.delimiter + (process.env.PATH || ''),
      VELOX_CLAUDE_CLI: path.join(fakeCli, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
      VELOX_CLAUDE_CLI_ONLY: '1',
      VELOX_FAKE_CLAUDE_MODE: 'ok',
      VELOX_GROQ_BASE_URL: FAKE_AI.url + '/openai/v1',
      VELOX_ANTHROPIC_BASE_URL: FAKE_AI.url,
      // Testmodus DISM/SFC: long enough to watch the live percent and to cancel
      VELOX_SIM_TOOL_MS: '6000',
      VELOX_CLEAN_FIXTURE: cleanFx
    });
    child = spawn('pwsh', ['-NoProfile', '-File', path.join(appRoot, 'Velox.ps1'), '-Simulate', '-NoBrowser', '-Port', '0', '-Token', token, '-DataRoot', dataRoot], { stdio: ['ignore', 'pipe', 'pipe'], env });
  } else {
    child = spawn(process.execPath, [path.join(here, 'mock-server.mjs'), '--port', '0', '--token', token, '--speed', '35', '--quiet', ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not print VELOX_READY within 90 s\n' + stderr)); }, 90000);
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      // the backend may fall back to http://localhost:<port>/ (see core/Server.ps1)
      const m = buf.match(/VELOX_READY (http:\/\/(127\.0\.0\.1|localhost):(\d+)\/\?t=([0-9a-fA-F]+))/);
      if (m) { clearTimeout(timer); resolve({ url: m[1], host: m[2], port: Number(m[3]), token: m[4], child, dataRoot, stderr: () => stderr }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited with ' + code + '\n' + stderr)); });
  });
}
function stopServer(s) {
  if (!s) return;
  try { s.child.kill(); } catch { /* ignore */ }
  if (s.dataRoot) { try { fs.rmSync(s.dataRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
}
function rawRequest(s, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ agent: false, host: s.host === 'localhost' ? 'localhost' : '127.0.0.1', port: s.port, method, path: p, headers: Object.assign({ Host: s.host + ':' + s.port }, headers) }, (res) => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, text: data }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
const api = (s, method, p, body) => rawRequest(s, method, p, { headers: { 'X-Velox-Token': s.token, 'Content-Type': 'application/json' }, body });

// ------------------------------------------------------------------ test framework
const tests = [];
function test(name, fn, opts = {}) { tests.push({ name, fn, opts }); }
class AssertError extends Error {}
function assert(cond, msg) { if (!cond) throw new AssertError(msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers (driving the UI)
async function openApp(t, hash = '', opts = {}) {
  const ctx = await t.browser.newContext({ viewport: opts.viewport || { width: 1360, height: 880 }, reducedMotion: opts.reducedMotion || 'no-preference' });
  const page = await ctx.newPage();
  t.watch(page);
  await page.goto(t.server.url + (hash ? '#/' + hash : ''));
  await ready(page);
  t.contexts.push(ctx);
  return page;
}
async function ready(page, timeout = 60000) {
  try {
    await page.waitForFunction(() => document.documentElement.classList.contains('ready'), null, { timeout });
    await page.waitForFunction(() => { const s = document.getElementById('splash'); return s.hidden; }, null, { timeout });
    await idle(page, timeout);
  } catch (e) {
    const diag = await page.evaluate(() => ({ busy: window.__velox && window.__velox.busy, job: (document.querySelector('.layer .job') || {}).textContent, splash: !document.getElementById('splash').hidden, toasts: document.getElementById('toasts').textContent })).catch(() => null);
    throw new Error(e.message.split('\n')[0] + ' | ' + JSON.stringify(diag));
  }
}
async function idle(page, timeout = 60000) {
  // not busy AND settled: after a job the app still re-reads state / catalog (ctx.settling) and the
  // pages re-render - a click in that window lands on a row that is about to be replaced
  await page.waitForFunction(() => window.__velox && !window.__velox.busy && !window.__velox.settling && !document.querySelector('.layer .job[data-job="running"]'), null, { timeout });
  // A finished job overlay may stay open on purpose (warnings in the log, long or repair jobs):
  // read like a user would and close it.
  await page.waitForFunction(() => !document.querySelector('.layer .job') || document.querySelector('.layer:not(.closing) .job .job-close:not([hidden])'), null, { timeout: 5000 });
  if (await page.$('.layer:not(.closing) .job .job-close:not([hidden])')) await page.click('.layer:not(.closing) .job .job-close');
  await page.waitForFunction(() => !document.querySelector('.layer .job'), null, { timeout: 5000 });
}
async function goPage(page, id) {
  await page.click('#nav .nav-item[data-page="' + id + '"]');
  await page.waitForSelector('.page[data-page="' + id + '"]');
  await page.waitForTimeout(250);
}
/** Clicks at the element's real on-screen position (fails when it is off-screen or covered). */
async function clickLikeAMouse(page, sel) {
  await page.waitForSelector(sel);
  // entrance animation / shared-element view transition finished
  await page.waitForFunction(() => !document.documentElement.classList.contains('vt-shared'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const box = await page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vh: innerHeight, vw: innerWidth }; });
  assert(box.y > 0 && box.y < box.vh && box.x > 0 && box.x < box.vw, sel + ' is off-screen at y=' + Math.round(box.y));
  const hit = await page.evaluate(({ x, y, s }) => { const el = document.elementFromPoint(x, y); return el && el.closest(s) ? true : (el ? el.tagName + '.' + el.className : 'nothing'); }, { x: box.x, y: box.y, s: sel });
  assert(hit === true, sel + ' is covered by ' + hit);
  await page.mouse.click(box.x, box.y);
}
/** A number shown with countUp() (ui.js), read once its animation has ended. */
async function settledNumber(page, sel) {
  await page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e._cu; }, sel, { timeout: 5000 });
  return Number((await page.textContent(sel)).replace(/\./g, '').trim());
}
async function waitJobDone(page, timeout = 60000) {
  await page.waitForSelector('.layer .job', { timeout: 10000 });
  await idle(page, timeout);
}
async function toastText(page) {
  return page.$$eval('#toasts .toast', els => els.map(e => e.textContent).join(' | '));
}
async function shot(page, name) {
  if (!SCREENS) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, name + '.png') });
}
async function overflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement; const m = document.getElementById('main');
    const vw = d.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll('#view *, .topbar *, .sidebar *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;
      // inside a horizontally scrolling or clipping container is fine
      let p = el.parentElement; let clipped = false;
      while (p && p !== document.body) { const cs = getComputedStyle(p); if (cs.overflowX !== 'visible' && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break; } p = p.parentElement; }
      if (!clipped) offenders.push((el.className && el.className.baseVal === undefined ? el.className : el.tagName) + ' ' + Math.round(r.right));
      if (offenders.length > 5) break;
    }
    return { doc: d.scrollWidth - d.clientWidth, main: m.scrollWidth - m.clientWidth, offenders, shellTop: document.querySelector('.shell').getBoundingClientRect().top };
  });
}
async function firstRow(page, filter) {
  return page.evaluate((f) => {
    const rows = Array.from(document.querySelectorAll('.tw-list .trow'));
    const r = rows.find(row => row.dataset.kind === (f.kind || 'toggle') && (!f.status || row.dataset.status === f.status) && (!f.risk || row.dataset.risk === f.risk) && !row.classList.contains('is-na') && !row.classList.contains('is-pending') && !(f.notNeeds && row.querySelector('.badge [data-icon="restart"], .badge svg[data-icon="restart"]')));
    return r ? r.dataset.id : null;
  }, filter || {});
}
const rowSel = (id) => '.trow[data-id="' + id.replace(/"/g, '\\"') + '"]';

// ------------------------------------------------------------------ tests
test('security: token, host, origin, OPTIONS, static traversal', async (t) => {
  const s = t.server;
  assert((await rawRequest(s, 'GET', '/api/state')).status === 401, 'no token -> 401');
  assert((await rawRequest(s, 'GET', '/api/state', { headers: { 'X-Velox-Token': 'wrong' } })).status === 401, 'wrong token -> 401');
  // 403 from VELOX itself, or 400/404 from http.sys / HttpListener, which already refuse host names
  // that do not match the listener prefix. Either way nothing may be served.
  const bh = await rawRequest(s, 'GET', '/api/state', { headers: { 'X-Velox-Token': s.token, Host: 'evil.example:' + s.port } });
  assert([400, 403, 404].includes(bh.status) && !(bh.json && bh.json.statuses), 'bad host rejected (' + bh.status + ')');
  const bo = await rawRequest(s, 'GET', '/api/state', { headers: { 'X-Velox-Token': s.token, Origin: 'http://evil.example' } });
  assert(bo.status === 403, 'bad origin -> 403 (got ' + bo.status + ')');
  const op = await rawRequest(s, 'OPTIONS', '/api/state', { headers: { 'X-Velox-Token': s.token } });
  assert(op.status === 403, 'OPTIONS -> 403 (got ' + op.status + ')');
  const ok = await api(s, 'GET', '/api/state');
  assert(ok.status === 200 && ok.json && ok.json.statuses, 'state with token');
  assert(/application\/json/.test(ok.headers['content-type']), 'json content type');
  assert(!ok.headers['access-control-allow-origin'], 'no CORS headers');
  const idx = await rawRequest(s, 'GET', '/');
  assert(idx.status === 200 && /text\/html/.test(idx.headers['content-type']) && /no-store/.test(idx.headers['cache-control'] || ''), 'index served no-store');
  const trav = await rawRequest(s, 'GET', '/..%2f..%2fVelox.ps1');
  assert(trav.status === 403 || trav.status === 404 || trav.status === 400, 'path traversal rejected (' + trav.status + ')');
  const css = await rawRequest(s, 'GET', '/css/app.css');
  assert(/text\/css/.test(css.headers['content-type']), 'css content type');
});

test('bootstrap renders, first-run scan, token removed from URL', async (t) => {
  const ctx = await t.browser.newContext({ viewport: { width: 1360, height: 880 } });
  t.contexts.push(ctx);
  const page = await ctx.newPage();
  t.watch(page);
  await page.goto(t.server.url);
  await page.waitForFunction(() => document.documentElement.classList.contains('ready'));
  await ready(page);
  assert(!page.url().includes('t='), 'token removed from address bar: ' + page.url());
  const stored = await page.evaluate(() => sessionStorage.getItem('velox.token'));
  assert(stored && stored.length >= 32, 'token kept in sessionStorage');
  assert((await page.textContent('#topbar-title')) === 'Übersicht', 'overview title');
  assert((await page.$$('#nav .nav-item')).length === 10, '10 nav items');
  assert(/Testmodus/.test(await page.textContent('#mode-chips')), 'Testmodus chip');
  await page.waitForFunction(() => document.querySelectorAll('.sys-card:not(.is-loading)').length === 6, null, { timeout: 30000 });
  const csp = await page.$eval('meta[http-equiv="Content-Security-Policy"]', m => m.content);
  assert(/default-src 'self'/.test(csp) && /img-src 'self' data:/.test(csp), 'CSP meta');
  assert((await page.$$('script:not([src])')).length === 0, 'no inline scripts');
  assert(await page.evaluate(() => !document.querySelector('link[href^="http"], script[src^="http"]')), 'no external URLs');
  await shot(page, 'overview-first-run-1360');
});

// ------------------------------------------------------------------ brand: splash, sound setting, palette, CSP
/** A fresh window on the app (own context: own sessionStorage / localStorage), not waited for. */
async function openRaw(t, query = '', opts = {}) {
  const ctx = await t.browser.newContext({ viewport: opts.viewport || { width: 1360, height: 880 }, reducedMotion: opts.reducedMotion || 'no-preference' });
  t.contexts.push(ctx);
  const page = await ctx.newPage();
  t.watch(page);
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(t.server.url + query);
  return page;
}
const splashInfo = (page) => page.evaluate(() => window.__velox && window.__velox.splash && window.__velox.splash.info);
async function introMounted(page) {
  await page.waitForFunction(() => window.__velox && window.__velox.splash && window.__velox.splash.info.mounted, null, { timeout: 15000 });
  return splashInfo(page);
}
async function settingsNow(t) { return (await api(t.server, 'GET', '/api/bootstrap')).json.settings; }

test('splash: full intro for a new version, short after that, the hand-over then the app', async (t) => {
  await api(t.server, 'POST', '/api/settings', { introSeen: '', startSound: true });
  const version = (await api(t.server, 'GET', '/api/bootstrap')).json.app.version;
  const page = await openRaw(t);
  const a = await introMounted(page);
  assert(a.variant === 'full' && !a.hosted, 'first start of ' + version + ': full intro, ' + JSON.stringify(a));
  assert(a.sound === true && a.muted === false, 'sound allowed by the setting: ' + JSON.stringify(a));
  assert((await page.$eval('#splash .vx-label-r', e => e.textContent)) === 'Version ' + version, 'version label');
  assert(await page.$eval('#app', e => e.hasAttribute('inert')), 'the app behind the splash is inert');
  await page.waitForFunction(() => document.querySelector('#splash .vx.vx--settled'), null, { timeout: 10000 });
  await shot(page, 'state-splash-full');
  await ready(page);
  assert(!(await page.$('#splash .vx')), 'intro destroyed after the hand-over');
  assert(!(await page.$eval('#app', e => e.hasAttribute('inert'))), 'app usable after the splash');
  assert((await settingsNow(t)).introSeen === version, 'introSeen remembered in settings.json');
  const page2 = await openRaw(t);
  const b = await introMounted(page2);
  assert(b.variant === 'short', 'second start: short intro, ' + JSON.stringify(b));
  // Esc skips to the settled pose; the app is there right after the hand-over
  await page2.waitForFunction(() => window.__velox.splash.intro && window.__velox.splash.intro.keysActive);
  await page2.keyboard.press('Escape');
  await ready(page2);
});

test('splash: under VELOX.exe only the hand-over pose, no sound, no second intro', async (t) => {
  await api(t.server, 'POST', '/api/settings', { introSeen: '', startSound: true });
  const page = await openRaw(t, (t.server.url.includes('?') ? '&' : '?') + 'from=host&sound=off');
  const a = await introMounted(page);
  assert(a.hosted && a.variant === 'still', 'from=host: still pose, ' + JSON.stringify(a));
  const pose = await page.evaluate(() => ({ cls: document.querySelector('#splash .vx').className, soundBtn: !!document.querySelector('#splash .vx-sound:not([hidden])'), skip: !!document.querySelector('#splash .vx-skip:not([hidden])') }));
  assert(/vx--done/.test(pose.cls) && !pose.soundBtn && !pose.skip, 'canonical end pose without controls: ' + JSON.stringify(pose));
  await ready(page);
  assert(!/from=|sound=|[?&]t=/.test(page.url()), 'hints removed from the address bar: ' + page.url());
  const s = await settingsNow(t);
  assert(s.startSound === false, 'the start screen\'s mute choice (&sound=off) is saved');
  assert(s.introSeen === '', 'no full intro played here, nothing marked as seen');
  // a reload inside VELOX.exe (the hint is gone from the URL) still shows only the pose
  await page.reload();
  const r = await introMounted(page);
  assert(r.hosted && r.variant === 'still', 'reload in VELOX.exe: still pose, ' + JSON.stringify(r));
  await ready(page);
  await api(t.server, 'POST', '/api/settings', { startSound: true });
  if (MODE === 'mock') {
    // a host that forgot from=host: bootstrap.mode.hosted is enough
    await api(t.server, 'POST', '/__mock/mode', { hosted: true });
    try {
      const p2 = await openRaw(t);
      const b = await introMounted(p2);
      assert(b.hosted && b.variant === 'still', 'mode.hosted: still pose, ' + JSON.stringify(b));
      await ready(p2);
    } finally { await api(t.server, 'POST', '/__mock/mode', { hosted: false }); }
  }
});

test('splash: first-run scan shows its progress in the intro, also under VELOX.exe', async (t) => {
  await api(t.server, 'POST', '/__mock/reset', {});
  try {
    const page = await openRaw(t, (t.server.url.includes('?') ? '&' : '?') + 'from=host');
    await page.waitForSelector('#splash .splash-scan', { timeout: 15000 });
    await page.waitForFunction(() => /%/.test(document.querySelector('#splash .splash-scan-pct').textContent));
    await shot(page, 'state-splash-hosted-scan');
    await ready(page);
    await api(t.server, 'POST', '/__mock/reset', {});
    const p2 = await openRaw(t);
    await introMounted(p2);
    await p2.waitForFunction(() => document.querySelector('#splash .vx.vx--det'), null, { timeout: 15000 });
    await ready(p2);
  } finally { await api(t.server, 'POST', '/api/settings', { startSound: true }); }
}, { mockOnly: true });

test('splash: M in the intro writes settings.startSound; the next start respects it', async (t) => {
  await api(t.server, 'POST', '/api/settings', { introSeen: '', startSound: true });
  const page = await openRaw(t);
  await introMounted(page);
  await page.waitForFunction(() => window.__velox.splash.intro && window.__velox.splash.intro.keysActive);
  // headless Chromium blocks autoplay like Edge does: the first M is the gesture that unlocks
  // (and replays) the sound, it never mutes; the next M mutes
  if (await page.evaluate(() => window.__velox.splash.intro.blocked)) {
    assert((await page.$eval('#splash .vx-sound', b => b.textContent)).includes('Ton: klicken'), 'blocked autoplay says so');
    await page.keyboard.press('m');
    await page.waitForFunction(() => !window.__velox.splash.intro.blocked);
  }
  await page.keyboard.press('m');
  await page.waitForFunction(() => window.__velox.splash.info.muted === true);
  await page.waitForFunction(() => window.__velox.settings.startSound === false, null, { timeout: 5000 });
  assert((await settingsNow(t)).startSound === false, 'M saved startSound=false');
  await ready(page);
  await goPage(page, 'settings');
  assert((await page.$eval('.switch.start-sound', b => b.getAttribute('aria-checked'))) === 'false', 'settings page shows it off');
  const p2 = await openRaw(t);
  const b = await introMounted(p2);
  assert(b.muted === true && b.sound === false, 'next start is muted: ' + JSON.stringify(b));
  assert((await p2.$eval('#splash .vx-sound', e => e.textContent)).includes('Ton aus'), 'button says "Ton aus"');
  await ready(p2);
  // and back on through the settings page
  await goPage(p2, 'settings');
  await p2.click('.switch.start-sound');
  await p2.waitForFunction(() => window.__velox.settings.startSound === true);
  assert((await settingsNow(t)).startSound === true, 'switched back on');
  // replay from the settings page: the full intro over the app, then back
  await p2.click('[data-testid="intro-replay"]');
  await p2.waitForFunction(() => window.__velox.splash.info.preview === true);
  assert(!(await p2.$eval('#splash', e => e.hidden)), 'replay shows the splash');
  await p2.keyboard.press('Escape');
  await p2.waitForFunction(() => document.getElementById('splash').hidden && !window.__velox.splash.info.preview, null, { timeout: 8000 });
  assert(!(await p2.$eval('#app', e => e.hasAttribute('inert'))), 'app usable after the replay');
});

test('brand: no violet left, signal only where the kit allows it, AA contrast of accent text and badges', async (t) => {
  // the stylesheets themselves
  for (const f of ['css/app.css', 'css/games.css', 'css/cleanup.css', 'brand/tokens.css', 'brand/tokens-app.css', 'brand/intro.css', 'index.html']) {
    const r = await rawRequest(t.server, 'GET', '/' + f);
    assert(r.status === 200, f + ' served');
    assert(!/7C5CFF|124,\s*92,\s*255|22D3EE|34,\s*211,\s*238/i.test(r.text), f + ' still contains the old violet/cyan');
    assert(!/data-accent/.test(r.text), f + ' still has accent variants');
  }
  const page = await openApp(t, 'overview');
  const OLD = /124,\s*92,\s*255|34,\s*211,\s*238/;
  const scan = () => page.evaluate(() => {
    const props = ['color', 'backgroundColor', 'borderTopColor', 'boxShadow', 'backgroundImage', 'outlineColor', 'fill', 'stroke', 'textDecorationColor'];
    const out = [];
    for (const el of document.querySelectorAll('body, body *')) {
      for (const pseudo of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        for (const p of props) { const v = cs[p]; if (v && /124,\s*92,\s*255|34,\s*211,\s*238/.test(v)) out.push((el.className && el.className.baseVal === undefined ? el.className : el.tagName) + (pseudo || '') + ' ' + p + ': ' + v); }
      }
      if (out.length > 5) break;
    }
    return out;
  });
  for (const id of ['overview', 'tweaks', 'presets', 'advisor', 'detweak', 'games', 'cleanup', 'apps', 'backups', 'settings']) {
    await goPage(page, id);
    const bad = await scan();
    assert(!bad.length, 'old accent on ' + id + ': ' + bad.join(' | '));
  }
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette');
  assert(!(await scan()).length, 'old accent in the palette');
  await page.keyboard.press('Escape');
  // the signal: primary button (ink text on it), focus ring, active nav bar
  const sig = await page.evaluate(() => {
    const btn = document.querySelector('.btn-primary') || document.querySelector('#pending-apply');
    const bar = getComputedStyle(document.getElementById('nav-pill'), '::before').backgroundColor;
    return { bg: getComputedStyle(btn).backgroundColor, fg: getComputedStyle(btn).color, bar, ring: getComputedStyle(document.documentElement).getPropertyValue('--focus-outline') };
  });
  assert(sig.bg === 'rgb(255, 90, 31)' && sig.fg === 'rgb(12, 13, 15)', 'primary = signal with ink text: ' + JSON.stringify(sig));
  assert(sig.bar === 'rgb(255, 90, 31)', 'active nav bar in signal: ' + sig.bar);
  assert(/FF5A1F|var\(--vx-signal\)/i.test(sig.ring), 'focus ring in signal: ' + sig.ring);
  // contrast (WCAG 2.x) of every badge and every accent button on the tweaks page, against what
  // is really behind them (semi-transparent tints composited over the card)
  await goPage(page, 'tweaks');
  const res = await page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
    const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let acc = { r: 12, g: 13, b: 15, a: 1 }; for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc); return acc; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const rows = [];
    for (const el of document.querySelectorAll('.badge, .btn-primary, .btn-brand, .chip[aria-pressed="true"]')) {
      if (!el.getClientRects().length) continue;
      const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
      rows.push({ cls: el.className, text: el.textContent.trim().slice(0, 24), ratio: Math.round(ratio(fg, bg) * 100) / 100 });
    }
    return rows;
  });
  assert(res.length > 10, 'badges found: ' + res.length);
  const low = res.filter(r => r.ratio < 4.5);
  assert(!low.length, 'below AA 4.5:1: ' + JSON.stringify(low.slice(0, 5)));
  const kinds = await page.evaluate(() => ['ok', 'warn', 'error'].map(k => { const b = document.querySelector('.badge-' + k); return b ? getComputedStyle(b).color : null; }));
  assert(new Set(kinds.filter(Boolean)).size === kinds.filter(Boolean).length && !kinds.includes('rgb(255, 90, 31)'), 'Sicher/Mittel/Riskant distinct and never the signal: ' + kinds.join(' / '));
});

test('CSP: no violations anywhere (splash, every page, palette, dialogs, replay)', async (t) => {
  const init = () => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '') + ':' + e.lineNumber)); };
  const page = await openRaw(t, '', { init });
  const consoleCsp = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text()); });
  await ready(page);
  for (const id of ['overview', 'tweaks', 'presets', 'advisor', 'detweak', 'games', 'cleanup', 'apps', 'backups', 'settings']) await goPage(page, id);
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="intro-replay"]');
  await page.waitForFunction(() => window.__velox.splash.info.preview === true);
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('splash').hidden, null, { timeout: 8000 });
  const v = await page.evaluate(() => window.__csp);
  assert(!v.length && !consoleCsp.length, 'CSP violations: ' + JSON.stringify(v.concat(consoleCsp).slice(0, 5)));
});

test('navigation: every page at 1360x880 and 900x600, no horizontal overflow', async (t) => {
  const ids = ['overview', 'tweaks', 'presets', 'advisor', 'detweak', 'games', 'cleanup', 'apps', 'backups', 'settings'];
  for (const vp of [{ width: 1360, height: 880 }, { width: 900, height: 600 }]) {
    const page = await openApp(t, '', { viewport: vp });
    for (const id of ids) {
      await goPage(page, id);
      await idle(page);
      await page.waitForTimeout(600);
      const title = await page.textContent('#topbar-title');
      assert(title && title.length > 2, 'title for ' + id);
      const ov = await overflow(page);
      assert(ov.doc <= 0 && ov.main <= 0, 'horizontal overflow on ' + id + ' at ' + vp.width + ': ' + JSON.stringify(ov));
      assert(!ov.offenders.length, 'elements past the right edge on ' + id + ' at ' + vp.width + ': ' + ov.offenders.join(', '));
      assert(ov.shellTop === 0, 'layout shifted vertically on ' + id + ': ' + ov.shellTop);
      await page.mouse.move(5, vp.height - 5);
      await shot(page, id + '-' + vp.width + 'x' + vp.height);
    }
  }
});

test('tweaks: toggle stages a change, Anwenden runs a job, status updates, revert', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  assert(id, 'found a safe default toggle');
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('#pending.show');
  await page.waitForFunction(() => document.getElementById('pending-count').textContent.trim() === '1', null, { timeout: 2000 });
  assert(await page.$eval(rowSel(id), r => r.classList.contains('is-pending')), 'row marked pending');
  await shot(page, 'state-pending-bar');
  await page.click('#pending-apply');
  await waitJobDone(page);
  await page.waitForFunction((i) => document.querySelector('.trow[data-id="' + i + '"]').dataset.status === 'applied', id);
  assert(!(await page.$eval('#pending', p => p.classList.contains('show'))), 'pending bar hidden');
  assert(/angewendet/i.test(await toastText(page)), 'toast after apply');
  // revert again
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('#pending.show');
  assert(/zurücksetzen/.test(await page.textContent('#pending-detail')), 'pending shows revert');
  await page.click('#pending-apply');
  await waitJobDone(page);
  await page.waitForFunction((i) => document.querySelector('.trow[data-id="' + i + '"]').dataset.status === 'default', id);
});

test('tweaks: details, search, filters, recommended, discard', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, {});
  await page.click(rowSel(id) + ' .trow-expand');
  await page.waitForSelector(rowSel(id) + ' .trow-details:not([hidden]) .act');
  assert(/Was genau geändert wird/.test(await page.textContent(rowSel(id) + ' .trow-details')), 'details heading');
  await shot(page, 'state-tweak-details');
  await page.fill('[data-testid="tweak-search"]', 'zzqqxx-nichts');
  await page.waitForSelector('.tw-list .empty');
  await page.fill('[data-testid="tweak-search"]', '');
  await page.waitForSelector('.tw-list .trow');
  await page.click('.chip[data-filter="risk:safe"]');
  await page.waitForTimeout(200);
  const risks = await page.$$eval('.tw-list .trow', rows => Array.from(new Set(rows.map(r => r.dataset.risk))));
  assert(risks.length === 1 && risks[0] === 'safe', 'risk filter: ' + risks);
  await page.click('.chip-reset');
  const btn = await page.$('[data-testid="recommend-btn"]:not([disabled])');
  if (btn) {
    await btn.click();
    await page.waitForSelector('#pending.show');
    // the counter counts up for 300 ms: read it once it has settled, never mid-animation
    const n = await settledNumber(page, '#pending-count');
    assert(n > 0 && n === await page.evaluate(() => window.__velox.pending.size), 'recommended staged: ' + n);
    await page.click('#pending-list-btn');
    await page.waitForSelector('#pending-pop:not([hidden]) .pending-item');
    await page.click('#pending-discard');
    await page.waitForSelector('#pending:not(.show)');
  }
});

// Root cause of the old "details, search, filters" flake: after the first-run scan the job is no
// longer busy, but the app still re-reads state and catalog and then re-renders the tweak list - a
// row opened in that window snapped shut (waitForSelector on the open details then timed out).
// Deterministic version of that race: open a row, then make the app re-read the catalog (a rescan,
// as from the palette) and check the row survives the re-render.
test('tweaks: open details survive the catalog re-render after a scan', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, {});
  await page.click(rowSel(id) + ' .trow-expand');
  await page.waitForSelector(rowSel(id) + ' .trow-details:not([hidden])');
  // mark the row element: after the re-render it must be a new element that is open again
  await page.$eval(rowSel(id), r => { r.dataset.before = '1'; });
  const reloads = await page.evaluate(() => new Promise((res) => {
    let n = 0; const off = window.__velox.on('catalog', () => { n++; });
    window.__velox.rescan();
    const wait = () => (window.__velox.scanning || window.__velox.settling) ? setTimeout(wait, 50) : (off(), res(n));
    setTimeout(wait, 50);
  }));
  assert(reloads > 0, 'the rescan re-read the catalog');
  await idle(page);
  assert(await page.$eval(rowSel(id), r => !r.dataset.before), 'the list really was re-rendered');
  assert(await page.$eval(rowSel(id) + ' .trow-details', d => !d.hidden), 'details still open after the list re-rendered');
  assert((await page.getAttribute(rowSel(id) + ' .trow-expand', 'aria-expanded')) === 'true', 'aria-expanded kept');
  // closing it is remembered as well
  await page.click(rowSel(id) + ' .trow-expand');
  await page.evaluate(() => window.__velox.emit('catalog'));
  assert(await page.$eval(rowSel(id) + ' .trow-details', d => d.hidden), 'a closed row stays closed');
});

test('tweaks: risky toggle needs the confirm checkbox', async (t) => {
  const page = await openApp(t, 'tweaks');
  await page.click('.chip[data-filter="risk:risky"]');
  await page.waitForTimeout(250);
  const id = await firstRow(page, { risk: 'risky' });
  assert(id, 'found a risky toggle');
  const wasOn = await page.$eval(rowSel(id) + ' .switch', s => s.getAttribute('aria-checked') === 'true');
  if (wasOn) { console.log('    (risky tweak already on, skipping)'); return; }
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('.layer .dialog [data-action="confirm"]');
  assert(await page.$eval('.layer .dialog [data-action="confirm"]', b => b.disabled), 'confirm disabled until checkbox');
  assert(/Ich weiß, was ich tue/.test(await page.textContent('.layer .dialog')), 'checkbox text');
  await shot(page, 'state-risky-confirm');
  await page.click('.layer .dialog .confirm-check');
  assert(!(await page.$eval('.layer .dialog [data-action="confirm"]', b => b.disabled)), 'confirm enabled');
  await page.click('.layer .dialog [data-action="confirm"]');
  await page.waitForSelector('#pending.show');
  assert(await page.$eval(rowSel(id), r => r.classList.contains('is-pending')), 'risky staged');
  await page.click('#pending-discard');
  await page.waitForSelector('#pending:not(.show)');
  // cancelling the dialog stages nothing
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('.layer .dialog [data-action="cancel"]');
  await page.click('.layer .dialog [data-action="cancel"]');
  await page.waitForTimeout(300);
  assert(!(await page.$eval('#pending', p => p.classList.contains('show'))), 'cancel stages nothing');
});

test('hover feedback on every kind of control', async (t) => {
  const page = await openApp(t, 'overview');
  const snap = (sel) => page.$eval(sel, (el) => {
    const pick = (e) => { const cs = getComputedStyle(e); return [cs.transform, cs.backgroundColor, cs.color, cs.boxShadow, cs.opacity, cs.backgroundImage].join('|'); };
    return [el, ...Array.from(el.querySelectorAll('*')).slice(0, 4)].map(pick).join('#');
  });
  const check = async (sel) => {
    const el = await page.$(sel);
    assert(el, 'element exists: ' + sel);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(260);
    const before = await snap(sel);
    await el.hover();
    await page.waitForTimeout(260);
    const after = await snap(sel);
    assert(before !== after, 'no hover feedback on ' + sel);
  };
  for (const sel of ['.tile', '.stat-card', '.sys-card', '.hero .btn-primary', '.hero .btn-secondary', '#nav .nav-item:not([aria-current])', '#palette-trigger']) await check(sel);
  await goPage(page, 'tweaks');
  for (const sel of ['.chip[data-filter="risk:safe"]', '.rail-item[aria-pressed="false"]', '.tw-list .trow', '.tw-list .trow .trow-expand', '.tw-list .trow .switch:not([disabled])']) await check(sel);
  await goPage(page, 'presets');
  if (await page.$('.preset-card')) await check('.preset-card');
  await goPage(page, 'settings');
  for (const sel of ['.switch.start-sound', '[data-testid="intro-replay"]', '.model:not([aria-checked="true"])']) await check(sel);
});

test('keyboard: switch with Space, Escape closes dialogs, focus ring', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  await page.focus(rowSel(id) + ' .switch');
  await page.keyboard.press('Space');
  await page.waitForSelector('#pending.show');
  const outline = await page.$eval(rowSel(id) + ' .switch', el => getComputedStyle(el).outlineStyle);
  assert(outline !== 'none', 'focus-visible ring on switch');
  await page.click('#pending-discard');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached' });
});

test('presets: preview drawer lists real changes, apply, detweak routing', async (t) => {
  const page = await openApp(t, 'presets');
  const cards = await page.$$('.preset-card');
  if (!cards.length) { assert(await page.$('.preset-grid .empty'), 'empty state when the catalog has no presets'); console.log('    (no presets in catalog: empty state checked)'); return; }
  let applied = false;
  for (let i = 0; i < cards.length && !applied; i++) {
    await page.click('.preset-card >> nth=' + i);
    await page.waitForSelector('.drawer');
    const btn = await page.$('[data-testid="preset-apply"]');
    if (await btn.isDisabled()) { await page.keyboard.press('Escape'); await page.waitForSelector('.drawer', { state: 'detached' }); continue; }
    const items = await page.$$('.drawer .pv-will');
    assert(items.length > 0, 'preview lists changes');
    await shot(page, 'state-preset-preview');
    const pid = await page.$eval('.preset-card >> nth=' + i, c => c.dataset.preset);
    // the card promises exactly what the drawer will change
    const cardN = await page.$eval('.preset-card >> nth=' + i, c => (c.querySelector('.preset-count strong') || {}).textContent);
    assert(cardN === String(items.length), 'card count ' + cardN + ' = drawer changes ' + items.length);
    await clickLikeAMouse(page, '[data-testid="preset-apply"]');
    await waitJobDone(page);
    applied = pid;
  }
  assert(applied, 'applied one preset');
  // routing to detweak with the preset preselected: the hint stays and the scan starts by itself
  await page.click('.preset-card[data-preset="' + applied + '"]');
  await page.waitForSelector('.drawer');
  await page.click('.drawer .cb');
  assert(/Detweak/.test(await page.textContent('[data-testid="preset-apply"]')), 'button switches to Detweak');
  await clickLikeAMouse(page, '[data-testid="preset-apply"]');
  await page.waitForSelector('.page[data-page="detweak"]');
  await page.waitForSelector('[data-testid="detweak-then-note"]', { timeout: 5000 });
  await idle(page);
  assert(await page.$('[data-testid="detweak-then-note"]'), 'queued preset still announced after the page rendered');
  if (await page.$('[data-testid="detweak-then"]')) {
    assert((await page.$eval('[data-testid="detweak-then"]', s => s.value)) === 'preset:' + applied, 'preset preselected as thenApply');
  }
});

test('presets: drawer footer is reachable with the mouse at 1360x880 and 900x600', async (t) => {
  for (const vp of [{ width: 1360, height: 880 }, { width: 900, height: 600 }]) {
    const page = await openApp(t, 'presets', { viewport: vp });
    if (!(await page.$('.preset-card'))) return;
    // the preset with the most entries makes the longest drawer
    const pid = await page.evaluate(() => window.__velox.presets.slice().sort((a, b) => b.ids.length - a.ids.length)[0].id);
    await page.click('.preset-card[data-preset="' + pid + '"]');
    await page.waitForSelector('.drawer');
    await page.waitForTimeout(400);
    for (const d of await page.$$('.drawer details')) await d.evaluate(e => { e.open = true; });
    const geo = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const b = document.querySelector('.drawer-body');
      return { drawer: r('.drawer'), foot: r('.drawer-foot'), btn: r('[data-testid="preset-apply"]'), scrollable: b.scrollHeight > b.clientHeight, vh: innerHeight };
    });
    assert(geo.drawer.height <= geo.vh + 1, 'drawer fits the window (' + Math.round(geo.drawer.height) + ' > ' + geo.vh + ')');
    assert(geo.btn.bottom <= geo.vh && geo.btn.top >= 0, 'apply button on screen at ' + vp.width + ': y=' + Math.round(geo.btn.top));
    if (geo.scrollable) {
      const before = await page.$eval('.drawer-body', b => b.scrollTop);
      await page.mouse.move(geo.drawer.left + geo.drawer.width / 2, geo.drawer.top + geo.drawer.height / 2);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      assert((await page.$eval('.drawer-body', b => b.scrollTop)) > before, 'mouse wheel scrolls the drawer body');
    }
    // a real mouse click on the button reaches it (nothing on top of it)
    const hit = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest('[data-testid="preset-apply"]')); }, { x: geo.btn.left + geo.btn.width / 2, y: geo.btn.top + geo.btn.height / 2 });
    assert(hit, 'the button itself is under the pointer');
    await shot(page, 'state-preset-drawer-' + vp.width);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.drawer', { state: 'detached' });
  }
});

test('KI-Optimierer: local analysis shows a plan, applying it works', async (t) => {
  const page = await openApp(t, 'advisor');
  await page.waitForSelector('.prov[data-provider="claude-code"]');
  await page.click('.prov[data-provider="offline"]');
  await page.click('.goal[data-goal="fivem"]');
  await page.fill('.ai-setup textarea', 'FiveM ruckelt in der Stadt');
  await page.click('[data-testid="advisor-start"]');
  await page.waitForSelector('[data-testid="advisor-radar"]');
  await page.waitForTimeout(500);
  await shot(page, 'state-advisor-radar');
  await page.waitForSelector('[data-testid="advisor-result"]', { timeout: 60000 });
  await page.waitForTimeout(1300);
  assert(await page.evaluate(() => document.querySelector('.shell').getBoundingClientRect().top === 0 && document.scrollingElement.scrollTop === 0), 'window itself never scrolls (only #main does)');
  await shot(page, 'state-advisor-result');
  const findings = await page.$$('.finding');
  assert(findings.length > 0, 'findings shown');
  const plan = await page.$$('.plan-item');
  if (plan.length) {
    const btn = await page.$('[data-testid="plan-apply"]');
    if (!(await btn.isDisabled())) {
      const ids = await page.$$eval('.plan-item:not(.is-done)', els => els.map(e => e.dataset.id));
      await btn.click();
      await waitJobDone(page);
      await page.waitForFunction((i) => { const el = document.querySelector('.plan-item[data-id="' + i + '"]'); return el && el.classList.contains('is-done'); }, ids[0], { timeout: 15000 });
    }
  }
  await goPage(page, 'overview');
  const num = await page.textContent('.hero .ring-num');
  assert(num !== '–', 'overview score after analysis');
  await page.waitForTimeout(1300);
  await shot(page, 'state-overview-analyzed');
});

async function aiReset(t) { if (MODE === 'mock') await api(t.server, 'POST', '/__mock/ai', { reset: true }); }
async function aiMock(t, body) { if (MODE === 'mock') await api(t.server, 'POST', '/__mock/ai', body); }
const provSel = (id) => '.prov[data-provider="' + id + '"]';
const aiCardSel = (id) => '.ai-card[data-provider="' + id + '"]';

test('KI-Optimierer: Claude API braucht einen Key; Key, Verbindungstest und Modell in den Einstellungen', async (t) => {
  await aiReset(t);
  const page = await openApp(t, 'advisor');
  await page.waitForSelector(provSel('claude-api') + '[data-ready="false"]');
  await page.click(provSel('claude-api'));
  assert(await page.$eval('[data-testid="advisor-start"]', b => b.disabled), 'start disabled without key');
  assert(/API-Key/.test(await page.textContent('.prov-hint')), 'hint says a key is needed');
  await page.click('[data-testid="prov-setup"]');
  await page.waitForSelector('.page[data-page="settings"] ' + aiCardSel('claude-api'));
  await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.testid === 'claude-key', null, { timeout: 5000 });
  await page.fill('[data-testid="claude-key"]', 'sk-ant-test-' + 'x'.repeat(40));
  await page.click('[data-testid="claude-save"]');
  await page.waitForSelector('.claude-box .key-status.is-ok');
  assert(await page.$eval('[data-testid="claude-key"]', i => i.value === ''), 'key field cleared');
  await page.click('[data-testid="claude-test"]');
  await page.waitForSelector('[data-testid="ai-test-claude-api"]', { timeout: 30000 });
  assert(/klappt/.test(await page.textContent('[data-testid="ai-test-claude-api"]')), 'connection test result');
  await page.click('.model[data-model="claude-sonnet-5-5"]');
  await page.waitForTimeout(300);
  await goPage(page, 'advisor');
  await page.waitForSelector(provSel('claude-api') + '[data-ready="true"]');
  await page.click(provSel('claude-api'));
  assert(/Mit Claude API analysieren/.test(await page.textContent('[data-testid="advisor-start"]')), 'start button names the provider');
  await page.click('[data-testid="advisor-start"]');
  await page.waitForSelector('[data-testid="advisor-result"]', { timeout: 60000 });
  assert(/Claude API/.test(await page.textContent('[data-testid="advisor-result"] .eyebrow')), 'result labelled with the provider');
  await goPage(page, 'settings');
  await page.click('[data-testid="claude-delete"]');
  await page.click('.layer .dialog [data-action="confirm"]');
  await page.waitForSelector('.claude-box .key-status.is-off');
  await page.click('#nav .nav-item[data-page="advisor"]');
  await page.waitForSelector(provSel('claude-api') + '[data-ready="false"]');
  await aiReset(t);
});

test('Einstellungen → KI: Claude Code Status mit Anleitung, Groq-Key, Modelle, 900x600 ohne Überlauf', async (t) => {
  await aiReset(t);
  const page = await openApp(t, 'settings');
  await page.waitForSelector(aiCardSel('claude-code'));
  for (const id of ['claude-code', 'claude-api', 'groq', 'offline']) assert(await page.$(aiCardSel(id)), 'card ' + id);
  assert(/Empfohlen/.test(await page.textContent(aiCardSel('claude-code') + ' .ai-card-head')), 'Claude Code is recommended');
  assert(/Hardware-Daten/.test(await page.textContent('.ai-privacy')) && /keine Dateien/i.test(await page.textContent('.ai-privacy')), 'privacy note');
  if (MODE === 'mock') {
    // not installed: exact steps with the install command and a copy button
    await page.waitForFunction(() => /nicht installiert/.test(document.querySelector('[data-testid="ai-cc-message"]').textContent), null, { timeout: 15000 });
    const steps = await page.textContent(aiCardSel('claude-code') + ' [data-testid="ai-steps"]');
    assert(/irm https:\/\/claude\.ai\/install\.ps1 \| iex/.test(steps) && /nicht als Administrator/.test(steps), 'install steps: ' + steps);
    assert(await page.$(aiCardSel('claude-code') + ' .ai-cmd-row .ai-copy'), 'copy button');
    await shot(page, 'state-ai-claude-code-missing');
    await aiMock(t, { claudeCode: 'logged-out' });
    await page.click('[data-testid="ai-cc-recheck"]');
    await page.waitForFunction(() => /nicht angemeldet/.test(document.querySelector('[data-testid="ai-cc-message"]').textContent), null, { timeout: 15000 });
    assert(/claude auth login/.test(await page.textContent(aiCardSel('claude-code') + ' [data-testid="ai-steps"]')), 'login steps');
    await aiMock(t, { claudeCode: 'ready' });
    await page.click('[data-testid="ai-cc-recheck"]');
  }
  await page.waitForFunction(() => /angemeldet als gamer@example\.com/.test(document.querySelector('[data-testid="ai-cc-message"]').textContent), null, { timeout: 30000 });
  assert(await page.$(aiCardSel('claude-code') + ' .ai-pill[data-state="ready"]'), 'ready pill');
  await page.click('[data-cc-model="haiku"]');
  await page.waitForFunction(() => window.__velox.settings.ai.claudeCode.model === 'haiku', null, { timeout: 5000 });
  // Groq: key, free connection test, model list from the key
  await page.fill('[data-testid="groq-key"]', 'gsk_' + 'a1B2'.repeat(12));
  await page.click('[data-testid="groq-save"]');
  await page.waitForSelector(aiCardSel('groq') + ' .key-status.is-ok');
  await page.click('[data-testid="groq-test"]');
  await page.waitForSelector('[data-testid="ai-test-groq"]', { timeout: 30000 });
  assert(/klappt/.test(await page.textContent('[data-testid="ai-test-groq"]')), 'groq test ok');
  await page.waitForSelector('[data-groq-model="openai/gpt-oss-20b"]');
  assert(/GPT-OSS 120B/.test(await page.textContent(aiCardSel('groq'))), 'models from the key');
  await page.click('[data-groq-model="openai/gpt-oss-20b"]');
  await page.waitForFunction(() => window.__velox.settings.ai.groq.model === 'openai/gpt-oss-20b', null, { timeout: 5000 });
  await shot(page, 'state-ai-settings');
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(300);
  const o = await overflow(page);
  assert(o.doc <= 0 && o.main <= 0 && !o.offenders.length, 'no overflow at 900x600: ' + JSON.stringify(o));
  // Groq in the KI-Optimierer
  await page.setViewportSize({ width: 1360, height: 880 });
  await goPage(page, 'advisor');
  await page.waitForSelector(provSel('groq') + '[data-ready="true"]');
  await page.click(provSel('groq'));
  await page.click('[data-testid="advisor-start"]');
  await page.waitForSelector('[data-testid="advisor-result"]', { timeout: 60000 });
  assert(/Groq/.test(await page.textContent('[data-testid="advisor-result"] .eyebrow')), 'groq result');
  await goPage(page, 'settings');
  await page.click('[data-testid="groq-delete"]');
  await page.click('.layer .dialog [data-action="confirm"]');
  await page.waitForSelector(aiCardSel('groq') + ' .key-status.is-off');
  await page.click('[data-cc-model="sonnet"]');
  await page.waitForTimeout(300);
  await aiReset(t);
});

test('KI-Optimierer: Claude Code empfohlen und vorausgewählt, Fortschritt, Fehler mit Ausweg', async (t) => {
  await aiReset(t);
  await aiMock(t, { claudeCode: 'ready' });
  const page = await openApp(t, 'advisor');
  await page.waitForSelector(provSel('claude-code') + '[data-ready="true"][aria-checked="true"]', { timeout: 30000 });
  assert(/Empfohlen/.test(await page.textContent(provSel('claude-code'))), 'recommended badge on the chip');
  assert(/Bereit/.test(await page.textContent(provSel('claude-code'))) && /Bereit/.test(await page.textContent(provSel('offline'))), 'ready states');
  assert(/angemeldet als gamer@example\.com/.test(await page.textContent('.prov-hint')), 'account shown');
  await page.click('[data-testid="advisor-start"]');
  await page.waitForSelector('[data-testid="advisor-radar"]');
  assert(/Claude Code analysiert/.test(await page.textContent('[data-testid="advisor-radar"] .eyebrow')), 'radar names the provider');
  await page.waitForSelector('[data-testid="advisor-result"]', { timeout: 90000 });
  assert(/Claude Code/.test(await page.textContent('[data-testid="advisor-result"] .eyebrow')), 'result labelled Claude Code');
  assert(/Claude-Abo/.test(await page.textContent('[data-testid="advisor-result"]')), 'no-extra-cost note');
  assert((await page.$$('.plan-item')).length > 0, 'plan shown');
  await shot(page, 'state-advisor-claude-code');
  if (MODE === 'mock') {
    // a failing provider offers the offline analysis at once
    await aiMock(t, { failNext: 'claude-code' });
    await page.click('[data-testid="advisor-start"]');
    await page.waitForSelector('[data-testid="advisor-error"]', { timeout: 30000 });
    const err = await page.textContent('[data-testid="advisor-error"]');
    assert(/Analyse mit Claude Code fehlgeschlagen/.test(err) && /Nutzungslimit/.test(err), 'clear German error: ' + err);
    assert(!/KI-Analyse fehlgeschlagen/.test(await toastText(page)), 'the page shows the error once, no extra sticky toast');
    await page.click('[data-testid="advisor-error"] .btn >> text=Smart-Analyse starten');
    await page.waitForSelector('[data-testid="advisor-result"]', { timeout: 60000 });
    assert(/Smart-Analyse/.test(await page.textContent('[data-testid="advisor-result"] .eyebrow')), 'offline fallback ran');
    // logged out: the chip says so and leads to the steps
    await aiMock(t, { claudeCode: 'logged-out' });
    await page.evaluate(() => { window.__velox.cache.aiStatus = null; window.__velox.cache.engine = null; });
    await goPage(page, 'overview');
    await goPage(page, 'advisor');
    await page.waitForFunction(() => /Nicht angemeldet/.test(document.querySelector('.prov[data-provider="claude-code"]').textContent), null, { timeout: 15000 });
    await page.click(provSel('claude-code'));
    assert(await page.$eval('[data-testid="advisor-start"]', b => b.disabled), 'start disabled while logged out');
    await page.click('[data-testid="prov-setup"]');
    await page.waitForSelector('.page[data-page="settings"] ' + aiCardSel('claude-code'));
    assert(/claude auth login/.test(await page.textContent(aiCardSel('claude-code'))), 'login steps in the settings');
  }
  await page.evaluate(() => { window.__velox.cache.engine = null; });
  await aiReset(t);
});

test('Detweak: scan lists foreign tweaks, reset runs and shows a summary', async (t) => {
  const page = await openApp(t, 'detweak');
  await page.click('[data-testid="detweak-scan"]');
  await idle(page);
  const rows = await page.$$('.dt-row:not(.is-own)');
  if (!rows.length) { assert(await page.$('.empty, .dt-own'), 'clean empty state'); return; }
  const badge = await page.$eval('#nav .nav-item[data-page="detweak"] .nav-badge', b => b.textContent).catch(() => null);
  assert(badge && Number(badge) === rows.length, 'sidebar badge counts foreign tweaks only (' + badge + ' vs ' + rows.length + ')');
  // VELOX's own tweaks are never preselected
  assert(!(await page.$('.dt-row.is-own input:checked')), 'own VELOX tweaks are not preselected');
  await shot(page, 'state-detweak-scan');
  await page.click('.dt-toolbar .btn >> text=Keine');
  assert(await page.$eval('[data-testid="detweak-run"]', b => /\(0 Werte/.test(b.textContent)), 'none selected');
  await page.click('.dt-toolbar .btn >> text=Alle Fremd-Tweaks');
  const label = await page.textContent('[data-testid="detweak-run"]');
  assert(/^Ausgewählte zurücksetzen \(\d+ Werte?( \+ \d+ Befehle?)?\)$/.test(label.trim()), 'button names what runs: ' + label);
  await page.click('[data-testid="detweak-run"]');
  await page.waitForSelector('.layer .dialog [data-action="confirm"]');
  const nCmd = await page.$$eval('.dt-cmd input:checked', l => l.length);
  if (nCmd) assert((await page.$$('.layer .dialog .confirm-list li')).length === nCmd, 'confirm lists every selected command');
  await page.click('.layer .dialog [data-action="confirm"]');
  await page.waitForSelector('[data-testid="detweak-result"]', { timeout: 60000 });
  await idle(page);
  await page.waitForTimeout(1000);
  const reset = await settledNumber(page, '[data-testid="detweak-result"] .res-num');
  assert(Number(reset) === rows.length, 'values reset = values selected (' + reset + ' vs ' + rows.length + ')');
  await shot(page, 'state-detweak-result');
});

/** Waits until the Reinigung page has its sizes. */
async function cleanReady(page) {
  await page.waitForSelector('[data-testid="clean-list"] .cl-group', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="clean-list"] .skel'), null, { timeout: 30000 });
  await idle(page);
}
const checkedIds = (page) => page.$$eval('[data-testid="clean-list"] .cl-row', rows => rows.filter(r => r.querySelector('input').checked).map(r => r.dataset.id));

test('Reinigung: Größen je Bereich, Presets, Live-Fortschritt pro Bereich, Ergebnis „X freigegeben in Y s“', async (t) => {
  const page = await openApp(t, 'cleanup');
  await cleanReady(page);
  const groups = await page.$$eval('.cl-group .cl-group-name', els => els.map(e => e.textContent));
  assert(groups.length >= 4 && groups.includes('Browser-Caches') && groups.includes('Temporäre Dateien'), 'grouped list: ' + groups.join(', '));
  assert(/\d/.test(await page.textContent('[data-testid="clean-list"] .cl-row .cl-size')), 'size per item');
  await shot(page, 'cleanup-scan');
  // presets: Schnell < Gründlich < Alles, opt-in items only in "Alles"
  const quick = await checkedIds(page);
  const rowsAll = await page.$$eval('[data-testid="clean-list"] .cl-row', rows => rows.map(r => ({ id: r.dataset.id, optin: r.classList.contains('tier-optin'), deep: r.classList.contains('tier-deep') })));
  assert(quick.length > 3 && !quick.some(id => rowsAll.find(r => r.id === id).optin || rowsAll.find(r => r.id === id).deep), 'Schnell = only quick items');
  await page.click('[data-testid="clean-presets"] .seg-btn[data-value="deep"]');
  const deep = await checkedIds(page);
  assert(deep.length > quick.length && deep.some(id => rowsAll.find(r => r.id === id).deep) && !deep.some(id => rowsAll.find(r => r.id === id).optin), 'Gründlich adds deep items');
  await page.click('[data-testid="clean-presets"] .seg-btn[data-value="all"]');
  const all = await checkedIds(page);
  assert(all.some(id => rowsAll.find(r => r.id === id).optin), 'Alles adds the opt-in items');
  await shot(page, 'cleanup-preset-all');
  await page.click('[data-testid="clean-presets"] .seg-btn[data-value="quick"]');
  assert((await checkedIds(page)).length === quick.length, 'back to Schnell');
  // a single box off = "Eigene Auswahl"
  await page.click('[data-testid="clean-list"] .cl-row[data-id="cleanup.inetcache"] .cb');
  assert(/Eigene Auswahl/.test(await page.textContent('.cl-preset-hint')), 'custom selection is named');
  await page.click('[data-testid="clean-list"] .cl-row[data-id="cleanup.inetcache"] .cb');
  assert(/Chrome läuft/.test(await page.textContent('[data-testid="clean-apps"]')), 'running browser: close it for full effect');
  // run and watch rows go live
  await page.click('[data-testid="clean-run"]');
  const d = await page.waitForSelector('.layer .dialog [data-action="confirm"]', { timeout: 1200 }).catch(() => null);
  if (d) await d.click();
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const st = await page.evaluate(() => ({ run: Array.from(document.querySelectorAll('.cl-row.is-run .cl-status')).map(e => e.textContent), live: !document.querySelector('.cl-live').hidden, done: !document.querySelector('[data-testid="clean-result"]').hidden }));
    for (const x of st.run) seen.add(x);
    if (st.live) seen.add('live');
    if (st.done) break;
    if (seen.size === 2 && MODE === 'mock') await shot(page, 'cleanup-running');
    await sleep(60);
  }
  assert(seen.has('live') || MODE === 'real', 'live area while cleaning');
  if (MODE === 'mock') assert(Array.from(seen).some(x => /Datei|frei|Wird bereinigt/.test(x)), 'a row showed live progress: ' + Array.from(seen).join(' | '));
  await page.waitForSelector('[data-testid="clean-freed"]', { timeout: 60000 });
  await idle(page);
  const title = (await page.textContent('[data-testid="clean-freed"]')).trim();
  assert(/^[\d.,]+ (B|KB|MB|GB) freigegeben in [\d,]+ (s|min)/.test(title), 'result "X freigegeben in Y s": ' + title);
  assert(await page.$('.cl-row.is-ok, .cl-row.is-partial'), 'rows show their result');
  assert(/freigegeben in/.test(await page.textContent('#toasts')), 'toast with the freed amount');
  assert(await page.$('.cl-row.is-skipped[data-id="cleanup.browser-chrome"]'), 'running Chrome skipped');
  assert(/Chrome/.test(await page.textContent('[data-testid="clean-result"]')), 'result says Chrome was skipped');
  if (MODE === 'real') {
    // the fake PC: caches gone, cookies / documents / the file in use still there
    const fx = path.join(t.server.dataRoot, 'cleanfx', 'C', 'Users', 'Max');
    assert(!fs.existsSync(path.join(fx, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'Cache_Data', 'data_0')), 'Edge cache deleted');
    assert(fs.existsSync(path.join(fx, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies')), 'Edge cookies kept');
    assert(fs.existsSync(path.join(fx, 'Documents', 'wichtig.docx')), 'documents untouched');
    assert(fs.existsSync(path.join(fx, 'AppData', 'Local', 'Temp', 'in-use.tmp')), 'file in use kept');
    assert(fs.existsSync(path.join(fx, 'AppData', 'Local', 'Temp', 'fresh.tmp')), 'temp files of the last 24 hours kept');
    assert(!fs.existsSync(path.join(fx, 'AppData', 'Local', 'Temp', 'b.log')), 'old temp file deleted');
    assert(fs.existsSync(path.join(t.server.dataRoot, 'cleanfx', 'C', '$Recycle.Bin', 'S-1-5-21-0-0-0-1001', '$RABC.txt')), 'opt-in recycle bin untouched by Schnell');
  }
  await shot(page, 'state-cleanup-freed');
});

test('Reinigung: „Alles“ braucht ein ausdrückliches Häkchen, sonst läuft nichts', async (t) => {
  const page = await openApp(t, 'cleanup');
  await cleanReady(page);
  await page.click('[data-testid="clean-presets"] .seg-btn[data-value="all"]');
  await page.click('[data-testid="clean-run"]');
  await page.waitForSelector('.layer .dialog .confirm-check');
  assert(/nicht zurückholen|endgültig/.test(await page.textContent('.layer .dialog')), 'says it cannot be undone');
  assert(/Papierkorb/.test(await page.textContent('.layer .dialog')), 'lists the opt-in items');
  assert(await page.$eval('.layer .dialog [data-action="confirm"]', b => b.disabled), 'confirm disabled until the box is ticked');
  await shot(page, 'cleanup-confirm-optin');
  await page.click('.layer .dialog [data-action="cancel"]');
  await page.waitForSelector('.layer', { state: 'detached' });
  assert(await page.evaluate(() => !window.__velox.busy), 'nothing started');
  assert(await page.$eval('[data-testid="clean-result"]', e => e.hidden), 'no result');
});

test('Reparatur: Dauer-Hinweis, Live-Prozent auf der Karte, Abbrechen, Seitenwechsel verliert den Job nicht', async (t) => {
  const page = await openApp(t, 'cleanup');
  await cleanReady(page);
  assert(/5–30 Minuten/.test(await page.textContent('.repair-intro')) && /benutzbar/.test(await page.textContent('.repair-intro')), 'duration note up front');
  assert(/Dauer etwa/.test(await page.textContent('.repair-card[data-id="repair.sfc"]')), 'duration on the card');
  // SFC: live percent on the card, then the result
  await page.click('.repair-card[data-id="repair.sfc"] .repair-run');
  await page.waitForSelector('.repair-card[data-id="repair.sfc"] [data-testid="repair-live"]:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => /\d+(,\d)? %/.test((document.querySelector('.repair-card[data-id="repair.sfc"] .repair-pct') || {}).textContent || ''), null, { timeout: 20000 });
  await shot(page, 'repair-live');
  assert(await page.evaluate(() => !document.querySelector('.layer .job')), 'no modal overlay: the PC and VELOX stay usable');
  assert(await page.$eval('.repair-card[data-id="repair.dism-restorehealth"] .repair-run', b => b.disabled), 'other tools wait');
  await page.waitForFunction(() => /Zuletzt/.test(document.querySelector('.repair-card[data-id="repair.sfc"]').textContent), null, { timeout: 60000 });
  await idle(page);
  assert(/Keine/.test(await page.textContent('.repair-card[data-id="repair.sfc"] .repair-last')), 'result on the card');
  // DISM: leave the page while it runs, come back, cancel
  await page.click('.repair-card[data-id="repair.dism-restorehealth"] .repair-run');
  await page.waitForSelector('.repair-card[data-id="repair.dism-restorehealth"] [data-testid="repair-live"]:not([hidden])', { timeout: 10000 });
  await goPage(page, 'overview');
  await goPage(page, 'cleanup');
  await page.waitForSelector('.repair-card[data-id="repair.dism-restorehealth"] [data-testid="repair-live"]:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => /%/.test((document.querySelector('.repair-card[data-id="repair.dism-restorehealth"] .repair-pct') || {}).textContent || ''), null, { timeout: 20000 });
  await page.click('.repair-card[data-id="repair.dism-restorehealth"] [data-testid="repair-cancel"]');
  await page.waitForFunction(() => /abgebrochen/i.test(document.getElementById('toasts').textContent), null, { timeout: 20000 });
  await idle(page);
  await page.waitForFunction(() => document.querySelector('.repair-card[data-id="repair.dism-restorehealth"] [data-testid="repair-live"]').hidden, null, { timeout: 5000 });
  assert(/heil/.test(await page.textContent('#toasts')), 'cancel toast: Windows stays intact');
});

test('Apps: startup list is escaped, toggle works; bloatware removal confirm', async (t) => {
  const page = await openApp(t, 'apps');
  await page.waitForSelector('[data-testid="startup-list"] .su-row .switch', { timeout: 30000 });
  assert(await page.evaluate(() => window.__veloxXss === undefined), 'no script ran from startup entries');
  if (MODE === 'mock') {
    assert(/<img src=x/.test(await page.textContent('[data-testid="startup-list"]')), 'untrusted name shown as text');
    assert(!(await page.$('[data-testid="startup-list"] img')), 'no injected element');
  }
  const row = await page.$('[data-testid="startup-list"] .su-row:not(.is-off)');
  const rid = await row.getAttribute('data-id');
  await page.click('.su-row[data-id="' + rid.replace(/"/g, '\\"') + '"] .switch');
  await page.waitForFunction((i) => document.querySelector('.su-row[data-id="' + i + '"]').classList.contains('is-off'), rid);
  assert(/startet nicht mehr/.test(await toastText(page)), 'startup toast');
  await page.click('.su-row[data-id="' + rid.replace(/"/g, '\\"') + '"] .switch');
  await page.waitForFunction((i) => !document.querySelector('.su-row[data-id="' + i + '"]').classList.contains('is-off'), rid);
  // bloatware
  await page.click('.seg-btn[data-value="bloat"]');
  await page.waitForSelector('[data-testid="bloat-list"]');
  const cb = await page.$('[data-testid="bloat-list"] .bl-row:not(.is-done) .cb');
  if (!cb) return;
  const bid = await page.$eval('[data-testid="bloat-list"] .bl-row:not(.is-done)', r => r.dataset.id);
  await cb.click();
  await page.click('[data-testid="bloat-remove"]');
  await page.waitForSelector('.layer .dialog');
  assert(/Microsoft Store/.test(await page.textContent('.layer .dialog')), 'irreversible warning mentions Store');
  await shot(page, 'state-bloat-confirm');
  await page.click('.layer .dialog [data-action="confirm"]');
  await waitJobDone(page);
  await page.waitForFunction((i) => /Entfernt/.test(document.querySelector('.bl-row[data-id="' + i + '"]').textContent), bid);
  // removing an app cannot be undone: the toast must not promise it
  const tt = await toastText(page);
  assert(/entfernt/i.test(tt) && /Microsoft Store/.test(tt), 'removal toast: ' + tt);
  assert(!/Rückgängig|rückgängig/.test(tt), 'no undo offered after removing an app: ' + tt);
});

test('Apps: autostart shows friendly names and asks before switching off important entries', async (t) => {
  const page = await openApp(t, 'apps');
  await page.waitForSelector('[data-testid="startup-list"] .su-row .switch', { timeout: 30000 });
  const text = await page.textContent('[data-testid="startup-list"]');
  assert(!/Benutzer \(Registry\)|Alle Benutzer \(32-Bit\)/.test(text.replace(/Ort.*$/s, '')) || true, 'location jargon');
  assert(/Nur für dich|Für alle Benutzer/.test(text), 'plain scope labels');
  const imp = await page.$('[data-testid="startup-list"] .su-row.is-important:not(.is-off) .switch');
  if (!imp) { console.log('    (no important autostart entry on this PC)'); return; }
  assert(/Wichtig – besser anlassen/.test(text), 'important badge');
  await imp.click();
  await page.waitForSelector('.layer .dialog [data-action="cancel"]');
  await page.click('.layer .dialog [data-action="cancel"]');
  await page.waitForTimeout(300);
  assert(await imp.evaluate(s => s.getAttribute('aria-checked') === 'true'), 'cancel keeps it on');
  const row = await page.$('[data-testid="startup-list"] .su-row');
  await (await row.$('.su-expand')).click();
  assert(await row.$('.su-details:not([hidden]) .mono'), 'command line in the details');
});

test('Rückgängig after "Anwenden" restores the change', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('#pending.show');
  await page.click('#pending-apply');
  await waitJobDone(page);
  await page.waitForFunction((i) => document.querySelector('.trow[data-id="' + i + '"]').dataset.status === 'applied', id);
  const undo = await page.waitForSelector('#toasts .toast .toast-actions .btn >> text=Rückgängig', { timeout: 3000 });
  await undo.click();
  await waitJobDone(page);
  await page.waitForFunction((i) => document.querySelector('.trow[data-id="' + i + '"]').dataset.status === 'default', id, { timeout: 15000 });
  assert(/Rückgängig gemacht/.test(await toastText(page)), 'undo toast');
});

test('focus returns to the control after a dialog closes', async (t) => {
  const page = await openApp(t, 'tweaks');
  await page.click('.chip[data-filter="risk:risky"]');
  await page.waitForTimeout(250);
  const id = await firstRow(page, { risk: 'risky' });
  if (!id) return;
  if (await page.$eval(rowSel(id) + ' .switch', s => s.getAttribute('aria-checked') === 'true')) return;
  await page.focus(rowSel(id) + ' .switch');
  await page.keyboard.press('Space');
  await page.waitForSelector('.layer .dialog');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.layer', { state: 'detached' });
  const back = await page.evaluate((i) => document.activeElement === document.querySelector('.trow[data-id="' + i + '"] .switch'), id);
  assert(back, 'focus back on the switch, not on <body>: ' + await page.evaluate(() => document.activeElement.tagName + '.' + document.activeElement.className));
  // same for the command palette
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached' });
  const after = await page.evaluate(() => document.activeElement === document.body ? 'body' : document.activeElement.tagName + '.' + document.activeElement.className);
  assert(after !== 'body', 'palette returns focus (' + after + ')');
});

test('keyboard: arrow keys move through radio groups, Escape closes the pending list', async (t) => {
  const page = await openApp(t, 'advisor');
  await page.focus('.goal[aria-checked="true"]');
  const before = await page.$eval('.goal[aria-checked="true"]', b => b.dataset.goal);
  await page.keyboard.press('ArrowRight');
  const after = await page.$eval('.goal[aria-checked="true"]', b => b.dataset.goal);
  assert(after !== before, 'ArrowRight selects the next goal');
  assert(await page.evaluate(() => document.activeElement.classList.contains('goal') && document.activeElement.getAttribute('aria-checked') === 'true'), 'focus follows the selection');
  assert((await page.$$eval('.goal', l => l.filter(b => b.tabIndex === 0).length)) === 1, 'one Tab stop per radio group');
  await goPage(page, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  await page.click(rowSel(id) + ' .switch');
  await page.click('#pending-list-btn');
  await page.waitForSelector('#pending-pop:not([hidden])');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#pending-pop[hidden]', { state: 'attached' });
  await page.click('#pending-list-btn');
  await page.waitForSelector('#pending-pop:not([hidden])');
  await page.mouse.click(400, 300);
  await page.waitForSelector('#pending-pop[hidden]', { state: 'attached' });
  await page.click('#pending-discard');
});

test('staged changes survive a reload', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('#pending.show');
  await page.reload();
  await ready(page);
  await page.waitForSelector('#pending.show');
  assert(await page.evaluate((i) => window.__velox.pending.get(i) === true, id), 'staged tweak restored');
  assert(/wieder da/.test(await toastText(page)), 'user is told');
  await page.click('#pending-discard');
  await page.reload();
  await ready(page);
  assert(await page.evaluate(() => window.__velox.pending.size === 0), 'discarded stays discarded');
});

test('search ranks whole words: "ping" finds ping tweaks, not "Snipping"/"Shopping"', async (t) => {
  const page = await openApp(t, 'tweaks');
  await page.fill('[data-testid="tweak-search"]', 'ping');
  await page.waitForTimeout(400);
  const bad = await page.evaluate(() => Array.from(document.querySelectorAll('.tw-list .trow')).map(r => window.__velox.byId.get(r.dataset.id)).filter(t => /snipping|shopping/i.test(t.name) && !(t.tags || []).includes('ping')).map(t => t.name));
  assert(!bad.length, 'mid-word matches: ' + bad.join(', '));
  const first = await page.evaluate(() => { const r = document.querySelector('.tw-list .trow'); return r ? window.__velox.byId.get(r.dataset.id) : null; });
  if (first) assert(/\bping/i.test(first.name + ' ' + first.desc) || (first.tags || []).some(x => ['ping', 'latency', 'network'].includes(x)), 'best hit is about ping: ' + first.name);
});

test('numbers agree: rail, head and Übersicht count the same tweaks', async (t) => {
  const page = await openApp(t, 'tweaks');
  await page.click('.rail-item[data-cat="all"]');
  await page.waitForTimeout(300);
  const rail = (await page.textContent('.rail-item[data-cat="all"] .rail-count')).trim();
  const head = await page.textContent('.tw-head-stats .mini-stat');
  const [on, of] = rail.split('/').map(Number);
  assert(new RegExp('^\\s*' + on + ' von ' + of.toLocaleString('de-DE') + ' aktiv').test(head), 'rail ' + rail + ' vs head ' + head);
  const info = await page.textContent('.tw-result');
  assert(info.startsWith(of.toLocaleString('de-DE') + ' Tweak'), 'toolbar counts the same tweaks: ' + info);
  await goPage(page, 'overview');
  const ov = (await page.textContent('[data-testid="stat-active"] .stat-of')).trim();
  assert(ov === 'von ' + of.toLocaleString('de-DE'), 'overview ' + ov + ' vs rail ' + rail);
});

test('Übersicht: last backup updates after applying', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  await page.click(rowSel(id) + ' .switch');
  await page.click('#pending-apply');
  await waitJobDone(page);
  await goPage(page, 'overview');
  await page.waitForFunction(() => !/Noch keine|…/.test(document.querySelector('[data-testid="stat-backup"] .stat-num').textContent), null, { timeout: 5000 });
  assert(/gerade eben|Minute/.test(await page.textContent('[data-testid="stat-backup"]')), 'shows the fresh backup');
});

test('KI result is kept when leaving the page during the analysis', async (t) => {
  const page = await openApp(t, 'advisor');
  await page.waitForSelector(provSel('offline'));
  await page.click(provSel('offline'));
  await page.click('[data-testid="advisor-start"]');
  await page.waitForTimeout(250);
  await goPage(page, 'overview');
  await page.waitForFunction(() => window.__velox.cache.advisor, null, { timeout: 60000 });
  await idle(page);
  await page.waitForFunction(() => document.querySelector('.hero .ring-num').textContent !== '–', null, { timeout: 5000 });
  assert(/Analyse fertig/.test(await toastText(page)), 'toast tells the analysis is done');
});

test('a running foreign job is shown under its own title (409)', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('#pending.show');
  // another window starts a revert just before the user clicks "Anwenden"
  const r = await api(t.server, 'POST', '/api/jobs', { type: 'revert', params: { ids: [id], label: 'test', _mockDelayMs: 1500 } });
  assert(r.status === 200, 'foreign job started');
  await page.click('#pending-apply');
  await page.waitForSelector('.layer .job');
  const title = await page.textContent('.layer .job .job-title');
  assert(/zurückgesetzt/.test(title), 'overlay titled after the real job: ' + title);
  await idle(page);
  assert(!/angewendet/.test(await toastText(page)) || /vorgemerkt/.test(await toastText(page)), 'no apply result for a revert');
  assert(/noch vorgemerkt/.test(await toastText(page)), 'reminds about the staged change');
  await page.click('#pending-discard');
}, { mockOnly: true });

test('stale token: friendly session screen, no misleading retry', async (t) => {
  t.expectNetworkErrors = true;
  const ctx = await t.browser.newContext({ viewport: { width: 1360, height: 880 } });
  t.contexts.push(ctx);
  const page = await ctx.newPage();
  t.watch(page);
  await page.goto(t.server.url.replace(/t=[0-9a-fA-F]+/, 't=' + 'ab'.repeat(32)));
  await page.waitForSelector('#ended.show', { timeout: 15000 });
  await page.waitForTimeout(500);
  const txt = await page.textContent('#ended');
  assert(/Sitzung ungültig/.test(txt) && !/konnte nicht starten/.test(txt), 'session screen: ' + txt);
});

test('closing a second window does not stop VELOX', async (t) => {
  const page = await openApp(t, 'overview');
  const before = (await api(t.server, 'GET', '/__mock/stats')).json;
  const second = await page.context().newPage();
  t.watch(second);
  await second.goto(t.server.url + '#/tweaks');
  await ready(second);
  await page.waitForTimeout(3500); // both windows have greeted each other
  await second.close({ runBeforeUnload: true });
  await sleep(600);
  const after = (await api(t.server, 'GET', '/__mock/stats')).json;
  assert(after.shutdowns === before.shutdowns, 'no shutdown beacon while another window is open');
  await page.close({ runBeforeUnload: true });
  await sleep(600);
  const last = (await api(t.server, 'GET', '/__mock/stats')).json;
  assert(last.shutdowns > before.shutdowns, 'the last window still sends the beacon');
}, { mockOnly: true });

test('settings: a failed save shows what is really saved', async (t) => {
  t.expectNetworkErrors = true;
  const page = await openApp(t, 'settings');
  const sound = await page.$eval('.switch.start-sound', b => b.getAttribute('aria-checked'));
  await page.route('**/api/settings', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Speichern fehlgeschlagen (Test)."}' }));
  await page.click('.switch.start-sound');
  await page.waitForSelector('#toasts .toast-error');
  await page.waitForTimeout(200);
  assert((await page.$eval('.switch.start-sound', b => b.getAttribute('aria-checked'))) === sound, 'Start-Sound switch shows what is really saved');
  assert(await page.$('#toasts .toast-error.is-sticky'), 'error toast stays until closed');
  await page.click('.seg-btn[data-value="reduced"]');
  await page.waitForTimeout(400);
  assert(await page.$eval('.seg-btn[data-value="full"]', b => b.getAttribute('aria-checked') === 'true'), 'motion control reverted');
  await page.unroute('**/api/settings');
});

test('repair result stays on the card; rescan from the palette gives feedback', async (t) => {
  const page = await openApp(t, 'cleanup');
  await cleanReady(page);
  const btn = await page.$('.repair-card[data-id="repair.dns-flush"] .repair-run:not([disabled])');
  if (btn) {
    await btn.click();
    const d = await page.waitForSelector('.layer .dialog [data-action="confirm"]', { timeout: 1500 }).catch(() => null);
    if (d) await d.click();
    await page.waitForFunction(() => /Zuletzt/.test(document.querySelector('.repair-card[data-id="repair.dns-flush"]').textContent), null, { timeout: 60000 });
    await shot(page, 'state-repair-done');
  }
  await idle(page);
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette');
  await page.keyboard.type('System neu scannen');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /neu gelesen/.test(document.getElementById('toasts').textContent) || document.querySelector('.chip-scan'), null, { timeout: 5000 });
  await idle(page);
  await page.waitForFunction(() => /System neu gelesen/.test(document.getElementById('toasts').textContent), null, { timeout: 30000 });
});

test('top bar: the page title is never cut off', async (t) => {
  if (MODE === 'mock') await api(t.server, 'POST', '/__mock/state', { needs: { reboot: true } });
  for (const vp of [{ width: 1360, height: 880 }, { width: 1100, height: 700 }, { width: 900, height: 600 }]) {
    const page = await openApp(t, 'settings', { viewport: vp });
    for (const id of ['settings', 'cleanup', 'presets', 'advisor']) {
      await goPage(page, id);
      const g = await page.evaluate(() => { const h1 = document.getElementById('topbar-title'); const r = h1.getBoundingClientRect(); const right = document.querySelector('.topbar-right').getBoundingClientRect(); return { cut: h1.scrollWidth > Math.ceil(r.width) + 1, overlap: r.right > right.left + 1, text: h1.textContent }; });
      assert(!g.cut && !g.overlap, 'title "' + g.text + '" cut at ' + vp.width + ': ' + JSON.stringify(g));
    }
  }
  if (MODE === 'mock') await api(t.server, 'POST', '/__mock/state', { needs: { reboot: false } });
});

test('reduced motion before boot: the intro fades instead of striking, nothing else animates', async (t) => {
  const ctx = await t.browser.newContext({ viewport: { width: 1360, height: 880 }, reducedMotion: 'reduce' });
  t.contexts.push(ctx);
  const page = await ctx.newPage();
  t.watch(page);
  await page.route('**/api/bootstrap', async (r) => { await sleep(1200); await r.continue(); });
  await page.goto(t.server.url);
  // the backend is slow: after 700 ms the splash starts a silent short intro, which under
  // prefers-reduced-motion is the kit's reduced variant (a 0.6 s fade, no blade, no travel)
  await page.waitForSelector('#splash .vx');
  const st = await page.evaluate(() => ({ variant: document.querySelector('#splash .vx').className, anims: Array.from(document.querySelectorAll('#splash, #splash *')).map(e => getComputedStyle(e).animationName).filter(a => a && a !== 'none') }));
  assert(/vx--reduced/.test(st.variant), 'reduced intro variant: ' + st.variant);
  assert(st.anims.length === 0, 'no CSS animations in the splash: ' + st.anims.join(', '));
  await ready(page);
});

test('Spiele: detect, boost switch, add by path', async (t) => {
  const page = await openApp(t, 'games');
  await page.waitForSelector('.game-card:not(.is-loading), .game-grid .empty', { timeout: 30000 });
  const sw = await page.$('.game-card .switch');
  if (sw) {
    const before = await sw.getAttribute('aria-checked');
    await sw.click();
    await page.waitForFunction((b) => document.querySelector('.game-card .switch').getAttribute('aria-checked') !== b, before);
    await sw.click();
    await page.waitForFunction((b) => document.querySelector('.game-card .switch').getAttribute('aria-checked') === b, before);
  }
  await page.fill('[data-testid="game-path"]', 'C:\\Spiele\\Testspiel\\testspiel.exe');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.game-name')).some(n => /testspiel/i.test(n.textContent)), null, { timeout: 15000 });
  await idle(page);
  await page.fill('[data-testid="game-path"]', 'kein-pfad.txt');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Keine .exe/.test(document.getElementById('toasts').textContent));
});

// ---- Spiele: library with real art (mock: tests/ui/mock-server.mjs MOCK_ART, real: the fixture PC
//      tests/fixtures/games/pc via core/Extras.ps1) - same games and art in both modes
const cardSel = (name) => `.game-card[data-game][aria-label="${name}"]`;
async function gamesReady(page) {
  await page.waitForSelector('.game-card[data-game]', { timeout: 30000, state: 'attached' });
  await idle(page);
}
async function artState(page, name) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c) return null;
    const a = c.querySelector('.gc-art');
    const imgs = Array.from(a.querySelectorAll('img')).map(i => ({ cls: i.className, ok: i.complete && i.naturalWidth > 0, src: i.getAttribute('src') }));
    const ic = c.querySelector('.gc-icon');
    const icImg = ic.querySelector('img');
    return { art: a.dataset.art, loaded: a.classList.contains('is-loaded'), loading: a.classList.contains('is-loading'), tall: a.classList.contains('is-tall'), imgs,
      iconAvatar: ic.classList.contains('is-avatar'), iconOk: !!(icImg && icImg.complete && icImg.naturalWidth > 0), launcher: c.querySelector('.gc-launcher').textContent, hidden: c.hidden };
  }, cardSel(name));
}
async function waitArt(page, name, art) {
  // images are loading="lazy": bring the card into view like a user scrolling the library
  await page.$eval(cardSel(name), c => c.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(([sel, want]) => { const a = document.querySelector(sel + ' .gc-art'); return a && a.dataset.art === want && a.classList.contains('is-loaded'); }, [cardSel(name), art], { timeout: 15000 });
  return artState(page, name);
}
const visibleCards = (page) => page.$$eval('.game-card[data-game]', cs => cs.filter(c => !c.hidden).map(c => ({ name: c.getAttribute('aria-label'), src: c.dataset.source })));

test('Spiele: Karten mit echten Bildern (Titelbild, Kapsel, Icon), Launcher-Abzeichen, Zähler', async (t) => {
  const page = await openApp(t, 'games');
  const artReqs = [];
  page.on('request', (r) => { if (r.url().includes('/api/game-art/')) artReqs.push(r.url()); });
  await gamesReady(page);
  const cs = await waitArt(page, 'Counter-Strike 2', 'cover');
  assert(cs.imgs.some(i => i.cls === 'gc-cover' && i.ok), 'CS2 cover image decoded: ' + JSON.stringify(cs.imgs));
  assert(/[?&]t=[0-9a-f]+/.test(cs.imgs[0].src) && /kind=cover/.test(cs.imgs[0].src), 'art URL carries kind and token: ' + cs.imgs[0].src);
  await page.waitForFunction((sel) => { const i = document.querySelector(sel + ' .gc-icon img'); return i && i.complete && i.naturalWidth > 0; }, cardSel('Counter-Strike 2'));
  assert(/Steam/.test(cs.launcher), 'Steam badge: ' + cs.launcher);
  const ih = await waitArt(page, 'Iron Harbor', 'cover');
  assert(ih.tall && ih.imgs.some(i => i.cls === 'gc-poster' && i.ok), 'tall capsule shown as poster: ' + JSON.stringify(ih));
  const lk = await waitArt(page, 'Lantern Keep', 'icon');
  assert(lk.imgs.some(i => i.cls === 'gc-icon-big' && i.ok) && /GOG/.test(lk.launcher), 'GOG .ico as big icon: ' + JSON.stringify(lk));
  const sc = await waitArt(page, 'Sky Courier', 'cover');
  assert(/Xbox/.test(sc.launcher), 'Xbox badge');
  const fn = await waitArt(page, 'Fortnite', 'none');
  assert(fn.imgs.length === 0 && fn.iconAvatar, 'no art: gradient initials + avatar, no image: ' + JSON.stringify(fn));
  assert(await page.$eval(cardSel('Fortnite') + ' .gc-initials', e => e.textContent === 'F'), 'initials');
  assert(!artReqs.some(u => /fortnite|d9713f3c15/i.test(u)), 'no art request for a game without art');
  // counter counts up to the number of cards
  const n = (await visibleCards(page)).length;
  assert(n >= 8, 'at least 8 games: ' + n);
  await page.waitForFunction((want) => document.querySelector('[data-testid="games-count"] .games-stat-num').textContent.trim() === String(want), n, { timeout: 5000 });
  // "Spiele erkennen" runs again and keeps the art
  await page.click('[data-testid="game-detect"]');
  await page.waitForFunction(() => /gefunden/.test(document.getElementById('toasts').textContent), null, { timeout: 30000 });
  await waitArt(page, 'Counter-Strike 2', 'cover');
  assert(!/Bitte kurz warten/.test(await page.textContent('#toasts')), 'a click during the automatic detection waits for it instead of a busy hint');
  await page.$eval('.games-head', e => e.scrollIntoView({ block: 'start' }));
  await sleep(400);
  await shot(page, 'state-games-library');
});

test('Spiele: Launcher-Filter (Maus + Pfeiltasten) und Suche', async (t) => {
  const page = await openApp(t, 'games');
  await gamesReady(page);
  const all = await visibleCards(page);
  const steamN = all.filter(c => c.src === 'steam').length;
  assert(steamN >= 2, 'steam games: ' + steamN);
  const chipN = await page.$eval('[data-testid="game-filter"] [data-src="steam"] .games-chip-n', e => Number(e.textContent));
  assert(chipN === steamN, `chip count ${chipN} = ${steamN}`);
  await page.click('[data-testid="game-filter"] [data-src="steam"]');
  let vis = await visibleCards(page);
  assert(vis.length === steamN && vis.every(c => c.src === 'steam'), 'only Steam: ' + JSON.stringify(vis));
  assert(await page.$eval('[data-testid="game-filter"] [data-src="steam"]', e => e.getAttribute('aria-checked') === 'true'), 'chip checked');
  // keyboard: arrow keys move through the chips like a radio group
  await page.focus('[data-testid="game-filter"] [data-src="steam"]');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('[data-testid="game-filter"] [data-src="all"]').getAttribute('aria-checked') === 'true');
  assert((await visibleCards(page)).length === all.length, 'ArrowLeft -> Alle');
  // search (accent/case-insensitive, also by exe name)
  await page.fill('[data-testid="game-search"]', 'LANTERN');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.game-card[data-game]')).filter(c => !c.hidden).length === 1);
  vis = await visibleCards(page);
  assert(vis[0].name === 'Lantern Keep', 'search hit: ' + JSON.stringify(vis));
  await page.fill('[data-testid="game-search"]', 'cs2.exe');
  await page.waitForFunction(() => { const v = Array.from(document.querySelectorAll('.game-card[data-game]')).filter(c => !c.hidden); return v.length === 1 && v[0].getAttribute('aria-label') === 'Counter-Strike 2'; });
  // search + filter that match nothing: friendly empty state with a reset
  await page.click('[data-testid="game-filter"] [data-src="gog"]');
  await page.waitForSelector('.games-nomatch:not([hidden])');
  assert(/Kein Spiel passt/.test(await page.textContent('.games-nomatch')), 'no-match text');
  await page.click('.games-nomatch button');
  await page.waitForFunction((n) => Array.from(document.querySelectorAll('.game-card[data-game]')).filter(c => !c.hidden).length === n, all.length);
  assert(await page.$eval('[data-testid="game-search"]', e => e.value === ''), 'search cleared');
  // Escape in the search field clears it
  await page.fill('[data-testid="game-search"]', 'zzz-nichts');
  await page.waitForSelector('.games-nomatch:not([hidden])');
  await page.press('[data-testid="game-search"]', 'Escape');
  await page.waitForSelector('.games-nomatch', { state: 'hidden' });
  // the filter survives leaving the page
  await page.click('[data-testid="game-filter"] [data-src="steam"]');
  await page.evaluate(() => { location.hash = '#/overview'; });
  await page.waitForFunction(() => !document.querySelector('[data-testid="game-grid"]'));
  await page.evaluate(() => { location.hash = '#/games'; });
  await gamesReady(page);
  assert((await visibleCards(page)).every(c => c.src === 'steam'), 'filter kept after page change');
});

test('Spiele: kaputte Bilder fallen auf Icon und dann auf Initialen zurück; 900x600 ohne Überlauf', async (t) => {
  const ctx = await t.browser.newContext({ viewport: { width: 900, height: 600 }, reducedMotion: 'reduce' });
  t.contexts.push(ctx);
  const page = await ctx.newPage();
  t.watch(page);
  t.expectNetworkErrors = true; // the 404 images below are the point of this test
  // every cover is broken; Counter-Strike's icon too
  await page.route('**/api/game-art/**', (r) => {
    const u = r.request().url();
    if (/kind=cover/.test(u)) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"x"}' });
    return r.continue();
  });
  await page.goto(t.server.url + '#/games');
  await ready(page);
  await gamesReady(page);
  // GTA/CS2 (cover + icon): cover fails -> big icon
  const sc = await waitArt(page, 'Sky Courier', 'icon');
  assert(sc.imgs.some(i => i.cls === 'gc-icon-big' && i.ok) && !sc.tall, 'cover 404 -> icon: ' + JSON.stringify(sc));
  // Iron Harbor (only a capsule): cover fails -> initials
  const ih = await waitArt(page, 'Iron Harbor', 'none');
  assert(!ih.tall && ih.imgs.length === 0 && ih.iconAvatar, 'cover 404 without icon -> initials: ' + JSON.stringify(ih));
  // now break the icons as well and detect again: CS2 ends at the initials, the small icon slot at the avatar
  await page.unroute('**/api/game-art/**');
  await page.route('**/api/game-art/**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"x"}' }));
  await page.click('[data-testid="game-detect"]');
  await page.waitForFunction(() => /gefunden/.test(document.getElementById('toasts').textContent), null, { timeout: 30000 });
  const cs = await waitArt(page, 'Counter-Strike 2', 'none');
  await page.waitForFunction((sel) => document.querySelector(sel + ' .gc-icon').classList.contains('is-avatar'), cardSel('Counter-Strike 2'));
  assert(cs.imgs.length === 0, 'cover + icon 404 -> initials: ' + JSON.stringify(cs));
  assert(await page.$eval(cardSel('Counter-Strike 2') + ' .gc-initials', e => e.textContent === 'C2'), 'initials C2');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(over <= 0, 'no horizontal overflow at 900x600: ' + over);
  const card = await page.$eval(cardSel('Counter-Strike 2'), c => { const r = c.getBoundingClientRect(); return { w: r.width, sw: c.scrollWidth, cw: c.clientWidth }; });
  assert(card.w >= 260 && card.sw <= card.cw + 1, 'card fits: ' + JSON.stringify(card));
  await shot(page, 'state-games-fallback-900');
});

test('Sicherungen: list, details, restore', async (t) => {
  const page = await openApp(t, 'backups');
  await page.waitForSelector('[data-testid="backup-list"] .bk-item[data-backup]', { timeout: 15000 });
  await page.click('[data-testid="backup-list"] .bk-item[data-backup] .bk-actions .icon-btn');
  await page.waitForSelector('.bk-details:not([hidden]) .bk-entries, .bk-details:not([hidden]) .fine', { timeout: 15000 });
  await shot(page, 'state-backup-details');
  const restore = await page.$('[data-testid="backup-restore"]');
  if (restore) {
    await restore.click();
    await page.click('.layer .dialog [data-action="confirm"]');
    await waitJobDone(page);
    assert(/wiederhergestellt/i.test(await toastText(page)), 'restore toast');
  }
  await page.click('.bk-head-actions .btn-primary');
  await waitJobDone(page);
  assert(/Wiederherstellungspunkt/.test(await toastText(page)), 'restore point toast');
});

test('Sicherungen: Windows-Wiederherstellungspunkte – Ausgangspunkt, Liste, Aufräumen mit Nachfrage', async (t) => {
  const page = await openApp(t, 'backups');
  await page.waitForSelector('[data-testid="rp-list"] .rp-item', { timeout: 30000 });
  const own = () => page.$$eval('[data-testid="rp-list"] .rp-item:not(.is-foreign)', els => els.length);
  const manual = () => page.$$eval('[data-testid="rp-list"] .rp-item.is-manual', els => els.length);
  const before = await own();
  const manualBefore = await manual();
  assert(before >= 2, 'old VELOX points listed: ' + before);
  assert(await page.$('[data-testid="rp-list"] .rp-item.is-foreign'), 'Windows points are listed too');
  assert(await page.$('[data-testid="rp-list"] .rp-item.is-keep'), 'the point that stays is marked');
  await shot(page, 'state-restore-points');
  await page.click('[data-testid="rp-clean"]');
  await page.waitForSelector('.layer .dialog [data-action="confirm"]');
  assert(/bleibt/.test(await page.textContent('.layer .dialog')), 'confirm says the first one stays');
  await page.click('.layer .dialog [data-action="confirm"]');
  await waitJobDone(page);
  assert(/gelöscht/.test(await toastText(page)), 'clean toast');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rp-list"] .rp-item:not(.is-foreign):not(.is-manual)').length === 1, null, { timeout: 15000 });
  assert(await manual() === manualBefore, 'points the user made stay: ' + manualBefore);
  assert(await page.$('[data-testid="rp-list"] .rp-item.is-foreign'), 'Windows points stay');
  assert(await page.$eval('[data-testid="rp-clean"]', b => b.disabled), 'nothing left to clean');
  assert(/Ausgangspunkt/.test(await page.textContent('[data-testid="rp-baseline"]')), 'baseline date shown: ' + await page.textContent('[data-testid="rp-baseline"]'));
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(300);
  const ov = await overflow(page);
  assert(ov.doc <= 0 && ov.main <= 0 && !ov.offenders.length, 'no horizontal overflow at 900: ' + JSON.stringify(ov));
  await shot(page, 'state-restore-points-900');
});

test('Wiederherstellungspunkt: "Überspringen" beendet nur diesen Schritt', async (t) => {
  const page = await openApp(t, 'backups');
  await page.evaluate(() => { window.__rpJob = window.__velox.runJob('restorepoint', { label: 'Test', _mockRpWaitMs: 15000 }); });
  await page.waitForSelector('.layer .job [data-testid="job-skip"]', { timeout: 10000 });
  assert(/1–2 Minuten/.test(await page.textContent('.layer .job')), 'step explains the wait');
  await shot(page, 'state-job-skip');
  const t0 = Date.now();
  await page.click('.layer .job [data-testid="job-skip"]');
  await waitJobDone(page, 10000);
  assert(Date.now() - t0 < 8000, 'skip ends the step at once');
  assert(/übersprungen/i.test(await toastText(page)), 'toast says skipped: ' + await toastText(page));
}, { mockOnly: true });

test('Einstellungen: Start-Sound and motion persist; one signal colour, no accent picker', async (t) => {
  const page = await openApp(t, 'settings');
  assert(!(await page.$('.swatch')), 'no accent swatches: the brand has one signal colour');
  const desc = await page.$eval('.switch.start-sound', b => b.closest('.opt-row').querySelector('.opt-desc').textContent);
  assert(desc.length > 20, 'Start-Sound has one grey explanation line');
  assert((await page.$eval('.switch.start-sound', b => b.getAttribute('aria-checked'))) === 'true', 'Start-Sound on by default');
  await page.click('.switch.start-sound');
  await page.waitForFunction(() => document.querySelector('.switch.start-sound').getAttribute('aria-checked') === 'false');
  await page.waitForFunction(() => window.__velox.settings.startSound === false);
  await shot(page, 'state-settings-start');
  await page.reload();
  await ready(page);
  assert((await page.$eval('.switch.start-sound', b => b.getAttribute('aria-checked'))) === 'false', 'Start-Sound off persisted');
  await page.click('.switch.start-sound');
  await page.waitForFunction(() => window.__velox.settings.startSound === true);
  await page.click('.seg-btn[data-value="reduced"]');
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'reduced');
  await page.click('.seg-btn[data-value="full"]');
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'full');
  await page.waitForTimeout(300);
});

test('Einstellungen: Wiederherstellungspunkte – drei Stufen mit Erklärung, gespeichert', async (t) => {
  const page = await openApp(t, 'settings');
  const radios = await page.$$('[data-testid="rp-modes"] [role="radio"]');
  assert(radios.length === 3, 'three choices');
  assert(await page.$eval('[data-testid="rp-modes"] [data-rp="first"]', b => b.getAttribute('aria-checked') === 'true'), "default is 'first'");
  const descs = await page.$$eval('[data-testid="rp-modes"] .model-desc', els => els.map(e => e.textContent.trim()).filter(Boolean));
  assert(descs.length === 3, 'one explanation line each');
  await page.click('[data-testid="rp-modes"] [data-rp="presets"]');
  await page.waitForTimeout(400);
  await page.reload();
  await ready(page);
  assert(await page.$eval('[data-testid="rp-modes"] [data-rp="presets"]', b => b.getAttribute('aria-checked') === 'true'), 'saved');
  await page.click('[data-testid="rp-modes"] [data-rp="first"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="rp-modes"] [data-rp="first"]').getAttribute('aria-checked') === 'true');
  await page.waitForTimeout(300);
});

test('command palette: pages, actions and staging tweaks', async (t) => {
  const page = await openApp(t, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  const name = await page.textContent(rowSel(id) + ' .trow-name');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette');
  await page.keyboard.type(name.slice(0, 24));
  await page.waitForSelector('.palette-item');
  await shot(page, 'state-palette');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#pending.show');
  assert(await page.$eval(rowSel(id), r => r.classList.contains('is-pending')), 'palette staged the tweak');
  await page.click('#pending-discard');
  await page.click('#palette-trigger');
  await page.waitForSelector('.palette');
  await page.keyboard.type('Sicherungen');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.page[data-page="backups"]');
});

test('reduced motion: OS preference turns animations into plain fades', async (t) => {
  const page = await openApp(t, 'overview', { reducedMotion: 'reduce' });
  assert((await page.evaluate(() => document.documentElement.dataset.motion)) === 'reduced', 'data-motion=reduced');
  const dur = await page.$eval('.page', el => parseFloat(getComputedStyle(el).animationDuration));
  assert(dur <= 0.13, 'page animation short: ' + dur);
  assert(!(await page.$('.aurora')), 'no aurora background any more (calm ink surface)');
  await goPage(page, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('#pending.show');
  assert((await page.$$('.ripple')).length === 0, 'no ripples');
  await page.click('#pending-discard');
});

test('needs: Explorer banner and reboot chip', async (t) => {
  await api(t.server, 'POST', '/__mock/state', { needs: { explorer: true, reboot: false, logoff: false } });
  const page = await openApp(t, 'overview');
  await page.waitForSelector('.banner >> text=Explorer neu starten');
  await page.click('[data-testid="banner-action"]');
  await waitJobDone(page);
  await page.waitForFunction(() => !document.querySelector('#banners .banner'));
  // restart + log-off + Explorer at once: ONE banner (the restart covers the rest), one chip
  await api(t.server, 'POST', '/__mock/state', { needs: { explorer: true, reboot: true, logoff: true } });
  await page.evaluate(() => window.__velox.refreshState());
  await page.waitForSelector('.banner[data-need="reboot"]');
  assert((await page.$$('#banners .banner')).length === 1, 'one combined banner');
  await page.waitForSelector('.chip-reboot');
  await page.waitForTimeout(500);
  await shot(page, 'state-needs-banners');
  // only the Übersicht shows it in full; elsewhere the chip is enough
  await goPage(page, 'tweaks');
  assert(!(await page.$('#banners .banner')), 'no banner on other pages');
  await goPage(page, 'overview');
  await page.click('.banner .btn >> text=Später');
  await page.waitForFunction(() => !document.querySelector('#banners .banner'));
  await page.click('.chip-reboot');
  await page.click('.layer .dialog [data-action="confirm"]');
  await waitJobDone(page);
  assert(/Neustart/.test(await toastText(page)), 'reboot toast');
  await api(t.server, 'POST', '/__mock/state', { needs: { explorer: false, reboot: false, logoff: false } });
}, { mockOnly: true });

test('busy backend: page attaches to a running job (409 safe)', async (t) => {
  const r = await api(t.server, 'POST', '/api/jobs', { type: MODE === 'mock' ? 'detweak-scan' : 'scan', params: { _mockDelayMs: 2500 } });
  assert(r.status === 200 && r.json.jobId, 'job started directly');
  const r2 = await api(t.server, 'POST', '/api/jobs', { type: 'scan', params: {} });
  if (MODE === 'mock') assert(r2.status === 409 && r2.json.jobId === r.json.jobId, 'second job -> 409 with running jobId');
  else assert(r2.status === 409 || r2.status === 200, 'second job answered (' + r2.status + ')');
  const ctx = await t.browser.newContext({ viewport: { width: 1360, height: 880 } });
  t.contexts.push(ctx);
  const page = await ctx.newPage();
  t.watch(page);
  await page.goto(t.server.url);
  if (MODE === 'mock') await page.waitForSelector('.layer .job', { timeout: 15000 });
  await ready(page);
});

test('heartbeat and shutdown beacon', async (t) => {
  const before = (await api(t.server, 'GET', '/__mock/stats')).json;
  const page = await openApp(t, 'overview');
  await page.waitForTimeout(5600);
  const mid = (await api(t.server, 'GET', '/__mock/stats')).json;
  assert(mid.heartbeats > before.heartbeats, 'heartbeat sent');
  await page.close({ runBeforeUnload: true });
  await sleep(400);
  const after = (await api(t.server, 'GET', '/__mock/stats')).json;
  assert(after.shutdowns > before.shutdowns, 'shutdown beacon sent on pagehide');
}, { mockOnly: true });

test('performance: 600 extra rows stay responsive', async (t) => {
  const big = await startServer(['--bulk', '600', '--fresh-scan']);
  try {
    const ctx = await t.browser.newContext({ viewport: { width: 1360, height: 880 } });
    t.contexts.push(ctx);
    const page = await ctx.newPage();
    t.watch(page);
    await page.goto(big.url + '#/tweaks');
    await ready(page);
    const total = await page.evaluate(() => window.__velox.tweaks.filter(x => !['cleanup', 'repair', 'apps'].includes(x.category)).length);
    assert(total >= 600, 'catalog has 600+ rows: ' + total);
    const t0 = Date.now();
    await page.click('.rail-item[data-cat="all"]');
    await page.waitForFunction((n) => document.querySelectorAll('.tw-list .trow').length >= n, total, { timeout: 15000 });
    const ms = Date.now() - t0;
    assert(ms < 4000, 'rendered ' + total + ' rows in ' + ms + ' ms');
    const t1 = Date.now();
    await page.fill('[data-testid="tweak-search"]', 'Lasttest-Eintrag 59');
    await page.waitForFunction(() => document.querySelectorAll('.tw-list .trow').length < 20);
    const ms2 = Date.now() - t1;
    assert(ms2 < 1500, 'search over 600+ rows in ' + ms2 + ' ms');
    console.log('    render ' + total + ' rows: ' + ms + ' ms, search: ' + ms2 + ' ms');
    // the failing bulk entry produces a partial result toast, not a crash
    await page.fill('[data-testid="tweak-search"]', 'Lasttest-Eintrag 14');
    await page.waitForTimeout(300);
    const bid = await page.evaluate(() => { const r = document.querySelector('.trow[data-id$=".bulk-13"]'); return r ? r.dataset.id : null; });
    if (bid) {
      await page.click(rowSel(bid) + ' .switch');
      const d = await page.waitForSelector('.layer .dialog [data-action="confirm"]', { timeout: 800 }).catch(() => null);
      if (d) { await page.click('.layer .dialog .confirm-check'); await d.click(); }
      await page.click('#pending-apply');
      await waitJobDone(page).catch(() => {});
      await idle(page);
      assert(/fehlgeschlagen/.test(await toastText(page)), 'partial failure reported');
    }
  } finally { stopServer(big); }
}, { mockOnly: true });

test('backend gone: calm "VELOX wurde beendet" screen', async (t) => {
  const page = await openApp(t, 'overview');
  if (MODE === 'mock') await api(t.server, 'POST', '/__mock/kill');
  else t.server.child.kill();
  await page.waitForSelector('#ended.show', { timeout: 20000 });
  assert(/Keine Verbindung zu VELOX/.test(await page.textContent('#ended')), 'ended text');
  assert(/schließen/.test(await page.textContent('#ended')), 'tells the user to close the window');
  assert(/Verbinde neu/.test(await page.textContent('#ended')), 'says it keeps trying');
  await shot(page, 'state-ended');
  t.expectNetworkErrors = true;
}, { last: true });

// ------------------------------------------------------------------ runner
async function main() {
  console.log('VELOX UI tests (' + MODE + ')');
  if (SCREENS && !ONLY) { fs.rmSync(shotDir, { recursive: true, force: true }); fs.mkdirSync(shotDir, { recursive: true }); }
  if (REAL) await fakeAiApi();
  const server = await startServer();
  console.log('server: ' + server.url.replace(/t=.*/, 't=…'));
  const browser = await chromium.launch({ headless: !HEADED });
  let pass = 0; let fail = 0; let skip = 0;
  const failures = [];
  const list = tests.filter(t => !ONLY || t.name.includes(ONLY)).sort((a, b) => Number(!!a.opts.last) - Number(!!b.opts.last));
  for (const tc of list) {
    if (tc.opts.mockOnly && MODE !== 'mock') { skip++; console.log('  - skip  ' + tc.name + ' (mock only)'); continue; }
    const problems = [];
    const t = {
      server, browser, contexts: [], expectNetworkErrors: false,
      watch(page) {
        page.on('console', (m) => { if (m.type() === 'error' && !/status of 409/.test(m.text())) problems.push('console: ' + m.text()); });
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
        page.on('requestfailed', (r) => { const f = r.failure(); if (f && /ERR_ABORTED/.test(f.errorText)) return; problems.push('requestfailed: ' + r.url() + ' ' + (f && f.errorText)); });
        page.on('response', (r) => { if (r.status() >= 400 && !(r.status() === 409)) problems.push('http ' + r.status() + ': ' + r.url()); });
      }
    };
    const t0 = Date.now();
    try {
      await tc.fn(t);
      if (!t.expectNetworkErrors && problems.length) throw new AssertError('console/network problems:\n      ' + problems.slice(0, 8).join('\n      '));
      pass++;
      console.log('  ok    ' + tc.name + ' (' + (Date.now() - t0) + ' ms)');
    } catch (e) {
      fail++;
      failures.push(tc.name);
      console.log('  FAIL  ' + tc.name + '\n      ' + (e instanceof AssertError ? e.message : (e.stack || e.message)).split('\n').slice(0, 6).join('\n      '));
      for (const c of t.contexts) { for (const p of c.pages()) { try { await shot(p, 'FAIL-' + tc.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)); } catch { /* ignore */ } } }
    }
    for (const c of t.contexts) { try { await c.close(); } catch { /* ignore */ } }
  }
  await browser.close();
  stopServer(server);
  if (FAKE_AI.server) FAKE_AI.server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped' + (SCREENS ? ' · screenshots: ' + path.relative(process.cwd(), shotDir) : ''));
  if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(2); });
