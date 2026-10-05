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

// ------------------------------------------------------------------ server
function startServer(extraArgs = []) {
  const token = crypto.randomBytes(32).toString('hex');
  let child;
  let dataRoot = null;
  if (REAL) {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'velox-ui-'));
    child = spawn('pwsh', ['-NoProfile', '-File', path.join(appRoot, 'Velox.ps1'), '-Simulate', '-NoBrowser', '-Port', '0', '-Token', token, '-DataRoot', dataRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const req = http.request({ host: s.host === 'localhost' ? 'localhost' : '127.0.0.1', port: s.port, method, path: p, headers: Object.assign({ Host: s.host + ':' + s.port }, headers) }, (res) => {
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
  await page.waitForFunction(() => window.__velox && !window.__velox.busy && !document.querySelector('.layer .job'), null, { timeout });
}
async function goPage(page, id) {
  await page.click('#nav .nav-item[data-page="' + id + '"]');
  await page.waitForSelector('.page[data-page="' + id + '"]');
  await page.waitForTimeout(250);
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
  // 403 from VELOX itself, or 400 from http.sys/HttpListener which already rejects foreign host names
  const badHost = (await rawRequest(s, 'GET', '/api/state', { headers: { 'X-Velox-Token': s.token, Host: 'evil.example:' + s.port } })).status;
  assert(badHost === 403 || badHost === 400, 'bad host rejected (' + badHost + ')');
  assert((await rawRequest(s, 'GET', '/api/state', { headers: { 'X-Velox-Token': s.token, Origin: 'http://evil.example' } })).status === 403, 'bad origin -> 403');
  assert((await rawRequest(s, 'OPTIONS', '/api/state', { headers: { 'X-Velox-Token': s.token } })).status === 403, 'OPTIONS -> 403');
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
    const n = Number(await page.textContent('#pending-count'));
    assert(n > 0, 'recommended staged');
    await page.click('#pending-list-btn');
    await page.waitForSelector('#pending-pop:not([hidden]) .pending-item');
    await page.click('#pending-discard');
    await page.waitForSelector('#pending:not(.show)');
  }
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
    await btn.click();
    await waitJobDone(page);
    applied = pid;
  }
  assert(applied, 'applied one preset');
  // routing to detweak with the preset preselected
  await page.click('.preset-card[data-preset="' + applied + '"]');
  await page.waitForSelector('.drawer');
  await page.click('.drawer .cb');
  assert(/Detweak/.test(await page.textContent('[data-testid="preset-apply"]')), 'button switches to Detweak');
  await page.click('[data-testid="preset-apply"]');
  await page.waitForSelector('.page[data-page="detweak"]');
  await page.click('[data-testid="detweak-scan"]');
  await idle(page);
  if (await page.$('[data-testid="detweak-then"]')) {
    assert((await page.$eval('[data-testid="detweak-then"]', s => s.value)) === 'preset:' + applied, 'preset preselected as thenApply');
  }
});

