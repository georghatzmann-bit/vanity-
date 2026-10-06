// VELOX front end entry: app state (ctx), router, sidebar, top bar, staged changes,
// job runner with progress overlay, needs banners, command palette, splash and "ended" screens.
import { api, request, initToken, hasToken, on as onApi, pollJob, startHeartbeat, waitForBackend } from './api.js';
import { icon } from './icons.js';
import {
  h, clear, $, $$, toast, jobOverlay, confirmDialog, installEffects, countUp, plural, burst,
  viewTransition, openLayer, reducedMotion, overlayOpen, spinner, button, startHint
} from './ui.js';
import { tweakScore, textScore } from './search.js';
import { splash } from './splash.js';

import overview from './pages/overview.js';
import tweaks from './pages/tweaks.js';
import presets from './pages/presets.js';
import advisor from './pages/advisor.js';
import detweak from './pages/detweak.js';
import games from './pages/games.js';
import cleanup from './pages/cleanup.js';
import apps from './pages/apps.js';
import backups from './pages/backups.js';
import settings from './pages/settings.js';

const PAGES = [overview, tweaks, presets, advisor, detweak, games, cleanup, apps, backups, settings];
const PAGE_BY_ID = new Map(PAGES.map(p => [p.id, p]));
const root = document.documentElement;
const SCAN_FRESH_MS = 30 * 60 * 1000;

// Per job type: overlay title/icon, whether it can be cancelled, whether it changes the system.
// fail: toast title when the job fails (plain German, no "<title> – fehlgeschlagen" grammar).
const JOB_META = {
  scan: { title: 'System wird analysiert', fail: 'Systemanalyse fehlgeschlagen', icon: 'cpu', cancel: true },
  apply: { title: 'Tweaks werden angewendet', fail: 'Anwenden fehlgeschlagen', icon: 'bolt', cancel: true, mutating: true },
  revert: { title: 'Tweaks werden zurückgesetzt', fail: 'Zurücksetzen fehlgeschlagen', icon: 'undo', cancel: true, mutating: true },
  restorepoint: { title: 'Wiederherstellungspunkt wird erstellt', fail: 'Wiederherstellungspunkt fehlgeschlagen', icon: 'shieldCheck', mutating: true },
  restore: { title: 'Sicherung wird wiederhergestellt', fail: 'Wiederherstellen fehlgeschlagen', icon: 'history', cancel: true, mutating: true },
  'detweak-scan': { title: 'Suche nach Fremd-Tweaks', fail: 'Detweak-Scan fehlgeschlagen', icon: 'search', cancel: true },
  detweak: { title: 'Detweak läuft', fail: 'Detweak fehlgeschlagen', icon: 'undo', cancel: true, mutating: true },
  advisor: { title: 'Smart-Analyse', fail: 'Smart-Analyse fehlgeschlagen', icon: 'brain', cancel: true },
  claude: { title: 'Claude analysiert dein System', fail: 'Claude-Analyse fehlgeschlagen', icon: 'brain', cancel: true },
  ai: { title: 'KI analysiert dein System', fail: 'KI-Analyse fehlgeschlagen', icon: 'brain', cancel: true },
  'ai-status': { title: 'KI-Anbieter werden geprüft', fail: 'KI-Prüfung fehlgeschlagen', icon: 'sparkles', cancel: true },
  'clean-scan': { title: 'Speicherplatz wird gemessen', fail: 'Messen fehlgeschlagen', icon: 'broom', cancel: true },
  'run-action': { title: 'Wird ausgeführt', fail: 'Ausführen fehlgeschlagen', icon: 'broom', cancel: true, mutating: true },
  'startup-list': { title: 'Autostart wird gelesen', fail: 'Autostart nicht lesbar', icon: 'package' },
  'startup-set': { title: 'Autostart wird geändert', fail: 'Autostart nicht geändert', icon: 'package', mutating: true },
  'games-detect': { title: 'Spiele werden gesucht', fail: 'Spielesuche fehlgeschlagen', icon: 'gamepad', cancel: true },
  'game-boost': { title: 'Spiel-Boost wird gesetzt', fail: 'Spiel-Boost nicht gesetzt', icon: 'gamepad', mutating: true },
  'pick-file': { title: 'Datei auswählen', fail: 'Dateiauswahl fehlgeschlagen', icon: 'file' },
  'explorer-restart': { title: 'Explorer wird neu gestartet', fail: 'Explorer-Neustart fehlgeschlagen', icon: 'refresh', mutating: true },
  reboot: { title: 'Neustart wird vorbereitet', fail: 'Neustart nicht geplant', icon: 'restart', mutating: true },
  'restorepoint-list': { title: 'Wiederherstellungspunkte werden gelesen', fail: 'Wiederherstellungspunkte nicht lesbar', icon: 'shieldCheck', cancel: true },
  'restorepoint-clean': { title: 'Alte Wiederherstellungspunkte werden gelöscht', fail: 'Löschen fehlgeschlagen', icon: 'trash', cancel: true, mutating: true }
};

/** "0,4 s", "2,4 s", "27 s", "1:05 min" - how long a job took (result.durationMs). */
function fmtDuration(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return '';
  const s = n / 1000;
  if (s < 10) return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.max(0.1, s)) + ' s';
  if (s < 60) return Math.round(s) + ' s';
  const m = Math.floor(s / 60); const r = Math.round(s - m * 60);
  return m + ':' + String(r).padStart(2, '0') + ' min';
}
/** " in 2,4 s" for a toast or summary line, '' when the backend did not say. */
function inDuration(r) {
  const ms = r && typeof r.durationMs === 'number' ? r.durationMs : null;
  return ms === null ? '' : ' in ' + fmtDuration(ms);
}
const failTitle = (type) => (JOB_META[type] || {}).fail || 'Aufgabe fehlgeschlagen';

// ------------------------------------------------------------------ context
const bus = new Map();
const ctx = {
  app: { name: 'VELOX', version: '' }, mode: {}, categories: [], tweaks: [], byId: new Map(), catById: new Map(), presets: [],
  settings: {}, state: { statuses: {}, profile: null, lastScan: null, needs: {} },
  pending: new Map(),
  cache: { advisor: null, detweak: null, clean: null, startup: null, games: null, backups: null, goal: null, detweakCount: null },
  busy: null,
  scanning: false,
  // > 0 while the UI re-reads state or catalog after a job (busy is already null then, but the
  // pages are about to re-render); the UI tests wait for 0 before they touch anything
  settling: 0,
  page: null,
  on(evt, fn) { if (!bus.has(evt)) bus.set(evt, new Set()); bus.get(evt).add(fn); return () => bus.get(evt).delete(fn); },
  emit(evt, data) { for (const fn of Array.from(bus.get(evt) || [])) { try { fn(data); } catch (e) { console.error(e); } } },
  navigate, runJob, stage, stageMany, unstage, clearPending, applyPending, refreshState, reloadCatalog, saveSettings, openPalette,
  undoBackups, detweakLine, successLine, needsSuffix, friendlyError, rescan: () => initialScan(false, true),
  status(id) { return ctx.state.statuses[id] || (ctx.byId.get(id) && ctx.byId.get(id).applicable === false ? 'na' : 'unknown'); },
  applicable(t) { if (typeof t === 'string') t = ctx.byId.get(t); return !!t && t.applicable !== false && ctx.status(t.id) !== 'na'; },
  isApplied(id) { return ctx.status(id) === 'applied'; },
  effective(id) { return ctx.pending.has(id) ? ctx.pending.get(id) : ctx.isApplied(id); },
  catName(id) { const c = ctx.catById.get(id); return c ? c.name : id; },
  toggles() { return ctx.tweaks.filter(t => (t.kind || 'toggle') === 'toggle'); },
  /** The one definition of "how many tweaks" used on every page: toggles that fit this PC. */
  countable(filter) { return ctx.toggles().filter(t => ctx.applicable(t) && (!filter || filter(t))); },
  /** True when every result belongs to an app removal (cannot be undone). */
  onlyRemovals(ids) { return ids.length > 0 && ids.every(id => (ctx.byId.get(id) || {}).kind === 'remove'); },
  /** Runs fn now, or as soon as the running job has finished. */
  whenIdle(fn) {
    if (!ctx.busy) { fn(); return; }
    const off = ctx.on('busy', (b) => { if (!b) { off(); setTimeout(fn, 0); } });
  }
};
window.__velox = ctx; // handy for debugging in the Edge dev tools; holds no secrets
ctx.splash = splash;   // tests + dev tools: splash.info (variant, hosted, sound)

