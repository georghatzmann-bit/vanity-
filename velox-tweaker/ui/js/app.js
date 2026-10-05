// VELOX front end entry: app state (ctx), router, sidebar, top bar, staged changes,
// job runner with progress overlay, needs banners, command palette, splash and "ended" screens.
import { api, initToken, hasToken, on as onApi, pollJob, startHeartbeat } from './api.js';
import { icon } from './icons.js';
import {
  h, clear, $, $$, toast, jobOverlay, confirmDialog, installEffects, countUp, plural, fmtNumber,
  viewTransition, openLayer, reducedMotion
} from './ui.js';

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
const JOB_META = {
  scan: { title: 'System wird analysiert', icon: 'cpu', cancel: true },
  apply: { title: 'Tweaks werden angewendet', icon: 'bolt', cancel: true, mutating: true },
  revert: { title: 'Tweaks werden zurückgesetzt', icon: 'undo', cancel: true, mutating: true },
  restorepoint: { title: 'Wiederherstellungspunkt wird erstellt', icon: 'shieldCheck', mutating: true },
  restore: { title: 'Sicherung wird wiederhergestellt', icon: 'history', cancel: true, mutating: true },
  'detweak-scan': { title: 'Suche nach Fremd-Tweaks', icon: 'search', cancel: true },
  detweak: { title: 'Detweak läuft', icon: 'undo', cancel: true, mutating: true },
  advisor: { title: 'Smart-Analyse', icon: 'brain', cancel: true },
  claude: { title: 'Claude analysiert dein System', icon: 'brain', cancel: true },
  'clean-scan': { title: 'Speicherplatz wird gemessen', icon: 'broom', cancel: true },
  'run-action': { title: 'Wird ausgeführt', icon: 'broom', cancel: true, mutating: true },
  'startup-list': { title: 'Autostart wird gelesen', icon: 'package' },
  'startup-set': { title: 'Autostart wird geändert', icon: 'package', mutating: true },
  'games-detect': { title: 'Spiele werden gesucht', icon: 'gamepad', cancel: true },
  'game-boost': { title: 'Spiel-Boost wird gesetzt', icon: 'gamepad', mutating: true },
  'pick-file': { title: 'Datei auswählen', icon: 'file' },
  'explorer-restart': { title: 'Explorer wird neu gestartet', icon: 'refresh', mutating: true },
  reboot: { title: 'Neustart wird vorbereitet', icon: 'restart', mutating: true }
};

// ------------------------------------------------------------------ context
const bus = new Map();
const ctx = {
  app: { name: 'VELOX', version: '' }, mode: {}, categories: [], tweaks: [], byId: new Map(), catById: new Map(), presets: [],
  settings: {}, state: { statuses: {}, profile: null, lastScan: null, needs: {} },
  pending: new Map(),
  cache: { advisor: null, detweak: null, clean: null, startup: null, games: null, backups: null, goal: null, detweakCount: null },
  busy: null,
  scanning: false,
  page: null,
  on(evt, fn) { if (!bus.has(evt)) bus.set(evt, new Set()); bus.get(evt).add(fn); return () => bus.get(evt).delete(fn); },
  emit(evt, data) { for (const fn of Array.from(bus.get(evt) || [])) { try { fn(data); } catch (e) { console.error(e); } } },
  navigate, runJob, stage, stageMany, unstage, clearPending, applyPending, refreshState, reloadCatalog, saveSettings, openPalette,
  status(id) { return ctx.state.statuses[id] || (ctx.byId.get(id) && ctx.byId.get(id).applicable === false ? 'na' : 'unknown'); },
  applicable(t) { if (typeof t === 'string') t = ctx.byId.get(t); return !!t && t.applicable !== false && ctx.status(t.id) !== 'na'; },
  isApplied(id) { return ctx.status(id) === 'applied'; },
  effective(id) { return ctx.pending.has(id) ? ctx.pending.get(id) : ctx.isApplied(id); },
  catName(id) { const c = ctx.catById.get(id); return c ? c.name : id; },
  toggles() { return ctx.tweaks.filter(t => (t.kind || 'toggle') === 'toggle'); },
  /** Runs fn now, or as soon as the running job has finished. */
  whenIdle(fn) {
    if (!ctx.busy) { fn(); return; }
    const off = ctx.on('busy', (b) => { if (!b) { off(); setTimeout(fn, 0); } });
  }
};
window.__velox = ctx; // handy for debugging in the Edge dev tools; holds no secrets