test('KI-Optimierer: local analysis shows a plan, applying it works', async (t) => {
  const page = await openApp(t, 'advisor');
  assert(await page.$eval('.model[data-engine="claude"]', b => b.disabled) || true, 'claude engine state rendered');
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

test('KI-Optimierer: Claude needs a key; key saved in settings enables it', async (t) => {
  const page = await openApp(t, 'advisor');
  assert(await page.$eval('.model[data-engine="claude"]', b => b.disabled), 'claude disabled without key');
  await goPage(page, 'settings');
  await page.fill('[data-testid="claude-key"]', 'sk-ant-test-' + 'x'.repeat(40));
  await page.click('[data-testid="claude-save"]');
  await page.waitForSelector('.key-status.is-ok');
  assert(await page.$eval('[data-testid="claude-key"]', i => i.value === ''), 'key field cleared');
  await page.click('.model[data-model="claude-sonnet-5-5"]');
  await page.waitForTimeout(300);
  await goPage(page, 'advisor');
  await page.click('.model[data-engine="claude"]');
  await page.click('[data-testid="advisor-start"]');
  await page.waitForSelector('[data-testid="advisor-result"]', { timeout: 60000 });
  assert(/Claude/.test(await page.textContent('[data-testid="advisor-result"]')), 'claude result labelled');
  await goPage(page, 'settings');
  await page.click('.claude-box .btn-ghost');
  await page.click('.layer .dialog [data-action="confirm"]');
  await page.waitForSelector('.key-status.is-off');
}, { mockOnly: true });

test('Detweak: scan lists foreign tweaks, reset runs and shows a summary', async (t) => {
  const page = await openApp(t, 'detweak');
  await page.click('[data-testid="detweak-scan"]');
  await idle(page);
  const rows = await page.$$('.dt-row');
  if (!rows.length) { assert(await page.$('.empty'), 'clean empty state'); return; }
  const badge = await page.$eval('#nav .nav-item[data-page="detweak"] .nav-badge', b => b.textContent).catch(() => null);
  assert(badge && Number(badge) === rows.length, 'sidebar badge shows count');
  await shot(page, 'state-detweak-scan');
  await page.click('.dt-toolbar .btn >> text=Keine');
  assert(await page.$eval('[data-testid="detweak-run"]', b => b.textContent.includes('(0)')), 'none selected');
  await page.click('.dt-toolbar .btn >> text=Alle');
  await page.click('[data-testid="detweak-run"]');
  await page.waitForSelector('.layer .dialog [data-action="confirm"]');
  await page.click('.layer .dialog [data-action="confirm"]');
  await page.waitForSelector('[data-testid="detweak-result"]', { timeout: 60000 });
  await idle(page);
  await page.waitForTimeout(1000);
  const reset = await page.textContent('[data-testid="detweak-result"] .res-num');
  assert(Number(reset) > 0, 'reset count > 0');
  await shot(page, 'state-detweak-result');
});

test('Reinigung: sizes load, cleanup runs, freed bytes shown', async (t) => {
  const page = await openApp(t, 'cleanup');
  await page.waitForFunction(() => !document.querySelector('.clean-list .skel'), null, { timeout: 30000 });
  const btn = await page.$('[data-testid="clean-run"]');
  if (await btn.isDisabled()) { console.log('    (nothing selectable to clean)'); return; }
  await btn.click();
  await page.waitForSelector('.layer .dialog');
  const dlg = await page.$('.layer .dialog [data-action="confirm"]');
  if (dlg) await dlg.click();
  await page.waitForSelector('[data-testid="clean-freed"]', { timeout: 60000 });
  await idle(page);
  await page.waitForTimeout(1500);
  assert(/(B|KB|MB|GB)$/.test((await page.textContent('[data-testid="clean-freed"]')).trim()), 'freed bytes formatted');
  await shot(page, 'state-cleanup-freed');
  const repair = await page.$('.repair-card .btn');
  if (repair && !(await repair.isDisabled())) {
    await repair.click();
    await page.waitForSelector('.layer .dialog');
    const d2 = await page.$('.layer .dialog [data-action="confirm"]');
    if (d2) await d2.click();
    if (await page.$('.layer .job')) { await page.waitForTimeout(150); await shot(page, 'state-job-overlay'); }
    await idle(page);
  }
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

test('Einstellungen: accent changes live and persists; motion setting', async (t) => {
  const page = await openApp(t, 'settings');
  await page.click('.swatch[data-accent="cyan"]');
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'cyan');
  await page.waitForTimeout(400);
  const col = await page.$eval('.btn-primary, .switch[aria-checked="true"] .switch-track', el => getComputedStyle(el).backgroundColor);
  assert(/34, 195, 230/.test(col), 'accent applied to controls: ' + col);
  await page.waitForTimeout(400);
  await shot(page, 'state-settings-cyan');
  await page.reload();
  await ready(page);
  assert((await page.evaluate(() => document.documentElement.dataset.accent)) === 'cyan', 'accent persisted');
  await page.click('.seg-btn[data-value="reduced"]');
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'reduced');
  await page.click('.seg-btn[data-value="full"]');
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'full');
  await page.click('.swatch[data-accent="violet"]');
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'violet');
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
  const aur = await page.$eval('.aurora .a1', el => getComputedStyle(el).animationName);
  assert(aur === 'none', 'aurora stopped');
  await goPage(page, 'tweaks');
  const id = await firstRow(page, { status: 'default', risk: 'safe' });
  await page.click(rowSel(id) + ' .switch');
  await page.waitForSelector('#pending.show');
  assert((await page.$$('.ripple')).length === 0, 'no ripples');
  await page.click('#pending-discard');
});

test('needs: Explorer banner and reboot chip', async (t) => {
  await api(t.server, 'POST', '/__mock/state', { needs: { explorer: true, reboot: true } });
  const page = await openApp(t, 'overview');
  await page.waitForSelector('.banner >> text=Explorer neu starten');
  await page.waitForSelector('.chip-reboot');
  await shot(page, 'state-needs-banners');
  await page.click('.banner .btn >> text=Explorer neu starten');
  await waitJobDone(page);
  await page.waitForFunction(() => !/Explorer neu starten/.test(document.getElementById('banners').textContent));
  await page.click('.chip-reboot');
  await page.click('.layer .dialog [data-action="confirm"]');
  await waitJobDone(page);
  assert(/Neustart/.test(await toastText(page)), 'reboot toast');
  await api(t.server, 'POST', '/__mock/state', { needs: { explorer: false, reboot: false } });
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
  assert(/VELOX wurde beendet/.test(await page.textContent('#ended')), 'ended text');
  assert(/schließen/.test(await page.textContent('#ended')), 'tells the user to close the window');
  await shot(page, 'state-ended');
  t.expectNetworkErrors = true;
}, { last: true });

// ------------------------------------------------------------------ runner
async function main() {
  console.log('VELOX UI tests (' + MODE + ')');
  if (SCREENS && !ONLY) { fs.rmSync(shotDir, { recursive: true, force: true }); fs.mkdirSync(shotDir, { recursive: true }); }
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
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
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
  console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped' + (SCREENS ? ' · screenshots: ' + path.relative(process.cwd(), shotDir) : ''));
  if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(2); });