// ------------------------------------------------------------------ theme
const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
// One identity, one signal colour (brand/): settings.accent of older versions is kept in
// settings.json but no longer applied.
function applyTheme() {
  root.dataset.motion = (ctx.settings.motion === 'reduced' || mqReduced.matches) ? 'reduced' : 'full';
}
mqReduced.addEventListener('change', applyTheme);

// ------------------------------------------------------------------ boot
async function boot() {
  installEffects();
  // the splash covers the app: keyboard focus must not wander into the controls behind it
  $('#app').setAttribute('inert', '');
  $('#app').setAttribute('data-splash', '');
  if (!initToken() && !hasToken()) { showEnded('token'); return; }
  splash.early();
  onApi('lost', () => showEnded('lost'));
  onApi('unauthorized', () => showEnded('token'));
  buildShell();
  let data;
  try {
    data = await api.bootstrap();
  } catch (e) {
    if (e.status === 0) { showEnded('lost'); return; }
    // 401: the "Sitzung ungültig" screen is already up (unauthorized listener) - keep it.
    if (e.status === 401 || ended) return;
    showBootError(e.message);
    return;
  }
  ingest(data);
  splash.configure(data, (partial) => saveSettings(partial, { silent: true }));
  restorePending();
  applyTheme();
  renderNav();
  renderChips();
  renderBanners();
  $('#brand-ver').textContent = ctx.app.version || '';
  root.classList.add('ready');
  window.addEventListener('hashchange', route);
  route();
  startHeartbeat((busy) => { ctx.backendBusy = busy || null; });

  // Backend: busy is a boolean plus activeJob { id, type }. Older shapes (busy as id/object) are accepted too.
  const active = data.activeJob || (data.busy && typeof data.busy === 'object' ? data.busy : null) || (typeof data.busy === 'string' ? { id: data.busy } : null);
  const busy = active;
  const busyId = active && (active.id || active.jobId);
  const last = Date.parse(ctx.state.lastScan || '');
  const fresh = !!(ctx.state.profile && last && (Date.now() - last) < SCAN_FRESH_MS);
  const firstRun = !busyId && !fresh && !ctx.state.profile;
  if (!firstRun) hideSplash();
  if (busyId) {
    const type = (busy && busy.type) || 'apply';
    toast({ type: 'info', title: 'Eine Aufgabe läuft noch', text: 'Ich zeige dir den Fortschritt.' });
    await follow(busyId, type, { overlay: type !== 'scan' });
    if (type === 'scan') await reloadCatalog();
  } else if (!fresh) {
    initialScan(firstRun);
  }
}

function ingest(d) {
  ctx.app = d.app || ctx.app;
  ctx.mode = d.mode || {};
  ctx.categories = (d.categories || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  ctx.catById = new Map(ctx.categories.map(c => [c.id, c]));
  ctx.tweaks = (d.tweaks || []).map(t => Object.assign({ kind: 'toggle' }, t));
  ctx.byId = new Map(ctx.tweaks.map(t => [t.id, t]));
  ctx.presets = d.presets || [];
  ctx.settings = d.settings || {};
  ctx.settings.claude = ctx.settings.claude || { hasKey: false, model: 'claude-opus-5-5' };
  ctx.settings.ai = Object.assign({ provider: '', claudeCode: { model: 'sonnet' }, groq: { hasKey: false, model: '' } }, ctx.settings.ai || {});
  ctx.state = normalizeState(d.state);
  for (const id of Array.from(ctx.pending.keys())) if (!ctx.byId.has(id)) ctx.pending.delete(id);
}
// ------------------------------------------------------------------ staged changes survive a reload
const PENDING_KEY = 'velox.pending';
function savePending() {
  try {
    if (ctx.pending.size) sessionStorage.setItem(PENDING_KEY, JSON.stringify(Array.from(ctx.pending)));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch { /* storage blocked: staged changes live in memory only */ }
}
function restorePending() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch { saved = null; }
  if (!Array.isArray(saved) || !saved.length) return;
  let n = 0;
  for (const pair of saved) {
    if (!Array.isArray(pair)) continue;
    const [id, on] = pair;
    const t = ctx.byId.get(id);
    if (!t || (t.kind || 'toggle') !== 'toggle' || !ctx.applicable(t) || !!on === ctx.isApplied(id)) continue;
    ctx.pending.set(id, !!on); n++;
  }
  if (n) {
    ctx.emit('pending');
    toast({ type: 'info', title: 'Deine vorgemerkten Änderungen sind wieder da', text: plural(n, 'Änderung wartet', 'Änderungen warten') + ' unten auf „Anwenden“.' });
  } else savePending();
}

function normalizeState(s) {
  s = s || {};
  return Object.assign({}, s, { statuses: s.statuses || {}, profile: s.profile || null, lastScan: s.lastScan || null, needs: Object.assign({ explorer: false, reboot: false, logoff: false }, s.needs || {}) });
}

async function initialScan(firstRun, manual) {
  if (ctx.scanning) return;
  if (manual && ctx.busy) { toast({ type: 'warn', title: 'Bitte kurz warten', text: 'Gerade läuft noch: ' + (JOB_META[ctx.busy.type] || {}).title + '.' }); return; }
  ctx.scanning = true;
  ctx.emit('scanning', true);
  renderChips();
  if (firstRun) showSplash();
  if (manual) toast({ type: 'info', title: 'System wird neu gelesen …', text: 'Hardware und Status jedes Tweaks. Oben rechts siehst du, wann es fertig ist.' });
  const job = await runJob('scan', {}, {
    overlay: false, quiet: true,
    onUpdate: (j) => updateSplash(j)
  });
  ctx.scanning = false;
  ctx.emit('scanning', false);
  renderChips();
  hideSplash();
  if (job && job.status === 'done') {
    await reloadCatalog();
    if (firstRun) toast({ type: 'ok', title: 'System erkannt', text: 'Alles bereit. Starte mit „Jetzt analysieren“ oder einem Preset.' });
    else if (manual) toast({ type: 'ok', title: 'System neu gelesen', text: 'Hardware und Status aller Tweaks sind aktuell.' });
  }
}

/** Re-reads bootstrap (applicability may change after a scan) without touching UI state. */
async function reloadCatalog() {
  ctx.settling++;
  try {
    const d = await api.bootstrap();
    ingest(d);
    ctx.emit('catalog');
    ctx.emit('state');
    ctx.emit('statuses');
    renderNav();
    renderChips();
    renderBanners();
  } catch { /* keep what we have */ } finally { ctx.settling--; }
}

// ------------------------------------------------------------------ shell
function buildShell() {
  const app = $('#app');
  const collapse = $('#sidebar-toggle');
  let pref = null;
  try { pref = localStorage.getItem('velox.sidebar'); } catch { /* ignore */ }
  if (pref) root.dataset.sidebar = pref;
  collapse.addEventListener('click', () => {
    const collapsed = $('#sidebar').getBoundingClientRect().width < 120;
    root.dataset.sidebar = collapsed ? 'expanded' : 'collapsed';
    try { localStorage.setItem('velox.sidebar', root.dataset.sidebar); } catch { /* ignore */ }
    collapse.setAttribute('aria-label', collapsed ? 'Seitenleiste einklappen' : 'Seitenleiste ausklappen');
    setTimeout(placePill, 220);
  });
  $('#palette-trigger').addEventListener('click', openPalette);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
  });
  new ResizeObserver(() => placePill()).observe($('#nav'));
  app.addEventListener('scroll', () => {}, { passive: true });
  $('#pending-discard').addEventListener('click', () => { const n = ctx.pending.size; clearPending(); toast({ type: 'info', title: plural(n, 'Änderung', 'Änderungen') + ' verworfen' }); });
  $('#pending-apply').addEventListener('click', () => applyPending());
  $('#pending-list-btn').addEventListener('click', togglePendingList);
  // The pending list behaves like a popover: Escape and a click outside close it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('#pending-pop').hidden || overlayOpen()) return;
    e.preventDefault();
    closePendingList(true);
  });
  document.addEventListener('pointerdown', (e) => {
    if ($('#pending-pop').hidden || e.target.closest('#pending')) return;
    closePendingList(false);
  }, { passive: true });
  ctx.on('pending', renderPending);
  ctx.on('pending', savePending);
}