// ------------------------------------------------------------------ theme
const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
function applyTheme() {
  root.dataset.accent = ctx.settings.accent || 'violet';
  root.dataset.motion = (ctx.settings.motion === 'reduced' || mqReduced.matches) ? 'reduced' : 'full';
}
mqReduced.addEventListener('change', applyTheme);

// ------------------------------------------------------------------ boot
async function boot() {
  installEffects();
  if (!initToken() && !hasToken()) { showEnded('token'); return; }
  onApi('lost', () => showEnded('lost'));
  onApi('unauthorized', () => showEnded('token'));
  buildShell();
  let data;
  try {
    data = await api.bootstrap();
  } catch (e) {
    if (e.status === 0) { showEnded('lost'); return; }
    showBootError(e.message);
    return;
  }
  ingest(data);
  applyTheme();
  renderNav();
  renderChips();
  renderBanners();
  root.classList.add('ready');
  window.addEventListener('hashchange', route);
  route();
  startHeartbeat((busy) => { ctx.backendBusy = busy || null; });

  const busy = data.busy;
  const busyId = busy && (typeof busy === 'string' ? busy : busy.jobId || busy.id);
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
  ctx.state = normalizeState(d.state);
  for (const id of Array.from(ctx.pending.keys())) if (!ctx.byId.has(id)) ctx.pending.delete(id);
}
function normalizeState(s) {
  s = s || {};
  return { statuses: s.statuses || {}, profile: s.profile || null, lastScan: s.lastScan || null, needs: Object.assign({ explorer: false, reboot: false, logoff: false }, s.needs || {}) };
}

async function initialScan(firstRun) {
  ctx.scanning = true;
  ctx.emit('scanning', true);
  if (firstRun) showSplash();
  const job = await runJob('scan', {}, {
    overlay: false, quiet: true,
    onUpdate: (j) => updateSplash(j)
  });
  ctx.scanning = false;
  ctx.emit('scanning', false);
  hideSplash();
  if (job && job.status === 'done') {
    await reloadCatalog();
    if (firstRun) toast({ type: 'ok', title: 'System erkannt', text: 'Alles bereit. Starte mit "Jetzt analysieren" oder einem Preset.' });
  } else if (job && job.status === 'error') {
    toast({ type: 'error', title: 'Systemanalyse fehlgeschlagen', text: job.error || 'Unbekannter Fehler' });
  }
}

/** Re-reads bootstrap (applicability may change after a scan) without touching UI state. */
async function reloadCatalog() {
  try {
    const d = await api.bootstrap();
    ingest(d);
    ctx.emit('catalog');
    ctx.emit('state');
    ctx.emit('statuses');
    renderNav();
    renderChips();
    renderBanners();
  } catch { /* keep what we have */ }
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
  ctx.on('pending', renderPending);
}