function renderNav() {
  const nav = $('#nav');
  const current = currentPageId();
  const items = PAGES.map(p => {
    const badgeVal = navBadge(p.id);
    const b = h('a', { class: 'nav-item', href: '#/' + p.id, 'aria-current': p.id === current ? 'page' : null, 'data-page': p.id, 'data-tip': p.title },
      h('span', { class: 'nav-icon' }, icon(p.icon, 19)),
      h('span', { class: 'nav-label', text: p.title }),
      badgeVal ? h('span', { class: 'nav-badge', text: badgeVal.text, title: badgeVal.title }) : null,
      h('span', { class: 'nav-num', 'aria-hidden': 'true', text: String(PAGES.indexOf(p) + 1).padStart(2, '0') }));
    return b;
  });
  const pill = $('#nav-pill') || h('span', { id: 'nav-pill', class: 'nav-pill', 'aria-hidden': 'true' });
  clear(nav);
  nav.appendChild(pill);
  for (const it of items) nav.appendChild(it);
  placePill();
}
function navBadge(id) {
  if (id === 'tweaks' && ctx.pending.size) return { text: String(ctx.pending.size), title: 'Vorgemerkte Änderungen' };
  if (id === 'detweak' && ctx.cache.detweakCount) return { text: String(ctx.cache.detweakCount), title: 'Gefundene Fremd-Tweaks' };
  return null;
}
function placePill() {
  const pill = $('#nav-pill');
  const cur = $('#nav .nav-item[aria-current="page"]');
  if (!pill) return;
  if (!cur) { pill.style.opacity = '0'; return; }
  pill.style.opacity = '1';
  pill.style.height = cur.offsetHeight + 'px';
  pill.style.width = cur.offsetWidth + 'px';
  pill.style.transform = 'translate(' + cur.offsetLeft + 'px,' + cur.offsetTop + 'px)';
}

function renderChips() {
  const box = clear($('#mode-chips'));
  const m = ctx.mode || {};
  if (m.simulate) box.appendChild(h('span', { class: 'mode-chip chip-sim', title: 'Testmodus: VELOX zeigt alles an, verändert aber nichts an deinem PC.' }, icon('flask', 14), h('span', { class: 'chip-long', text: 'Testmodus – nichts wird verändert' }), h('span', { class: 'chip-short', text: 'Testmodus' })));
  if (m.admin) box.appendChild(h('span', { class: 'mode-chip chip-admin', title: 'VELOX läuft mit Administratorrechten.' }, icon('shieldCheck', 14), h('span', { class: 'chip-long', text: 'Administrator' }), h('span', { class: 'chip-short', text: 'Admin' })));
  else if (m.admin === false) box.appendChild(h('span', { class: 'mode-chip chip-warn', title: 'Ohne Administratorrechte können viele Tweaks nicht gesetzt werden. Starte VELOX über ' + startHint(false) + '.' }, icon('alert', 14), h('span', { class: 'chip-long', text: 'Keine Adminrechte' }), h('span', { class: 'chip-short', text: 'Kein Admin' })));
  if (ctx.scanning) box.appendChild(h('span', { class: 'mode-chip chip-scan', role: 'status', title: 'VELOX liest Hardware und Status neu ein. Es wird nichts verändert.' }, spinner(12), h('span', { class: 'chip-long', text: 'Scan läuft …' }), h('span', { class: 'chip-short', text: 'Scan …' })));
  const need = topNeed();
  if (need) {
    const b = h('button', { class: 'mode-chip chip-reboot ripple-host', type: 'button', title: need.text, 'data-need': need.key }, icon(need.icon, 14), h('span', { class: 'chip-long', text: need.chip }), h('span', { class: 'chip-short', text: need.short }));
    b.addEventListener('click', need.run);
    box.appendChild(b);
  }
}

/**
 * Restart / log-off / Explorer: one need at a time, by priority - a restart also covers logging off
 * and reloading Explorer, logging off also reloads Explorer.
 */
function topNeed() {
  const n = ctx.state.needs || {};
  if (n.reboot) return { key: 'reboot', icon: 'restart', chip: 'Neustart nötig', short: 'Neustart', title: 'Neustart empfohlen', text: 'Damit alle Änderungen wirken, starte den PC einmal neu. Das geht auch später.', action: 'Neu starten …', run: askReboot };
  if (n.logoff) return { key: 'logoff', icon: 'user', chip: 'Abmelden nötig', short: 'Abmelden', title: 'Einmal abmelden', text: 'Melde dich einmal ab und wieder an, damit alle Änderungen wirken.', action: null, run: () => toast({ type: 'info', title: 'Einmal abmelden', text: 'Startmenü > dein Name > Abmelden. Danach wieder anmelden – fertig.' }) };
  if (n.explorer) return { key: 'explorer', icon: 'refresh', chip: 'Explorer neu laden', short: 'Explorer', title: 'Explorer neu starten', text: 'Ein paar Änderungen werden erst sichtbar, wenn Taskleiste und Explorer neu laden. Offene Explorer-Fenster schließen sich dabei.', action: 'Explorer neu starten', run: () => runJob('explorer-restart', {}, {}) };
  return null;
}

async function askReboot() {
  const ok = await confirmDialog({
    title: 'PC jetzt neu starten?', icon: 'restart',
    text: 'Speichere vorher alles, was offen ist. Windows startet 10 Sekunden nach dem Bestätigen neu.' + (ctx.mode.simulate ? ' Im Testmodus wird der Neustart nur protokolliert.' : ''),
    confirmLabel: 'Jetzt neu starten'
  });
  if (!ok) return;
  await runJob('reboot', {}, {});
}

const BANNER_KEY = 'velox.bannerDismissed';
/** One combined banner, in full on the Übersicht only (elsewhere the top-bar chip is enough). */
function renderBanners() {
  const box = $('#banners');
  const need = topNeed();
  let dismissed = '';
  try { dismissed = sessionStorage.getItem(BANNER_KEY) || ''; } catch { /* ignore */ }
  const want = need && currentPageId() === 'overview' && dismissed !== need.key ? need.key : '';
  const cur = box.firstElementChild;
  if (cur && !cur.classList.contains('leaving') && cur.dataset.need === want) return; // unchanged: no replayed entrance
  clear(box);
  if (!want) return;
  const later = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, h('span', { class: 'btn-label', text: 'Später' }));
  later.addEventListener('click', () => {
    try { sessionStorage.setItem(BANNER_KEY, need.key); } catch { /* ignore */ }
    const b = box.firstElementChild;
    if (b) { b.classList.add('leaving'); setTimeout(renderBanners, reducedMotion() ? 120 : 200); } else renderBanners();
    toast({ type: 'info', title: 'Erinnerung ausgeblendet', text: 'Oben rechts siehst du weiter, dass noch etwas offen ist.' });
  });
  let act = null;
  if (need.action) {
    act = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-testid': 'banner-action' }, icon(need.icon, 15), h('span', { class: 'btn-label', text: need.action }));
    act.addEventListener('click', need.run);
  }
  box.appendChild(h('div', { class: 'banner ' + (need.key === 'reboot' ? 'banner-warn' : 'banner-info'), role: 'status', 'data-need': need.key },
    h('div', { class: 'banner-icon' }, icon(need.icon, 18)),
    h('div', { class: 'banner-text' }, h('strong', { text: need.title }), h('span', { text: need.text })),
    h('div', { class: 'banner-actions' }, later, act)));
}