function renderNav() {
  const nav = $('#nav');
  const current = currentPageId();
  const items = PAGES.map(p => {
    const badgeVal = navBadge(p.id);
    const b = h('a', { class: 'nav-item', href: '#/' + p.id, 'aria-current': p.id === current ? 'page' : null, 'data-page': p.id, 'data-tip': p.title },
      h('span', { class: 'nav-icon' }, icon(p.icon, 19)),
      h('span', { class: 'nav-label', text: p.title }),
      badgeVal ? h('span', { class: 'nav-badge', text: badgeVal.text, title: badgeVal.title }) : null);
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
  else if (m.admin === false) box.appendChild(h('span', { class: 'mode-chip chip-warn', title: 'Ohne Administratorrechte können viele Tweaks nicht gesetzt werden. Starte VELOX über Start.bat.' }, icon('alert', 14), h('span', { class: 'chip-long', text: 'Keine Adminrechte' }), h('span', { class: 'chip-short', text: 'Kein Admin' })));
  if (ctx.state.needs && ctx.state.needs.reboot) {
    const b = h('button', { class: 'mode-chip chip-reboot ripple-host', type: 'button', title: 'Einige Änderungen wirken erst nach einem Neustart.' }, icon('restart', 14), h('span', { text: 'Neustart nötig' }));
    b.addEventListener('click', askReboot);
    box.appendChild(b);
  }
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

function renderBanners() {
  const box = clear($('#banners'));
  const n = ctx.state.needs || {};
  if (n.explorer) {
    const b = h('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, icon('refresh', 15), h('span', { class: 'btn-label', text: 'Explorer neu starten' }));
    b.addEventListener('click', () => runJob('explorer-restart', {}, {}));
    box.appendChild(h('div', { class: 'banner banner-info', role: 'status' }, h('div', { class: 'banner-icon' }, icon('refresh', 18)),
      h('div', { class: 'banner-text' }, h('strong', { text: 'Explorer neu starten' }), h('span', { text: 'Ein paar Änderungen werden erst sichtbar, wenn Taskleiste und Explorer neu laden. Offene Explorer-Fenster schließen sich dabei.' })), b));
  }
  if (n.logoff) {
    box.appendChild(h('div', { class: 'banner banner-info', role: 'status' }, h('div', { class: 'banner-icon' }, icon('user', 18)),
      h('div', { class: 'banner-text' }, h('strong', { text: 'Abmelden nötig' }), h('span', { text: 'Melde dich einmal ab und wieder an, damit alle Änderungen wirken.' }))));
  }
  if (n.reboot) {
    const b = h('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, icon('restart', 15), h('span', { class: 'btn-label', text: 'Neu starten …' }));
    b.addEventListener('click', askReboot);
    box.appendChild(h('div', { class: 'banner banner-warn', role: 'status' }, h('div', { class: 'banner-icon' }, icon('restart', 18)),
      h('div', { class: 'banner-text' }, h('strong', { text: 'Neustart nötig' }), h('span', { text: 'Einige Änderungen wirken erst nach einem Neustart. Du kannst auch später neu starten.' })), b));
  }
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
  if (pop.hidden) { fillPendingList(); pop.hidden = false; $('#pending-list-btn').setAttribute('aria-expanded', 'true'); }
  else { pop.hidden = true; $('#pending-list-btn').setAttribute('aria-expanded', 'false'); }
}
function fillPendingList() {
  const pop = clear($('#pending-pop'));
  if (!ctx.pending.size) { pop.hidden = true; return; }
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
  $('#pending-pop').hidden = true;
  const onIds = []; const offIds = [];
  for (const [id, v] of ctx.pending) (v ? onIds : offIds).push(id);
  let okCount = 0; let failCount = 0;
  if (onIds.length) {
    const job = await runJob('apply', { ids: onIds, label: 'Tweaks: ' + plural(onIds.length, 'aktiviert', 'aktiviert') }, { quiet: true });
    if (job && job.status === 'done') { for (const id of onIds) ctx.pending.delete(id); const r = summarize(job); okCount += r.ok; failCount += r.fail; }
    else if (job && job.status === 'error') { ctx.emit('pending'); return; }
    else if (!job || job.status === 'cancelled') { ctx.emit('pending'); return; }
  }
  if (offIds.length) {
    const job = await runJob('revert', { ids: offIds, label: 'Tweaks: ' + plural(offIds.length, 'zurückgesetzt', 'zurückgesetzt') }, { quiet: true });
    if (job && job.status === 'done') { for (const id of offIds) ctx.pending.delete(id); const r = summarize(job); okCount += r.ok; failCount += r.fail; }
  }
  ctx.emit('pending');
  if (okCount || failCount) {
    toast({
      type: failCount ? 'warn' : 'ok',
      title: failCount ? okCount + ' erledigt, ' + failCount + ' fehlgeschlagen' : plural(okCount, 'Änderung', 'Änderungen') + ' angewendet',
      text: failCount ? 'Details findest du im Protokoll und unter Sicherungen.' : 'Alles wurde gesichert. Unter "Sicherungen" kannst du es jederzeit rückgängig machen.'
    });
  }
}
function summarize(job) {
  const res = (job.result && job.result.results) || [];
  return { ok: res.filter(r => r.ok).length, fail: res.filter(r => !r.ok).length };
}

// ------------------------------------------------------------------ jobs
/**
 * Starts a job and follows it. opts: { overlay (default true), title, subtitle, quiet (no result toast),
 * onUpdate(job) }. Resolves with the final job, or null when it could not start.
 */
async function runJob(type, params, opts = {}) {
  if (ctx.busy) {
    if (!opts.quietBusy) toast({ type: 'warn', title: 'Bitte kurz warten', text: 'Gerade läuft noch: ' + (JOB_META[ctx.busy.type] || {}).title + '.' });
    return null;
  }
  ctx.busy = { id: null, type };
  ctx.emit('busy', ctx.busy);
  let jobId;
  try {
    const r = await api.startJob(type, params || {});
    jobId = r.jobId;
  } catch (e) {
    ctx.busy = null; ctx.emit('busy', null);
    if (e.status === 409 && e.body && e.body.jobId) {
      toast({ type: 'info', title: 'VELOX ist gerade beschäftigt', text: 'Ich zeige dir die laufende Aufgabe.' });
      await follow(e.body.jobId, 'apply', {});
      return null;
    }
    if (e.status !== 0) toast({ type: 'error', title: (JOB_META[type] || {}).title || 'Aufgabe', text: e.message });
    return null;
  }
  return follow(jobId, type, opts);
}

async function follow(jobId, type, opts = {}) {
  const meta = JOB_META[type] || { title: 'Aufgabe läuft', icon: 'bolt' };
  ctx.busy = { id: jobId, type };
  ctx.emit('busy', ctx.busy);
  root.classList.add('is-busy');
  const overlay = opts.overlay === false ? null : jobOverlay({
    title: opts.title || meta.title, subtitle: opts.subtitle || (ctx.mode.simulate && meta.mutating ? 'Testmodus: Änderungen werden nur simuliert.' : null),
    cancellable: !!meta.cancel, icon: meta.icon,
    onCancel: () => api.cancelJob(jobId).catch(() => {})
  });
  let job;
  try {
    job = await pollJob(jobId, (j) => { if (overlay) overlay.update(j); if (opts.onUpdate) opts.onUpdate(j); });
  } catch (e) {
    if (overlay) overlay.close();
    ctx.busy = null; ctx.emit('busy', null); root.classList.remove('is-busy');
    if (e.status !== 0) toast({ type: 'error', title: meta.title, text: e.message });
    return null;
  }
  ctx.busy = null;
  ctx.emit('busy', null);
  root.classList.remove('is-busy');
  if (overlay) overlay.finish(job);
  if (opts.onUpdate) opts.onUpdate(job);

  if (job.status === 'done' && job.result) applyResultLocally(type, job.result);
  if (meta.mutating || type === 'scan') await refreshState();

  if (job.status === 'error') toast({ type: 'error', title: meta.title + ' – fehlgeschlagen', text: job.error || 'Unbekannter Fehler' });
  else if (job.status === 'cancelled') toast({ type: 'info', title: 'Abgebrochen', text: 'Bereits erledigte Schritte bleiben gesichert.' });
  else if (!opts.quiet) resultToast(type, job.result || {});
  return job;
}

function applyResultLocally(type, r) {
  if ((type === 'apply' || type === 'revert') && Array.isArray(r.results)) {
    for (const x of r.results) if (x && x.id && x.status) ctx.state.statuses[x.id] = x.status;
    ctx.emit('statuses');
  }
  if (type === 'scan' && r.statuses) { ctx.state.statuses = r.statuses; if (r.profile) ctx.state.profile = r.profile; ctx.emit('statuses'); ctx.emit('state'); }
  if (r.needs && typeof r.needs === 'object') { Object.assign(ctx.state.needs, r.needs); renderBanners(); renderChips(); }
}

function resultToast(type, r) {
  switch (type) {
    case 'apply': case 'revert': {
      const res = r.results || [];
      const ok = res.filter(x => x.ok).length; const fail = res.length - ok;
      const firstErr = res.find(x => !x.ok);
      toast({
        type: fail ? 'warn' : 'ok',
        title: fail ? ok + ' erledigt, ' + fail + ' fehlgeschlagen' : (type === 'apply' ? plural(ok, 'Tweak', 'Tweaks') + ' angewendet' : plural(ok, 'Tweak', 'Tweaks') + ' zurückgesetzt'),
        text: fail && firstErr ? (ctx.byId.get(firstErr.id) || { name: firstErr.id }).name + ': ' + (firstErr.error || 'Fehler') : 'Gesichert – unter "Sicherungen" jederzeit rückgängig.',
        action: r.backupId ? { label: 'Rückgängig', onClick: () => undoBackup(r.backupId) } : null
      });
      break;
    }
    case 'restorepoint': toast({ type: r.ok === false ? 'warn' : 'ok', title: r.ok === false ? 'Kein Wiederherstellungspunkt' : 'Wiederherstellungspunkt erstellt', text: r.message || '' }); break;
    case 'restore': toast({ type: r.failed ? 'warn' : 'ok', title: plural(r.restored || 0, 'Änderung', 'Änderungen') + ' wiederhergestellt', text: r.failed ? r.failed + ' konnten nicht zurückgesetzt werden.' : 'Dein PC ist auf dem Stand dieser Sicherung.' }); break;
    case 'explorer-restart': toast({ type: 'ok', title: 'Explorer neu gestartet' }); break;
    case 'reboot': toast({ type: 'info', title: ctx.mode.simulate ? 'Neustart protokolliert (Testmodus)' : 'Neustart in 10 Sekunden', text: ctx.mode.simulate ? 'Im Testmodus startet der PC nicht neu.' : 'Speichere jetzt deine offenen Dateien.' }); break;
    default: break;
  }
}

async function undoBackup(backupId) {
  const job = await runJob('restore', { backupId }, { title: 'Wird rückgängig gemacht' });
  if (job && job.status === 'done') { ctx.cache.backups = null; ctx.emit('backups'); }
}

async function refreshState() {
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
  } catch { /* connection handling lives in api.js */ }
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
  const s = $('#splash');
  s.hidden = false;
  s.classList.remove('gone');
  s.classList.add('scanning');
  $('#splash-step').textContent = 'Hardware wird erkannt …';
}
function updateSplash(job) {
  const s = $('#splash');
  if (s.hidden) return;
  const p = Math.round((job.progress || 0) * 100);
  $('#splash-bar').style.transform = 'scaleX(' + Math.max(0.03, p / 100) + ')';
  if (job.step) $('#splash-step').textContent = job.step;
  $('#splash-pct').textContent = p + ' %';
}
function hideSplash() {
  const s = $('#splash');
  if (s.hidden || s.classList.contains('gone')) return;
  s.classList.add('gone');
  setTimeout(() => { s.hidden = true; }, reducedMotion() ? 150 : 450);
}

let ended = false;
function showEnded(reason) {
  if (ended) return;
  ended = true;
  const el = $('#ended');
  const title = reason === 'token' ? 'Sitzung ungültig' : 'VELOX wurde beendet';
  const text = reason === 'token'
    ? 'Dieses Fenster gehört zu einer alten Sitzung. Starte VELOX neu über Start.bat.'
    : 'Du kannst dieses Fenster schließen. Zum Weitermachen VELOX einfach wieder über Start.bat starten.';
  clear(el).appendChild(h('div', { class: 'ended-card' },
    h('div', { class: 'ended-icon' }, icon('power', 30)),
    h('h1', { class: 'ended-title', text: title }),
    h('p', { class: 'ended-text', text })));
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  $('#app').setAttribute('inert', '');
  $('#splash').hidden = true;
}
function showBootError(msg) {
  const el = $('#ended');
  const retry = h('button', { class: 'btn btn-primary', type: 'button' }, icon('refresh', 16), h('span', { class: 'btn-label', text: 'Erneut versuchen' }));
  retry.addEventListener('click', () => location.reload());
  clear(el).appendChild(h('div', { class: 'ended-card' },
    h('div', { class: 'ended-icon tone-error' }, icon('alert', 30)),
    h('h1', { class: 'ended-title', text: 'VELOX konnte nicht starten' }),
    h('p', { class: 'ended-text', text: msg || 'Unbekannter Fehler.' }), retry));
  el.hidden = false;
  el.classList.add('show');
  $('#splash').hidden = true;
}

// ------------------------------------------------------------------ command palette
function openPalette() {
  if ($('.palette')) return;
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
    { label: 'Wiederherstellungspunkt erstellen', hint: 'Sicherheitsnetz für Windows', icon: 'shieldCheck', run: () => runJob('restorepoint', { label: 'VELOX manuell' }) },
    { label: 'System neu scannen', hint: 'Hardware und Status neu lesen', icon: 'refresh', run: () => initialScan(false) },
    { label: 'Explorer neu starten', hint: 'Taskleiste und Explorer neu laden', icon: 'refresh', run: () => runJob('explorer-restart', {}) },
    { label: 'Vorgemerkte Änderungen anwenden', hint: 'Anwenden-Leiste ausführen', icon: 'check', run: () => applyPending(), when: () => ctx.pending.size > 0 },
    { label: 'Animationen umschalten', hint: 'Voll / Reduziert', icon: 'motion', run: () => saveSettings({ motion: ctx.settings.motion === 'reduced' ? 'full' : 'reduced' }) }
  ];
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function score(q, text) {
    const t = norm(text);
    if (!q) return 1;
    if (t.startsWith(q)) return 3;
    if (t.includes(' ' + q)) return 2.5;
    if (t.includes(q)) return 2;
    const words = q.split(/\s+/).filter(Boolean);
    return words.length > 1 && words.every(w => t.includes(w)) ? 1.5 : 0;
  }
  function build() {
    const q = norm(input.value.trim());
    items = [];
    const pages = PAGES.map(p => ({ kind: 'page', label: p.title, hint: p.desc || '', icon: p.icon, run: () => navigate(p.id), s: score(q, p.title + ' ' + (p.keywords || '')) })).filter(x => x.s > 0);
    const acts = actions.filter(a => !a.when || a.when()).map(a => Object.assign({ kind: 'action', s: score(q, a.label + ' ' + a.hint) }, a)).filter(x => x.s > 0);
    let tw = [];
    if (q.length >= 2) {
      tw = ctx.tweaks.filter(t => (t.kind || 'toggle') === 'toggle').map(t => ({ t, s: Math.max(score(q, t.name) * 1.2, score(q, t.desc) * 0.6, score(q, t.id) * 0.8, score(q, (t.tags || []).join(' ')) * 0.5) }))
        .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 30)
        .map(({ t, s }) => ({ kind: 'tweak', t, label: t.name, hint: ctx.catName(t.category), icon: (ctx.catById.get(t.category) || {}).icon || 'sliders', s }));
    }
    const groups = q ? [['Tweaks', tw], ['Seiten', pages], ['Aktionen', acts]] : [['Seiten', pages], ['Aktionen', acts]];
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
    if (!items.length) list.appendChild(h('div', { class: 'palette-empty' }, icon('search', 22), h('span', { text: 'Nichts gefunden. Versuch es mit "Maus", "Ping" oder "Copilot".' })));
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
      if (ok) toast({ type: 'ok', title: (ctx.pending.has(it.t.id) ? 'Vorgemerkt: ' : 'Zurückgenommen: ') + it.t.name, text: ctx.pending.has(it.t.id) ? (next ? 'Wird eingeschaltet' : 'Wird ausgeschaltet') + ', sobald du unten auf "Anwenden" klickst.' : 'Die vorgemerkte Änderung wurde entfernt.' });
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