// ------------------------------------------------------------------ router
function currentPageId() {
  const m = location.hash.match(/^#\/([a-z-]+)/);
  return m && PAGE_BY_ID.has(m[1]) ? m[1] : 'overview';
}
let navOpts = {};
let active = null; // { id, inst, el }
function navigate(id, opts) {
  navOpts = opts || {};
  if (currentPageId() === id && active && active.id === id) { route(true); return; }
  location.hash = '#/' + id;
}
function route(force) {
  const id = currentPageId();
  if (active && active.id === id && force !== true) return;
  const page = PAGE_BY_ID.get(id);
  const opts = navOpts; navOpts = {};
  const swap = () => {
    if (active && active.inst && active.inst.destroy) { try { active.inst.destroy(); } catch (e) { console.error(e); } }
    if (active && active.unsubs) active.unsubs.forEach(u => u());
    const view = $('#view');
    clear(view);
    const el = h('div', { class: 'page page-' + id, 'data-page': id });
    view.appendChild(el);
    const unsubs = [];
    const scope = Object.assign(Object.create(ctx), { on: (evt, fn) => { const u = ctx.on(evt, fn); unsubs.push(u); return u; } });
    let inst = null;
    try { inst = page.mount(el, scope, opts) || null; } catch (e) { console.error(e); el.appendChild(h('div', { class: 'card pad-24', text: 'Diese Seite konnte nicht geladen werden: ' + e.message })); }
    active = { id, inst, el, unsubs };
    ctx.page = id;
    renderBanners();
    $('#topbar-title').textContent = page.title;
    $('#topbar-desc').textContent = page.desc || '';
    clear($('#topbar-icon')).appendChild(icon(page.icon, 20));
    document.title = page.title + ' · VELOX';
    $('#main').scrollTop = 0;
    for (const a of $$('#nav .nav-item')) a.setAttribute('aria-current', a.dataset.page === id ? 'page' : 'false');
    for (const a of $$('#nav .nav-item')) if (a.dataset.page !== id) a.removeAttribute('aria-current');
    placePill();
  };
  if (active) viewTransition(swap); else swap();
}

// ------------------------------------------------------------------ staging
async function stage(id, on, opts = {}) {
  const t = ctx.byId.get(id);
  if (!t) return false;
  if (!ctx.applicable(t)) { if (!opts.silent) toast({ type: 'warn', title: 'Nicht verfügbar', text: t.naReason || 'Dieser Tweak passt nicht zu deinem PC.' }); return false; }
  if (on && t.risk === 'risky' && ctx.settings.confirmRisky !== false && !opts.confirmed) {
    const ok = await confirmRisky([t]);
    if (!ok) return false;
  }
  if (on === ctx.isApplied(id)) ctx.pending.delete(id); else ctx.pending.set(id, !!on);
  ctx.emit('pending');
  return true;
}
async function stageMany(ids, on, opts = {}) {
  const list = ids.map(id => ctx.byId.get(id)).filter(t => t && ctx.applicable(t) && (t.kind || 'toggle') === 'toggle');
  const risky = list.filter(t => on && t.risk === 'risky');
  if (risky.length && ctx.settings.confirmRisky !== false && !opts.confirmed) {
    if (!(await confirmRisky(risky))) return 0;
  }
  let n = 0;
  for (const t of list) {
    if (on === ctx.isApplied(t.id)) { if (ctx.pending.has(t.id)) { ctx.pending.delete(t.id); } continue; }
    ctx.pending.set(t.id, !!on); n++;
  }
  ctx.emit('pending');
  return n;
}
function confirmRisky(list) {
  const body = h('div', { class: 'risk-list' }, list.map(t => h('div', { class: 'risk-item' }, icon('alert', 16), h('div', {}, h('strong', { text: t.name }), h('p', { text: t.warning || 'Dieser Tweak senkt Sicherheit oder Stabilität.' })))));
  return confirmDialog({
    title: list.length === 1 ? 'Riskanten Tweak vormerken?' : plural(list.length, 'riskanter Tweak', 'riskante Tweaks') + ' vormerken?',
    text: 'Riskante Tweaks bringen etwas Leistung, nehmen dafür aber Schutz oder Stabilität weg. Du kannst sie später jederzeit zurücksetzen.',
    body, danger: true, checkbox: 'Ich weiß, was ich tue', confirmLabel: 'Vormerken'
  });
}
function unstage(id) { if (ctx.pending.delete(id)) ctx.emit('pending'); }
function clearPending() { ctx.pending.clear(); ctx.emit('pending'); }

function renderPending() {
  const bar = $('#pending');
  const n = ctx.pending.size;
  const onN = Array.from(ctx.pending.values()).filter(Boolean).length;
  const offN = n - onN;
  bar.classList.toggle('show', n > 0);
  bar.setAttribute('aria-hidden', n > 0 ? 'false' : 'true');
  for (const b of $$('button', bar)) b.tabIndex = n > 0 ? 0 : -1;
  root.classList.toggle('has-pending', n > 0);
  const cnt = $('#pending-count');
  if (n > 0) {
    const prev = Number(cnt.dataset.value || 0);
    if (Math.abs(n - prev) > 3) countUp(cnt, n, { from: prev, duration: 300 });
    else { cnt.dataset.value = String(n); cnt.textContent = String(n); }
    if (prev !== n) { cnt.classList.remove('bump'); void cnt.offsetWidth; cnt.classList.add('bump'); }
  }
  $('#pending-label').textContent = n === 1 ? 'Änderung vorgemerkt' : 'Änderungen vorgemerkt';
  $('#pending-detail').textContent = [onN ? onN + ' aktivieren' : '', offN ? offN + ' zurücksetzen' : ''].filter(Boolean).join(' · ');
  $('#pending-apply .btn-label').textContent = 'Anwenden';
  renderNav();
  if ($('#pending-pop') && !$('#pending-pop').hidden) fillPendingList();
}
function togglePendingList() {
  const pop = $('#pending-pop');
  if (pop.hidden) { fillPendingList(); pop.hidden = false; $('#pending-list-btn').setAttribute('aria-expanded', 'true'); document.documentElement.classList.toggle('has-pending-pop', !pop.hidden); }
  else closePendingList(false);
}
function closePendingList(refocus) {
  const pop = $('#pending-pop');
  if (pop.hidden) return;
  pop.hidden = true;
  document.documentElement.classList.remove('has-pending-pop');
  $('#pending-list-btn').setAttribute('aria-expanded', 'false');
  if (refocus) $('#pending-list-btn').focus();
}
function fillPendingList() {
  const pop = clear($('#pending-pop'));
  if (!ctx.pending.size) { pop.hidden = true; document.documentElement.classList.remove('has-pending-pop'); return; }
  for (const [id, on] of ctx.pending) {
    const t = ctx.byId.get(id);
    const rm = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Entfernen: ' + (t ? t.name : id) }, icon('x', 14));
    rm.addEventListener('click', () => unstage(id));
    pop.appendChild(h('div', { class: 'pending-item' },
      h('span', { class: 'badge ' + (on ? 'badge-accent' : 'badge-neutral'), text: on ? 'An' : 'Aus' }),
      h('span', { class: 'pending-name', text: t ? t.name : id }), rm));
  }
}

async function applyPending() {
  if (!ctx.pending.size) return;
  if (ctx.busy) { toast({ type: 'warn', title: 'Bitte kurz warten', text: 'Eine andere Aufgabe läuft gerade.' }); return; }
  closePendingList(false);
  const onIds = []; const offIds = [];
  for (const [id, v] of ctx.pending) (v ? onIds : offIds).push(id);
  let okCount = 0; let failCount = 0; let firstErr = null; let totalMs = 0; let timed = false;
  const backups = []; const needs = {};
  const take = (job, ids) => {
    for (const id of ids) ctx.pending.delete(id);
    const r = job.result || {};
    if (typeof r.durationMs === 'number') { totalMs += r.durationMs; timed = true; }
    const res = r.results || [];
    okCount += res.filter(x => x.ok).length;
    const bad = res.filter(x => !x.ok);
    failCount += bad.length;
    if (!firstErr && bad.length) firstErr = bad[0];
    if (r.backupId) backups.push(r.backupId);
    Object.assign(needs, r.needs || {});
  };
  if (onIds.length) {
    const job = await runJob('apply', { ids: onIds, label: 'Tweaks: ' + plural(onIds.length, 'aktiviert', 'aktiviert') }, { quiet: true });
    if (job && job.status === 'done') take(job, onIds);
    else { ctx.emit('pending'); return; }
  }
  if (offIds.length) {
    const job = await runJob('revert', { ids: offIds, label: 'Tweaks: ' + plural(offIds.length, 'zurückgesetzt', 'zurückgesetzt') }, { quiet: true });
    if (job && job.status === 'done') take(job, offIds);
  }
  ctx.emit('pending');
  if (!okCount && !failCount) return;
  const undoIds = backups.slice().reverse();
  toast({
    type: failCount ? 'warn' : 'ok',
    title: failCount ? okCount + ' erledigt, ' + failCount + ' fehlgeschlagen' : plural(okCount, 'Änderung', 'Änderungen') + (timed ? inDuration({ durationMs: totalMs }) : '') + ' angewendet',
    text: failCount && firstErr ? tweakName(firstErr.id) + ': ' + (firstErr.error || 'Fehler') : successLine(needs),
    action: undoIds.length && !ctx.onlyRemovals(onIds.concat(offIds)) ? { label: 'Rückgängig', onClick: () => undoBackups(undoIds) } : null
  });
}
const tweakName = (id) => (ctx.byId.get(id) || { name: id }).name;
/** "Gesichert · Neustart empfohlen": the second half of every success toast. */
function successLine(needs, removed) {
  const n = needs || {};
  const after = n.reboot ? 'Neustart empfohlen, damit alles wirkt.' : n.logoff ? 'Einmal abmelden, damit alles wirkt.' : n.explorer ? 'Explorer neu laden, damit alles sichtbar wird.' : 'Wirkt sofort.';
  return (removed ? 'Entfernte Apps lassen sich nur über den Microsoft Store zurückholen. ' : 'Gesichert – mit „Rückgängig“ oder unter „Sicherungen“ zurückholbar. ') + after;
}

// ------------------------------------------------------------------ jobs
/**
 * Starts a job and follows it. opts: { overlay (default true), title, subtitle, quiet (no result toast),
 * onUpdate(job) }. Resolves with the final job, or null when it could not start.
 */
async function runJob(type, params, opts = {}) {
  // a quiet read-only job in the background (e.g. the restore point list of the Sicherungen page)
  // never blocks what the user or the boot scan starts: wait for it instead of refusing
  if (ctx.busy && ctx.busy.background && !opts.background) await waitIdle(30000);
  if (ctx.busy) {
    if (!opts.quietBusy) toast({ type: 'warn', title: 'Bitte kurz warten', text: 'Gerade läuft noch: ' + (JOB_META[ctx.busy.type] || {}).title + '.' });
    return null;
  }
  ctx.busy = { id: null, type, background: !!opts.background };
  ctx.emit('busy', ctx.busy);
  let jobId;
  try {
    const r = await api.startJob(type, params || {});
    jobId = r.jobId;
  } catch (e) {
    ctx.busy = null; ctx.emit('busy', null);
    if (e.status === 409 && e.body && e.body.jobId) {
      await followForeign(e.body.jobId, e.body.type);
      return null;
    }
    if (e.status !== 0) toast({ type: 'error', title: failTitle(type), text: e.message });
    return null;
  }
  return follow(jobId, type, opts);
}

/** Resolves once no job runs any more (or after ms). */
function waitIdle(ms) {
  if (!ctx.busy) return Promise.resolve(true);
  return new Promise((resolve) => {
    let off = null;
    const timer = setTimeout(() => { if (off) off(); resolve(!ctx.busy); }, ms);
    off = ctx.on('busy', (b) => { if (!b) { clearTimeout(timer); off(); resolve(true); } });
  });
}

/**
 * Someone else started a job (another window, or the backend was still busy): show it under its
 * real title, then remind the user that their own staged changes are still waiting.
 */
async function followForeign(jobId, knownType) {
  let type = knownType;
  if (!type) { try { type = (await api.job(jobId, 0)).type; } catch { type = null; } }
  toast({ type: 'info', title: 'VELOX ist gerade beschäftigt', text: 'Ich zeige dir die laufende Aufgabe: ' + ((JOB_META[type] || {}).title || 'Aufgabe') + '.' });
  await follow(jobId, type || 'job', {});
  if (ctx.pending.size) {
    toast({ type: 'info', title: 'Deine Änderungen sind noch vorgemerkt', text: plural(ctx.pending.size, 'Änderung wartet', 'Änderungen warten') + ' unten in der Leiste.', action: { label: 'Jetzt anwenden', onClick: () => applyPending() } });
  }
}

async function follow(jobId, type, opts = {}) {
  const meta = JOB_META[type] || { title: 'Aufgabe läuft', icon: 'bolt' };
  const t0 = Date.now();
  ctx.busy = { id: jobId, type, background: !!opts.background };
  ctx.emit('busy', ctx.busy);
  root.classList.add('is-busy');
  const overlay = opts.overlay === false ? null : jobOverlay({
    title: opts.title || meta.title, subtitle: opts.subtitle || (ctx.mode.simulate && meta.mutating ? 'Testmodus: Änderungen werden nur simuliert.' : null),
    cancellable: !!meta.cancel, icon: opts.icon || meta.icon,
    onCancel: () => api.cancelJob(jobId).catch(() => {})
  });
  // "Überspringen": shown while the backend runs a step that may be skipped (a restore point,
  // a reset command) - the job itself goes on with the next step
  const panel = overlay ? Array.from(document.querySelectorAll('.layer .dialog.job')).pop() : null;
  let skipBtn = null;
  let skipHint = null;
  const syncSkip = (j) => {
    if (!panel) return;
    const want = j.status === 'running' && !!j.skippable;
    panel.classList.toggle('is-skippable', want);
    if (want && !skipBtn) {
      skipBtn = button({ label: 'Überspringen', icon: 'arrowRight', variant: 'secondary', attrs: { 'data-testid': 'job-skip', title: 'Diesen Schritt auslassen – der Rest läuft weiter' }, onClick: () => {
        skipBtn.disabled = true;
        const lbl = skipBtn.querySelector('.btn-label'); if (lbl) lbl.textContent = 'Wird übersprungen …';
        request('POST', '/api/jobs/' + encodeURIComponent(jobId) + '/skip').catch(() => {});
      } });
      const foot = panel.querySelector('.dialog-foot');
      if (foot) {
        skipHint = h('p', { class: 'job-skip-hint', text: 'Dauert es zu lange? Dann lass nur diesen Schritt aus – der Rest läuft weiter.' });
        foot.insertBefore(skipBtn, foot.firstChild);
        foot.insertBefore(skipHint, skipBtn);
      }
    } else if (!want && skipBtn) { skipBtn.remove(); skipBtn = null; if (skipHint) { skipHint.remove(); skipHint = null; } }
  };
  let job;
  try {
    job = await pollJob(jobId, (j) => { if (overlay) { overlay.update(j); syncSkip(j); } if (opts.onUpdate) opts.onUpdate(j); });
  } catch (e) {
    if (overlay) overlay.close();
    ctx.busy = null; ctx.emit('busy', null); root.classList.remove('is-busy');
    if (e.status !== 0) toast({ type: 'error', title: meta.title, text: e.message });
    return null;
  }
  ctx.busy = null;
  ctx.emit('busy', null);
  root.classList.remove('is-busy');
  if (skipBtn) { skipBtn.remove(); skipBtn = null; }
  if (panel) panel.classList.remove('is-skippable');
  if (overlay) {
    // Stay open when there is something to read: warnings in the log, a long job the user may have
    // walked away from, or when the caller asks for it (repair tools).
    const problems = (job.log || []).some(l => l.level === 'warn' || l.level === 'error');
    const long = job.startedAt && job.finishedAt ? (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) > 20000 : (Date.now() - t0) > 20000;
    overlay.finish(job, { keep: job.status === 'done' && (!!opts.keepOpen || problems || long), summary: job.status === 'done' ? (opts.summary ? opts.summary(job) : jobSummary(type, job.result || {})) : null });
  }
  if (opts.onUpdate) opts.onUpdate(job);

  if (job.status === 'done' && job.result) applyResultLocally(type, job.result);
  if (meta.mutating || type === 'scan') await refreshState();
  if (meta.mutating && job.status !== 'error') { ctx.cache.backups = null; ctx.cache.restorePoints = null; ctx.emit('backups'); }

  if (job.status === 'done' && ['apply', 'detweak', 'restore', 'run-action'].includes(type)) celebrate(type, job.result || {});
  // quietError: the page shows the error itself (e.g. the KI-Optimierer with its way out) - a sticky
  // toast saying the same would only cover the content
  const quietError = typeof opts.quietError === 'function' ? opts.quietError() : !!opts.quietError;
  if (job.status === 'error') { if (!quietError) toast({ type: 'error', title: failTitle(type), text: friendlyError(job.error) }); }
  else if (job.status === 'cancelled') { if (!opts.quietCancel) toast({ type: 'info', title: 'Abgebrochen', text: 'Bereits erledigte Schritte bleiben gesichert.' }); }
  else if (!opts.quiet) resultToast(type, job.result || {}, opts);
  return job;
}
/** Backend errors can carry technical tails ("| at Invoke-…"); the toast shows the plain part. */
function friendlyError(msg) {
  const m = String(msg || '').split(/\s\|\s|\r?\n\s*at\s/)[0].trim();
  return m || 'Unbekannter Fehler';
}
/** One plain line for the job overlay once it is done. */
function jobSummary(type, r) {
  const res = r.results || [];
  if (type === 'apply' || type === 'revert') {
    const ok = res.filter(x => x.ok).length; const fail = res.length - ok;
    const removed = res.length && ctx.onlyRemovals(res.map(x => x.id));
    const what = removed ? plural(ok, 'App', 'Apps') + inDuration(r) + ' entfernt' : plural(ok, 'Tweak', 'Tweaks') + inDuration(r) + (type === 'apply' ? ' angewendet' : ' zurückgesetzt');
    return what + (fail ? ' · ' + fail + ' fehlgeschlagen' : '') + needsSuffix(r.needs);
  }
  if (type === 'run-action') {
    const ok = res.filter(x => x.ok !== false); const fail = res.length - ok.length;
    const msgs = ok.map(x => x.message).filter(Boolean);
    return (msgs.length === 1 ? msgs[0] : plural(ok.length, 'Aufgabe erledigt', 'Aufgaben erledigt')) + (fail ? ' · ' + fail + ' fehlgeschlagen' : '');
  }
  if (type === 'restore') return plural(r.restored || 0, 'Wert', 'Werte') + ' wiederhergestellt' + (r.failed ? ' · ' + r.failed + ' fehlgeschlagen' : '');
  if (type === 'detweak') return detweakLine(r) + (typeof r.durationMs === 'number' ? ' · ' + fmtDuration(r.durationMs) : '') + needsSuffix(r.needs);
  if (type === 'restorepoint-clean') return plural(r.removed || 0, 'Wiederherstellungspunkt', 'Wiederherstellungspunkte') + ' gelöscht' + (r.failed ? ' · ' + r.failed + ' nicht gelöscht' : '');
  return null;
}
function needsSuffix(n) { n = n || {}; return n.reboot ? ' · Neustart empfohlen' : n.logoff ? ' · Abmelden nötig' : n.explorer ? ' · Explorer neu laden' : ''; }
/** Detweak result in words: values and commands are counted separately when the backend says so. */
function detweakLine(r) {
  const vals = typeof r.resetValues === 'number' ? r.resetValues : (typeof r.commandsRun === 'number' ? Math.max(0, (r.reset || 0) - r.commandsRun) : (r.reset || 0));
  const parts = [plural(vals, 'Wert', 'Werte') + ' zurückgesetzt'];
  if (typeof r.commandsRun === 'number' && r.commandsRun) parts.push(plural(r.commandsRun, 'Befehl', 'Befehle') + ' ausgeführt');
  if (r.applied) parts.push(plural(r.applied, 'Tweak', 'Tweaks') + ' danach angewendet');
  return parts.join(' · ');
}

/** A short particle burst when something worked out completely. */
function celebrate(type, r) {
  const res = r.results || [];
  if (res.some(x => x && x.ok === false) || r.failed) return;
  const m = $('#main').getBoundingClientRect();
  setTimeout(() => burst(m.left + m.width / 2, m.top + Math.min(m.height * 0.42, 320)), 380);
}

function applyResultLocally(type, r) {
  if ((type === 'apply' || type === 'revert') && Array.isArray(r.results)) {
    for (const x of r.results) if (x && x.id && x.status) ctx.state.statuses[x.id] = x.status;
    ctx.emit('statuses');
  }
  if (type === 'scan' && r.statuses) { ctx.state.statuses = r.statuses; if (r.profile) ctx.state.profile = r.profile; ctx.emit('statuses'); ctx.emit('state'); }
  if (r.needs && typeof r.needs === 'object') { Object.assign(ctx.state.needs, r.needs); renderBanners(); renderChips(); }
}

function resultToast(type, r, opts = {}) {
  switch (type) {
    case 'apply': case 'revert': {
      const res = r.results || [];
      const ok = res.filter(x => x.ok).length; const fail = res.length - ok;
      const firstErr = res.find(x => !x.ok);
      const removed = ctx.onlyRemovals(res.map(x => x.id));
      const anyRemoved = res.some(x => (ctx.byId.get(x.id) || {}).kind === 'remove');
      const noun = removed ? ['App', 'Apps', 'entfernt'] : type === 'apply' ? ['Tweak', 'Tweaks', 'angewendet'] : ['Tweak', 'Tweaks', 'zurückgesetzt'];
      toast({
        type: fail ? 'warn' : 'ok',
        title: fail ? ok + ' erledigt, ' + fail + ' fehlgeschlagen' : (opts.doneTitle || plural(ok, noun[0], noun[1]) + inDuration(r) + ' ' + noun[2]),
        text: fail && firstErr ? tweakName(firstErr.id) + ': ' + (firstErr.error || 'Fehler') : removed ? 'Nicht rückgängig zu machen. Neu installieren geht über den Microsoft Store.' + needsSuffix(r.needs).replace(' · ', ' ') : successLine(r.needs, anyRemoved),
        action: r.backupId && !removed ? { label: 'Rückgängig', onClick: () => undoBackups([r.backupId]) } : null
      });
      break;
    }
    case 'restorepoint': {
      const title = r.ok === false ? (r.skipped ? 'Wiederherstellungspunkt übersprungen' : 'Kein Wiederherstellungspunkt') : 'Wiederherstellungspunkt erstellt';
      // the backend's message often repeats the title as its first sentence: say it only once
      let text = String(r.message || '');
      if (text.toLowerCase().startsWith(title.toLowerCase())) text = text.slice(title.length).replace(/^[\s.:–-]+/, '');
      toast({ type: r.ok === false ? 'warn' : 'ok', title, text });
      break;
    }
    case 'restorepoint-clean': toast({ type: r.failed ? 'warn' : 'ok', title: r.removed ? plural(r.removed, 'alter Wiederherstellungspunkt', 'alte Wiederherstellungspunkte') + ' gelöscht' : 'Nichts zu löschen', text: r.failed ? r.failed + ' konnten nicht gelöscht werden' + (r.errors && r.errors.length ? ': ' + friendlyError(r.errors[0]) : '.') : 'Der erste VELOX-Wiederherstellungspunkt bleibt als Sicherheitsnetz erhalten.' }); break;
    case 'restore': toast({ type: r.failed ? 'warn' : 'ok', title: plural(r.restored || 0, 'Wert', 'Werte') + ' wiederhergestellt', text: r.failed ? r.failed + ' konnten nicht zurückgesetzt werden' + (r.errors && r.errors.length ? ': ' + friendlyError(r.errors[0]) : '.') : 'Dein PC ist wieder auf dem Stand vor dieser Sicherung.' + needsSuffix(r.needs).replace(' · ', ' ') }); break;
    case 'explorer-restart': toast({ type: 'ok', title: 'Explorer neu gestartet' }); break;
    case 'reboot': toast({ type: 'info', title: ctx.mode.simulate ? 'Neustart protokolliert (Testmodus)' : 'Neustart in 10 Sekunden', text: ctx.mode.simulate ? 'Im Testmodus startet der PC nicht neu.' : 'Speichere jetzt deine offenen Dateien.' }); break;
    default: break;
  }
}

/** Undo = restore the given backups, newest first. */
async function undoBackups(ids) {
  let restored = 0; let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    const job = await runJob('restore', { backupId: ids[i] }, { title: 'Wird rückgängig gemacht', quiet: true });
    if (!job || job.status !== 'done') return;
    restored += (job.result && job.result.restored) || 0;
    failed += (job.result && job.result.failed) || 0;
  }
  toast({ type: failed ? 'warn' : 'ok', title: 'Rückgängig gemacht', text: failed ? failed + ' Werte konnten nicht zurückgesetzt werden. Details unter „Sicherungen“.' : 'Alles ist wieder wie vorher (' + plural(restored, 'Wert', 'Werte') + ').' });
}

async function refreshState() {
  ctx.settling++;
  try {
    const s = await api.state();
    ctx.state = normalizeState(s);
    ctx.emit('state');
    ctx.emit('statuses');
    // a pending change that is now already true is no longer pending
    let changed = false;
    for (const [id, on] of Array.from(ctx.pending)) if (on === ctx.isApplied(id)) { ctx.pending.delete(id); changed = true; }
    if (changed) ctx.emit('pending');
    renderChips();
    renderBanners();
  } catch { /* connection handling lives in api.js */ } finally { ctx.settling--; }
}

async function saveSettings(partial, { silent } = {}) {
  try {
    const r = await api.settings(partial);
    ctx.settings = Object.assign({}, ctx.settings, r.settings || partial);
    applyTheme();
    ctx.emit('settings');
    if (!silent) toast({ type: 'ok', title: 'Gespeichert' });
    return true;
  } catch (e) {
    toast({ type: 'error', title: 'Konnte nicht speichern', text: e.message });
    return false;
  }
}

// ------------------------------------------------------------------ splash & end states
function showSplash() {
  const app = $('#app');
  app.setAttribute('inert', '');
  app.setAttribute('data-splash', '');
  splash.scanStart();
}
function updateSplash(job) {
  splash.update(job);
}
function hideSplash() {
  const app = $('#app');
  // the intro hands over (it never cuts itself short), fades, and is destroyed; the app behind is
  // already rendered, so it is usable the moment the splash is gone
  return splash.finish().then(() => {
    if (app.hasAttribute('data-splash')) { app.removeAttribute('data-splash'); if (!overlayOpen() && !ended) app.removeAttribute('inert'); }
  });
}

let ended = false;
function showEnded(reason) {
  if (ended) return;
  ended = true;
  const el = $('#ended');
  const title = reason === 'token' ? 'Sitzung ungültig' : 'Keine Verbindung zu VELOX';
  const text = reason === 'token'
    ? 'Dieses Fenster gehört zu einer alten VELOX-Sitzung. Du kannst es schließen – das aktuelle VELOX-Fenster öffnet sich, wenn du VELOX über ' + startHint(!!(ctx.mode || {}).simulate) + ' startest.'
    : 'VELOX wurde beendet oder antwortet gerade nicht. Kommt es zurück, geht es hier von selbst weiter. Sonst kannst du dieses Fenster schließen und VELOX über ' + startHint(!!(ctx.mode || {}).simulate) + ' neu starten.';
  clear(el).appendChild(h('div', { class: 'ended-card' },
    h('div', { class: 'ended-icon' }, icon('power', 30)),
    h('h1', { class: 'ended-title', text: title }),
    h('p', { class: 'ended-text', text }),
    reason === 'lost' ? h('p', { class: 'ended-retry', role: 'status' }, spinner(14), h('span', { text: 'Verbinde neu …' })) : null));
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  $('#app').setAttribute('inert', '');
  splash.hide();
  // If VELOX comes back (e.g. the PC was just busy), quietly pick up where we were.
  if (reason === 'lost') waitForBackend().then(() => location.reload());
}
function showBootError(msg) {
  if (ended) return; // the session/connection screen already explains it
  const el = $('#ended');
  const retry = h('button', { class: 'btn btn-primary', type: 'button' }, icon('refresh', 16), h('span', { class: 'btn-label', text: 'Erneut versuchen' }));
  retry.addEventListener('click', () => location.reload());
  clear(el).appendChild(h('div', { class: 'ended-card' },
    h('div', { class: 'ended-icon tone-error' }, icon('alert', 30)),
    h('h1', { class: 'ended-title', text: 'VELOX konnte nicht starten' }),
    h('p', { class: 'ended-text', text: plainBootError(msg) }), retry));
  el.hidden = false;
  el.classList.add('show');
  splash.hide();
}

function plainBootError(msg) {
  const m = String(msg || '');
  if (/autoris|token/i.test(m)) return 'Dieses Fenster gehört zu einer alten VELOX-Sitzung. Schließ es und starte VELOX über ' + startHint(!!(ctx.mode || {}).simulate) + '.';
  if (/^Anfrage fehlgeschlagen \(5/.test(m)) return 'VELOX hatte beim Start einen internen Fehler. Versuch es noch einmal; hilft das nicht, starte VELOX neu.';
  return m || 'Unbekannter Fehler.';
}

// ------------------------------------------------------------------ command palette
function openPalette() {
  if ($('.palette') || !$('#splash').hidden) return;   // not under the start sequence
  const input = h('input', { class: 'palette-input', type: 'text', placeholder: 'Tweak, Seite oder Aktion suchen …', 'aria-label': 'Suchen', autocomplete: 'off', spellcheck: 'false', autofocus: true });
  const list = h('div', { class: 'palette-list', role: 'listbox', id: 'palette-list' });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', 'palette-list');
  input.setAttribute('aria-expanded', 'true');
  const panel = h('div', { class: 'palette', tabindex: '-1' },
    h('div', { class: 'palette-search' }, icon('search', 18), input, h('kbd', { text: 'Esc' })),
    list,
    h('div', { class: 'palette-foot' }, h('span', {}, h('kbd', { text: '↑' }), h('kbd', { text: '↓' }), ' auswählen'), h('span', {}, h('kbd', { text: 'Enter' }), ' ausführen'), h('span', {}, h('kbd', { text: 'Strg' }), h('kbd', { text: 'K' }), ' öffnen')));
  const layer = openLayer({ kind: 'palette', panel, label: 'Befehlspalette' });
  let items = []; let sel = 0;
  const actions = [
    { label: 'Jetzt analysieren', hint: 'KI-Optimierer starten', icon: 'brain', run: () => navigate('advisor', { autostart: true }) },
    { label: 'Fremd-Tweaks suchen', hint: 'Detweak-Scan starten', icon: 'undo', run: () => navigate('detweak', { autostart: true }) },
    { label: 'Speicher aufräumen', hint: 'Reinigung öffnen', icon: 'broom', run: () => navigate('cleanup') },
    { label: 'Wiederherstellungspunkt erstellen', hint: 'Sicherheitsnetz für Windows', icon: 'shieldCheck', run: () => runJob('restorepoint', { label: 'Manuell' }) },
    { label: 'System neu scannen', hint: 'Hardware und Status neu lesen', icon: 'refresh', run: () => initialScan(false, true) },
    { label: 'Explorer neu starten', hint: 'Taskleiste und Explorer neu laden', icon: 'refresh', run: () => runJob('explorer-restart', {}) },
    { label: 'Vorgemerkte Änderungen anwenden', hint: 'Anwenden-Leiste ausführen', icon: 'check', run: () => applyPending(), when: () => ctx.pending.size > 0 },
    { label: 'Animationen umschalten', hint: 'Voll / Reduziert', icon: 'motion', run: () => saveSettings({ motion: ctx.settings.motion === 'reduced' ? 'full' : 'reduced' }) }
  ];
  function build() {
    const q = input.value.trim();
    items = [];
    const pages = PAGES.map(p => ({ kind: 'page', label: p.title, hint: p.desc || '', icon: p.icon, run: () => navigate(p.id), s: Math.max(textScore(q, p.title) * 3, textScore(q, p.keywords || '') * 1.5, textScore(q, p.desc || '')) })).filter(x => x.s > 0);
    const acts = actions.filter(a => !a.when || a.when()).map(a => Object.assign({ kind: 'action', s: Math.max(textScore(q, a.label) * 3, textScore(q, a.hint)) }, a)).filter(x => x.s > 0);
    let tw = [];
    if (q.length >= 2) {
      tw = ctx.tweaks.filter(t => (t.kind || 'toggle') === 'toggle').map(t => ({ t, s: tweakScore(q, t, ctx.catName(t.category)) + (ctx.applicable(t) ? 0.05 : 0) + (Number(t.impact) || 1) * 0.01 }))
        .filter(x => x.s > 0.05).sort((a, b) => b.s - a.s).slice(0, 30)
        .map(({ t, s }) => ({ kind: 'tweak', t, label: t.name, hint: ctx.catName(t.category), icon: (ctx.catById.get(t.category) || {}).icon || 'sliders', s }));
    }
    // with a query, the group holding the best match comes first ("Sicherungen" opens the page)
    const top = (arr) => arr.reduce((m, x) => Math.max(m, x.s), 0);
    const groups = q ? [['Tweaks', tw], ['Seiten', pages], ['Aktionen', acts]].sort((a, b) => top(b[1]) - top(a[1])) : [['Seiten', pages], ['Aktionen', acts]];
    clear(list);
    for (const [name, arr] of groups) {
      if (!arr.length) continue;
      arr.sort((a, b) => b.s - a.s);
      list.appendChild(h('div', { class: 'palette-group', text: name }));
      for (const it of arr) {
        const idx = items.length;
        items.push(it);
        let right = null;
        if (it.kind === 'tweak') {
          const on = ctx.effective(it.t.id); const na = !ctx.applicable(it.t);
          right = h('span', { class: 'palette-state' }, na ? h('span', { class: 'badge badge-neutral', text: 'Nicht verfügbar' }) : h('span', { class: 'badge ' + (on ? 'badge-ok' : 'badge-neutral'), text: on ? 'An' : 'Aus' }), h('span', { class: 'palette-enter', text: na ? '' : on ? 'Enter: ausschalten' : 'Enter: einschalten' }));
        } else right = h('span', { class: 'palette-enter', text: it.kind === 'page' ? 'Öffnen' : 'Ausführen' });
        const row = h('div', { class: 'palette-item', role: 'option', id: 'pi-' + idx, 'aria-selected': 'false', dataset: { idx } },
          h('span', { class: 'palette-icon' }, icon(it.icon, 17)),
          h('span', { class: 'palette-text' }, h('span', { class: 'palette-label', text: it.label }), it.hint && h('span', { class: 'palette-hint', text: it.hint })),
          right);
        row.addEventListener('mousemove', () => select(idx, false));
        row.addEventListener('click', () => exec(idx));
        list.appendChild(row);
      }
    }
    if (!items.length) list.appendChild(h('div', { class: 'palette-empty' }, icon('search', 22), h('span', { text: 'Nichts gefunden. Versuch es mit „Maus“, „Ping“ oder „Copilot“.' })));
    select(0, true);
  }
  function select(i, scroll) {
    sel = Math.max(0, Math.min(items.length - 1, i));
    for (const r of $$('.palette-item', list)) r.setAttribute('aria-selected', String(Number(r.dataset.idx) === sel));
    const cur = $('#pi-' + sel, list);
    if (cur) { input.setAttribute('aria-activedescendant', cur.id); if (scroll) cur.scrollIntoView({ block: 'nearest' }); }
  }
  async function exec(i) {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'tweak') {
      const next = !ctx.effective(it.t.id);
      layer.close(true);
      const ok = await stage(it.t.id, next);
      if (ok) toast({ type: 'ok', title: (ctx.pending.has(it.t.id) ? 'Vorgemerkt: ' : 'Zurückgenommen: ') + it.t.name, text: ctx.pending.has(it.t.id) ? (next ? 'Wird eingeschaltet' : 'Wird ausgeschaltet') + ', sobald du unten auf „Anwenden“ klickst.' : 'Die vorgemerkte Änderung wurde entfernt.' });
      return;
    }
    layer.close(true);
    it.run();
  }
  input.addEventListener('input', build);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { select(sel + 1, true); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { select(sel - 1, true); e.preventDefault(); }
    else if (e.key === 'Enter') { exec(sel); e.preventDefault(); }
  });
  build();
}

// ------------------------------------------------------------------ go
boot().catch((e) => { console.error(e); showBootError(e && e.message); });

