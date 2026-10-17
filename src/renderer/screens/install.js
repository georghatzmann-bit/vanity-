// Installation – installs store.installJob.items via api.install.start() and visualises the
// install:event stream (ARCHITECTURE §6): reactor hero with overall %, current-item spotlight,
// queue with lanes and results, UAC banner, live log drawer, cancel. On job-done it writes
// store.installJob.result and moves on to "done". Contract: ARCHITECTURE §10.
//
// The event recorder (session) lives at module level and outlives a single mount until job-done,
// so a remount (or a quick navigation) never loses events and never starts the job twice.
import '../styles/screens/install.css';
import { h, on } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { Button } from '../components/button.js';
import { Badge } from '../components/badge.js';
import { ProgressBar } from '../components/progressBar.js';
import { AppIcon } from '../components/appCard.js';
import { EmptyState } from '../components/emptyState.js';
import { InstallReactor } from '../components/install-reactor.js';
import { InstallLog } from '../components/install-log.js';
import { ElevationBanner } from '../components/install-elevation.js';
import { gsap, motionOK, richMotion, revealText, scrambleText } from '../core/motion.js';
import { formatBytes, formatEta, formatDuration, formatNumber, plural, joinList } from '../core/format.js';

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

const STAGE_TEXT = {
  resolving: 'Wird gesucht …',
  downloading: 'Lädt herunter …',
  verifying: 'Wird geprüft …',
  installing: 'Wird installiert …',
};
const STAGE_LOG = {
  downloading: 'Download läuft',
  verifying: 'Download wird geprüft',
  installing: 'Installer läuft',
};
const PHASE_TEXT = {
  starting: 'Wird vorbereitet …',
  'winget-check': 'winget wird geprüft …',
  elevating: 'Warte auf die Windows-Abfrage …',
  installing: 'Installation läuft',
  finishing: 'Abschluss …',
};
const STATUS = {
  pending: null,
  active: { tone: 'accent', label: 'Läuft', dot: true, live: true },
  requeued: { tone: 'warn', label: 'Gleich nochmal', icon: 'refresh' },
  installed: { tone: 'ok', label: 'Installiert', icon: 'check' },
  already: { tone: 'neutral', label: 'War schon da', icon: 'check' },
  failed: { tone: 'err', label: 'Fehlgeschlagen', icon: 'x' },
  skipped: { tone: 'warn', label: 'Übersprungen', icon: 'minus' },
  cancelled: { tone: 'neutral', label: 'Abgebrochen', icon: 'minus' },
};
const DONE = new Set(['installed', 'already', 'failed', 'skipped', 'cancelled']);
const LANE = {
  admin: { label: 'Admin', icon: 'shield', tip: 'Admin: wird mit Administratorrechten installiert – eine Windows-Abfrage gilt für alle.' },
  user: { label: 'Benutzer', icon: 'user', tip: 'Benutzer: wird nur für dein Konto installiert – ohne Administratorrechte.' },
};
const LOG_MAX = 300;

const pad2 = (n) => String(n).padStart(2, '0');
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Same lane rule as main/install/queue.js – only used until job-start brings the real order. */
function laneOf(item) {
  return item.elevation === 'prohibited' || item.scope === 'user' || item.scope === 'both' || item.source === 'msstore' ? 'user' : 'admin';
}

function splitKey(key) {
  const i = String(key).indexOf(':');
  return i > 0 ? { source: key.slice(0, i), id: key.slice(i + 1) } : { source: 'winget', id: String(key) };
}

// ---------------------------------------------------------------------------------------------
// Catalog (names, favicons, elevation/scope for seeding)
// ---------------------------------------------------------------------------------------------

let catalogPromise = null;
function catalogIndex(api) {
  if (!catalogPromise) {
    catalogPromise = api.catalog
      .get()
      .then((cat) => {
        const map = new Map();
        for (const it of cat?.items || []) map.set(`${it.source}:${String(it.id).toLowerCase()}`, it);
        return { cat, map };
      })
      .catch((err) => {
        catalogPromise = null;
        throw err;
      });
  }
  return catalogPromise;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)))]).finally(() => clearTimeout(t));
}

/** Normalises anything item-like (InstallItem, AppEntry, CatalogItem) into a display + install item. */
function toItem(it, map) {
  const source = it.source === 'msstore' ? 'msstore' : 'winget';
  const id = String(it.id || splitKey(it.key || '').id || '').trim();
  const c = map?.get(`${source}:${id.toLowerCase()}`);
  const pick = (v, fallback) => (v && v !== 'unknown' ? v : fallback || 'unknown');
  return {
    key: it.key || `${source}:${id}`,
    id,
    source,
    name: it.name || c?.name || id,
    elevation: pick(it.elevation, c?.elevation),
    scope: pick(it.scope, c?.scope),
    homepage: it.homepage || c?.homepage || null,
    icon: it.icon || null,
  };
}

/** ?screen=install without a job: build one from the profile selection or the popular catalog apps. */
async function seedJob({ store }, index) {
  const { cat, map } = index;
  const profile = store.get('profile');
  const sel = store.get('selection');
  let items = [];
  if (profile?.apps?.length) {
    const picked = sel && sel.size ? profile.apps.filter((a) => sel.has(`${a.source}:${a.id}`)) : profile.apps;
    items = picked.filter((a) => a.source === 'winget' || a.source === 'msstore').map((a) => toItem(a, map));
  }
  if (!items.length) items = (cat?.items || []).filter((i) => i.popular && i.source === 'winget').map((i) => toItem(i, map));
  const links = (cat?.items || []).filter((i) => i.source === 'link').slice(0, 2);
  const games = profile?.games || store.get('games') || [];
  const job = { items, links, games, seeded: true };
  store.set('installJob', job);
  return job;
}

// ---------------------------------------------------------------------------------------------
// Session: event recorder + state (module level, one per job)
// ---------------------------------------------------------------------------------------------

let session = null;
let sessionSeq = 0;

function newSession(job, map, store) {
  const s = {
    seq: ++sessionSeq,
    store,
    jobId: null,
    order: [],
    rows: new Map(),
    phase: 'starting',
    phaseMessage: PHASE_TEXT.starting,
    elevation: null,
    logs: [],
    startedAt: Date.now(),
    startCount: 0,
    currentKey: null,
    overall: 0,
    etaShown: null,
    finished: false,
    cancelRequested: false,
    error: null,
    summary: null,
    durationMs: 0,
    byKey: {},
    listeners: new Set(),
    unsub: null,
  };
  // 'link' items are never sent to main – the done screen lists them for manual download.
  for (const it of job.items || []) if (it && it.source !== 'link') addRow(s, toItem(it, map));
  return s;
}

function addRow(s, it, lane) {
  if (s.rows.has(it.key)) return s.rows.get(it.key);
  const row = {
    key: it.key,
    id: it.id,
    source: it.source,
    name: it.name || it.id,
    homepage: it.homepage || null,
    icon: it.icon || null,
    elevation: it.elevation || 'unknown',
    scope: it.scope || 'unknown',
    lane: lane || laneOf(it),
    status: 'pending',
    stage: null,
    stageAt: 0,
    pct: null,
    bytes: null,
    message: '',
    codeHex: '',
    rebootRequired: false,
    durationMs: 0,
    attempts: 0,
    startedAt: 0,
    startSeq: 0,
  };
  s.rows.set(row.key, row);
  s.order.push(row.key);
  return row;
}

function rowFromKey(s, key, name) {
  const { source, id } = splitKey(key);
  return s.rows.get(key) || addRow(s, { key, id, source, name: name || id });
}

function pushLog(s, level, text, who = '') {
  const entry = { t: new Date(), level, text: String(text || ''), who };
  s.logs.push(entry);
  if (s.logs.length > LOG_MAX) s.logs.splice(0, s.logs.length - LOG_MAX);
  return entry;
}

function countDone(s) {
  let n = 0;
  for (const k of s.order) if (DONE.has(s.rows.get(k).status)) n++;
  return n;
}

function tally(s) {
  const t = { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const k of s.order) {
    const st = s.rows.get(k).status;
    if (t[st] !== undefined) t[st]++;
  }
  return t;
}

/** Applies one install event to the session. Returns hints for the view. */
function reduce(s, e) {
  const info = { logs: [] };
  const log = (level, text, who) => info.logs.push(pushLog(s, level, text, who));
  switch (e.type) {
    case 'job-start': {
      if (e.jobId) s.jobId = e.jobId;
      const next = [];
      for (const it of e.items || []) {
        if (!it || !it.key) continue;
        const row = rowFromKey(s, it.key, it.name);
        if (it.lane === 'admin' || it.lane === 'user') row.lane = it.lane;
        if (!next.includes(it.key)) next.push(it.key);
      }
      for (const k of s.order) if (!next.includes(k)) next.push(k);
      s.order = next;
      const admin = s.order.filter((k) => s.rows.get(k).lane === 'admin').length;
      const user = s.order.length - admin;
      log('info', `Reihenfolge steht: ${plural(s.order.length, 'App', 'Apps')} – ${admin} mit Adminrechten, ${user} als Benutzer`);
      info.reordered = true;
      break;
    }
    case 'phase': {
      s.phase = e.phase || s.phase;
      s.phaseMessage = PHASE_TEXT[e.phase] || e.message || s.phaseMessage;
      if (e.message) log('info', e.message);
      break;
    }
    case 'elevation': {
      s.elevation = { status: e.status, message: e.message || '' };
      const fallback = { requested: 'Administratorrechte werden angefordert', granted: 'Administratorrechte erteilt', declined: 'Administratorrechte abgelehnt', failed: 'Admin-Modus nicht verfügbar' };
      log(e.status === 'granted' ? 'ok' : e.status === 'requested' ? 'info' : 'warn', e.message || fallback[e.status] || e.status);
      break;
    }
    case 'item-start': {
      const row = rowFromKey(s, e.key);
      if (s.currentKey && s.currentKey !== row.key) {
        const prev = s.rows.get(s.currentKey);
        // The previous item left the admin lane without a result: main retries it in the user lane later.
        if (prev && prev.status === 'active') {
          prev.status = 'requeued';
          prev.stage = null;
          prev.lane = 'user';
          info.prevKey = prev.key;
        }
      }
      row.attempts += 1;
      if (row.attempts > 1) row.lane = 'user';
      Object.assign(row, { status: 'active', stage: 'resolving', stageAt: Date.now(), pct: null, bytes: null, message: '', codeHex: '', startedAt: Date.now(), startSeq: ++s.startCount });
      s.currentKey = row.key;
      // Started rows stay in start order at the top: a retried item moves behind everything that already ran.
      const from = s.order.indexOf(row.key);
      const to = s.order.filter((k) => k !== row.key && (s.rows.get(k).startSeq > 0 || DONE.has(s.rows.get(k).status))).length;
      if (from !== to) {
        s.order.splice(from, 1);
        s.order.splice(to, 0, row.key);
        info.moved = true;
      }
      log('run', row.attempts > 1 ? 'Zweiter Versuch – diesmal ohne Administratorrechte' : 'Wird installiert', row.name);
      info.row = row;
      break;
    }
    case 'item-progress': {
      const row = s.rows.get(e.key);
      if (!row || DONE.has(row.status)) break;
      if (row.status !== 'active') {
        row.status = 'active';
        s.currentKey = row.key;
        info.activated = true;
      }
      if (e.stage && row.stage !== e.stage) {
        row.stage = e.stage;
        row.stageAt = Date.now();
        if (STAGE_LOG[e.stage]) {
          const size = e.stage === 'downloading' && e.bytes?.total ? ` (${formatBytes(e.bytes.total)})` : '';
          log('info', `${STAGE_LOG[e.stage]}${size}`, row.name);
        }
      }
      row.pct = Number.isFinite(e.pct) ? Math.min(100, Math.max(0, e.pct)) : null;
      // Bytes are kept after the download so the installing stage can still say how big it was.
      if (e.bytes && Number(e.bytes.total) > 0) row.bytes = { done: Number(e.bytes.done) || 0, total: Number(e.bytes.total) };
      info.row = row;
      break;
    }
    case 'item-done': {
      const row = rowFromKey(s, e.key);
      info.wasDone = DONE.has(row.status);
      row.status = DONE.has(e.status) ? e.status : 'failed';
      row.message = e.message || '';
      row.codeHex = e.codeHex || (Number.isFinite(e.code) && e.code ? `0x${(e.code >>> 0).toString(16).toUpperCase()}` : '');
      row.rebootRequired = !!e.rebootRequired;
      row.durationMs = Number(e.durationMs) || (row.startedAt ? Date.now() - row.startedAt : 0);
      row.stage = null;
      s.byKey[row.key] = { ...e, status: row.status, codeHex: row.codeHex || undefined };
      if (s.currentKey === row.key) s.currentKey = null;
      const level = { installed: 'ok', already: 'ok', failed: 'err', skipped: 'warn', cancelled: 'warn' }[row.status];
      const text = { installed: `Installiert (${formatDuration(row.durationMs)})`, already: 'War schon installiert' }[row.status] || row.message || STATUS[row.status].label;
      log(level, `${text}${row.status === 'failed' && row.codeHex ? ` · Code ${row.codeHex}` : ''}${row.rebootRequired ? ' · Neustart nötig' : ''}`, row.name);
      info.row = row;
      break;
    }
    case 'log': {
      const row = e.key ? s.rows.get(e.key) : null;
      if (row && row.status === 'active' && /erneut installiert/i.test(String(e.line))) {
        row.status = 'requeued';
        row.stage = null;
        row.lane = 'user';
        if (s.currentKey === row.key) s.currentKey = null;
        info.row = row;
      }
      if (e.line) log(row ? 'raw' : 'info', e.line, row ? row.name : '');
      break;
    }
    case 'job-done': {
      s.finished = true;
      s.summary = { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0, rebootRequired: false, ...(e.summary || {}) };
      s.durationMs = Number(e.durationMs) || Date.now() - s.startedAt;
      for (const k of s.order) {
        const r = s.rows.get(k);
        if (DONE.has(r.status)) continue;
        // Never reported by main (should not happen) – count it honestly instead of leaving it "running".
        r.status = s.cancelRequested ? 'cancelled' : 'skipped';
        r.message = s.cancelRequested ? 'Abgebrochen' : 'Wurde nicht ausgeführt';
        r.stage = null;
        s.byKey[k] = { type: 'item-done', key: k, status: r.status, rebootRequired: false, message: r.message, durationMs: 0 };
        s.summary[r.status] = (s.summary[r.status] || 0) + 1;
      }
      if (Object.values(s.byKey).some((d) => d.rebootRequired)) s.summary.rebootRequired = true;
      s.currentKey = null;
      s.overall = 1;
      const t = s.summary;
      const parts = [t.installed && `${t.installed} installiert`, t.already && `${t.already} schon da`, t.failed && `${t.failed} fehlgeschlagen`, t.skipped && `${t.skipped} übersprungen`, t.cancelled && `${t.cancelled} abgebrochen`].filter(Boolean);
      log(t.failed ? 'warn' : 'ok', `Fertig nach ${formatDuration(s.durationMs)}: ${joinList(parts) || 'nichts zu tun'}`);
      break;
    }
    default:
      break;
  }
  return info;
}

function notify(s, e, info) {
  for (const fn of [...s.listeners]) {
    try {
      fn(e, info);
    } catch (err) {
      console.error('[install] view update failed', err);
    }
  }
}

function dispatch(s, e) {
  if (!e || typeof e !== 'object' || !e.type) return;
  if (s.finished) return; // late events after job-done
  if (e.type === 'job-start' && s.jobId && e.jobId && e.jobId !== s.jobId) return;
  const info = reduce(s, e);
  if (e.type === 'job-done') finalize(s);
  notify(s, e, info);
}

function finalize(s) {
  s.unsub?.();
  s.unsub = null;
  const result = { summary: s.summary, byKey: s.byKey, durationMs: s.durationMs, elevation: s.elevation?.status || null };
  const cur = s.store.get('installJob');
  if (cur && cur.sessionSeq === s.seq) s.store.patch('installJob', { result, jobId: s.jobId, finishedAt: Date.now() });
}

async function startSession(s, job, { api, store }) {
  // Subscribe BEFORE start: events may stream before the start promise resolves.
  s.unsub = api.on('install:event', (e) => dispatch(s, e));
  store.set('installJob', { ...job, started: true, sessionSeq: s.seq, jobId: null, result: null });
  const items = s.order.map((k) => {
    const r = s.rows.get(k);
    return { key: r.key, id: r.id, source: r.source, name: r.name, elevation: r.elevation, scope: r.scope };
  });
  notify(s, { type: 'local-log' }, { logs: [pushLog(s, 'info', `${plural(items.length, 'App wird', 'Apps werden')} nacheinander installiert`)] });
  try {
    const res = await api.install.start(items);
    if (res?.jobId && !s.jobId) s.jobId = res.jobId;
    if (store.get('installJob')?.sessionSeq === s.seq && !s.finished) store.patch('installJob', { jobId: s.jobId });
  } catch (err) {
    s.unsub?.();
    s.unsub = null;
    s.error = (err && err.message) || 'Unbekannter Fehler';
    s.phase = 'error';
    if (store.get('installJob')?.sessionSeq === s.seq) store.patch('installJob', { started: false });
    notify(s, { type: 'start-error', message: s.error }, { logs: [pushLog(s, 'err', `Start fehlgeschlagen: ${s.error}`)] });
  }
}

// ---------------------------------------------------------------------------------------------
// Progress math
// ---------------------------------------------------------------------------------------------

/** 0..1 for the running item: download is ~60 %, the silent installer creeps toward 96 %. */
function itemFraction(row, now) {
  if (!row || row.status !== 'active') return 0;
  const dl = row.pct != null ? row.pct / 100 : row.bytes?.total ? row.bytes.done / row.bytes.total : 0;
  switch (row.stage) {
    case 'downloading':
      return 0.06 + 0.6 * clamp01(dl);
    case 'verifying':
      return 0.68;
    case 'installing': {
      if (row.pct != null) return 0.72 + 0.26 * clamp01(row.pct / 100);
      const t = (now - row.stageAt) / 1000;
      return 0.72 + 0.24 * (1 - Math.exp(-t / 12));
    }
    default:
      return 0.03;
  }
}

function computeOverall(s, now) {
  const total = s.order.length;
  if (!total) return 0;
  if (s.finished) return 1;
  const cur = s.currentKey ? s.rows.get(s.currentKey) : null;
  return clamp01((countDone(s) + itemFraction(cur, now)) / total);
}

function computeEta(s, now) {
  const rows = s.order.map((k) => s.rows.get(k));
  const timed = rows.filter((r) => (r.status === 'installed' || r.status === 'failed' || r.status === 'already') && r.durationMs > 0);
  const waiting = rows.filter((r) => r.status === 'pending' || r.status === 'requeued').length;
  const cur = s.currentKey ? s.rows.get(s.currentKey) : null;
  let avg = timed.length ? timed.reduce((a, r) => a + r.durationMs, 0) / timed.length : null;
  if (avg == null && cur) {
    const f = itemFraction(cur, now);
    const el = now - cur.startedAt;
    if (f > 0.12 && el > 1500) avg = el / f;
  }
  if (avg == null) return null;
  const curLeft = cur ? Math.max(0, avg * (1 - itemFraction(cur, now))) : 0;
  return curLeft + waiting * avg;
}

// ---------------------------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------------------------

export default {
  title: 'Installation',
  // A remount after job-done keeps the success/error backdrop.
  fxState: () => {
    if (!session || !session.finished) return session && session.error ? 'error' : 'installing';
    const t = session.summary || {};
    return (t.installed || 0) + (t.already || 0) === 0 && (t.failed || 0) > 0 ? 'error' : 'success';
  },
  async mount(container, ctx) {
    const { api, store, router, fx, sound, toast, modal } = ctx;
    container.classList.add('screen--install');
    const cleanups = [];
    const timers = new Set();
    let alive = true;
    const later = (fn, ms) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (alive) fn();
      }, ms);
      timers.add(t);
      return t;
    };
    const cleanup = () => {
      alive = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      cleanups.splice(0).reverse().forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error('[install] cleanup', err);
        }
      });
    };

    // ---- data -----------------------------------------------------------------------------
    let index = { cat: null, map: new Map() };
    try {
      index = await withTimeout(catalogIndex(api), 2500);
    } catch {
      /* names/icons fall back to the item data and monograms */
    }
    let job = store.get('installJob');
    if (!job || !Array.isArray(job.items)) {
      try {
        job = index.cat ? await seedJob(ctx, index) : { items: [], links: [], games: [] };
      } catch {
        job = { items: [], links: [], games: [] };
      }
    }

    let s = null;
    let isNew = false;
    if (job.started && session && job.sessionSeq === session.seq) {
      s = session; // remount: attach to the running (or finished) job, never start twice
    } else if (job.started && job.result) {
      later(() => router.go('done', {}, { transition: 'fade', replace: true }), 0);
      return cleanup;
    } else if ((job.items || []).length) {
      s = session = newSession(job, index.map, store);
      isNew = true;
    }

    // ---- header -------------------------------------------------------------------------------
    const liveDot = h('span.inst__dot');
    const phaseEl = h('span.inst__phase', s ? s.phaseMessage : 'Nichts zu tun');
    const title = h('h1.inst__title', s ? 'Wird installiert.' : 'Nichts zu installieren.');
    const lead = h('p.inst__lead', 'Lehn dich zurück – PHOENIX installiert alles nacheinander im Hintergrund. Du musst nichts weiter tun.');
    const sideSlot = h('div.inst__side', { dataset: { stagger: '' } });
    const head = h(
      'header.inst__head',
      h('div.inst__head-main', h('div.t-eyebrow.inst__eyebrow', { dataset: { stagger: '' } }, liveDot, phaseEl), title, h('div', { dataset: { stagger: '' } }, lead)),
      sideSlot,
    );
    const inner = h('div.screen__inner.inst', head);
    container.append(inner);
    const tlTitle = revealText(title, { delay: 0.25 });
    cleanups.push(() => tlTitle?.kill());

    const relabel = (el, text) => {
      if (el.dataset.splitText !== undefined) {
        delete el.dataset.splitText;
        el.classList.remove('is-split');
        el.removeAttribute('aria-label');
      }
      const sc = scrambleText(el, text, { duration: 0.6 });
      cleanups.push(() => sc.cancel());
    };

    // ---- empty state --------------------------------------------------------------------------
    if (!s) {
      liveDot.classList.add('is-idle');
      lead.textContent = 'In deiner Auswahl ist keine App, die PHOENIX automatisch installieren kann.';
      const hasRest = (job.links || []).length || (job.games || []).length;
      const toSelect = () => router.go('select', { mode: store.get('profile') ? 'restore' : 'catalog' }, { transition: 'slide', direction: 'back' });
      const actions = [{ label: 'Zur Auswahl', icon: 'arrow-left', onClick: toSelect }];
      if (hasRest) {
        actions.push({
          label: 'Weiter zur Übersicht',
          iconRight: 'arrow-right',
          variant: 'secondary',
          onClick: () => {
            store.set('installJob', { ...job, started: true, result: { summary: { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0, rebootRequired: false }, byKey: {}, durationMs: 0, elevation: null } });
            router.go('done', {}, { transition: 'zoom', replace: true });
          },
        });
      }
      const empty = EmptyState({
        icon: 'layers',
        title: 'Hier gibt es nichts zu tun',
        text: hasRest ? 'Deine restlichen Apps und Spiele installierst du über die Übersicht – dort findest du die Download-Links.' : 'Wähl ein paar Apps aus, dann legt PHOENIX los.',
        actions,
      });
      empty.append(h('p.inst__empty-hint', hasRest ? '„Zur Auswahl“ lässt dich Apps hinzufügen · „Weiter zur Übersicht“ zeigt Links und Spiele.' : '„Zur Auswahl“ bringt dich zurück zur App-Liste.'));
      inner.append(h('section.card.inst__empty', { dataset: { stagger: '' } }, empty));
      fx.setProgress(0);
      return cleanup;
    }

    // ---- cancel / continue ----------------------------------------------------------------------
    const sideHint = h('p.inst__side-hint', 'Stoppt nach der aktuellen App. Bereits Installiertes bleibt.');
    const cancelBtn = Button({ label: 'Abbrechen', icon: 'x', variant: 'danger', onClick: () => onCancel() });
    sideSlot.append(cancelBtn, sideHint);
    cleanups.push(() => cancelBtn.destroy());
    let nextBtn = null;

    // ---- elevation banner -----------------------------------------------------------------------
    const banner = ElevationBanner();
    cleanups.push(() => banner.destroy());

    // ---- stage: reactor + spotlight --------------------------------------------------------------
    const reactor = InstallReactor({ total: s.order.length });
    cleanups.push(() => reactor.destroy());
    const spot = h('div.spot', { attrs: { 'aria-live': 'off' } });
    const stage = h('section.inst__stage', { dataset: { stagger: '' }, attrs: { 'aria-label': 'Aktueller Fortschritt' } }, h('div.inst__reactor-wrap', reactor), spot);

    // ---- queue ------------------------------------------------------------------------------------
    const qCount = h('span.inst__qcount.t-num');
    const list = h('ol.q', { attrs: { 'aria-label': 'Warteschlange', tabindex: '0' } });
    const queue = h(
      'section.inst__queue',
      { dataset: { stagger: '' } },
      h(
        'header.inst__qhead',
        h('div.inst__qhead-text', h('h2.inst__qtitle', 'Warteschlange'), h('p.inst__qhint', h('b', 'Admin'), ' = eine Windows-Abfrage für alle · ', h('b', 'Benutzer'), ' = nur für dein Konto')),
        qCount,
      ),
      list,
    );

    // ---- log drawer -------------------------------------------------------------------------------
    const logDrawer = InstallLog({
      max: LOG_MAX,
      onCopy: async (text) => {
        try {
          await api.clipboard.write(text);
          toast.success('Protokoll kopiert', 'Du kannst es jetzt z. B. in eine Support-Anfrage einfügen.');
        } catch (err) {
          toast.error('Kopieren hat nicht geklappt', err.message);
        }
      },
    });
    cleanups.push(() => logDrawer.destroy());

    const sr = h('div.sr-only', { attrs: { 'aria-live': 'polite' } });
    inner.append(banner, h('div.inst__grid', stage, queue), h('div.inst__log', { dataset: { stagger: '' } }, logDrawer), sr);

    // ---- rows -----------------------------------------------------------------------------------
    const rowEls = new Map();

    function subText(row) {
      const again = row.attempts > 1 ? '2. Versuch · ' : '';
      switch (row.status) {
        case 'pending':
          return 'Wartet';
        case 'active': {
          const base = STAGE_TEXT[row.stage] || STAGE_TEXT.resolving;
          const pct = row.stage === 'downloading' && row.pct != null ? ` ${formatNumber(Math.round(row.pct))} %` : '';
          return `${again}${base}${pct}`;
        }
        case 'requeued':
          return 'Wird gleich ohne Adminrechte noch einmal versucht';
        case 'installed':
          return `Installiert in ${formatDuration(row.durationMs)}${row.rebootRequired ? ' · Neustart nötig' : ''}`;
        case 'already':
          return 'War schon installiert – nichts zu tun';
        case 'failed':
          return row.message || 'Installation fehlgeschlagen';
        case 'skipped':
          return row.message || 'Übersprungen';
        case 'cancelled':
          return 'Abgebrochen – nicht installiert';
        default:
          return '';
      }
    }

    function laneChip(lane) {
      const l = LANE[lane] || LANE.admin;
      return h('span.q__lane', { title: l.tip, attrs: { 'aria-label': l.tip } }, icon(l.icon, { size: 12, strokeWidth: 2 }), l.label);
    }

    function buildRow(row) {
      const sub = h('div.q__sub');
      const badgeSlot = h('div.q__badge');
      const code = h('span.q__code.t-mono');
      const li = h(
        'li.q__row',
        { dataset: { key: row.key, s: row.status } },
        h('span.q__idx.t-mono'),
        AppIcon({ name: row.name, icon: row.icon, homepage: row.homepage, size: 34 }),
        h('div.q__body', h('div.q__name', row.name), h('div.q__subline', sub, code)),
        h('span.q__lane-slot'),
        badgeSlot,
        h('span.q__bar', { attrs: { 'aria-hidden': 'true' } }),
      );
      const ref = { li, sub, badgeSlot, code, laneSlot: li.querySelector('.q__lane-slot'), idx: li.querySelector('.q__idx'), status: null, lane: null };
      rowEls.set(row.key, ref);
      paintRow(row);
      return ref;
    }

    function paintRow(row) {
      const ref = rowEls.get(row.key) || buildRow(row);
      if (ref.status !== row.status) {
        ref.status = row.status;
        ref.li.dataset.s = row.status;
        const meta = STATUS[row.status];
        ref.badgeSlot.replaceChildren(meta ? Badge(meta) : h('span.q__wait', 'Wartet'));
      }
      if (ref.lane !== row.lane) {
        ref.lane = row.lane;
        ref.laneSlot.replaceChildren(laneChip(row.lane));
      }
      ref.sub.textContent = row.status === 'pending' ? (row.lane === 'admin' ? 'Wartet · mit Adminrechten' : 'Wartet · als Benutzer') : subText(row);
      ref.sub.title = row.status === 'failed' ? ref.sub.textContent : '';
      ref.code.textContent = row.status === 'failed' && row.codeHex ? row.codeHex : '';
      const p = row.status === 'active' ? itemFraction(row, Date.now()) : DONE.has(row.status) ? 1 : 0;
      ref.li.style.setProperty('--rp', p.toFixed(3));
      return ref;
    }

    function syncOrder(animate) {
      const rich = animate && richMotion();
      const first = rich ? new Map([...rowEls].map(([k, r]) => [k, r.li.getBoundingClientRect().top])) : null;
      const frag = document.createDocumentFragment();
      s.order.forEach((k, i) => {
        const ref = rowEls.get(k) || buildRow(s.rows.get(k));
        ref.idx.textContent = pad2(i + 1);
        frag.append(ref.li);
      });
      const top = list.scrollTop;
      list.append(frag);
      list.scrollTop = top;
      if (first) {
        for (const [k, y0] of first) {
          const li = rowEls.get(k)?.li;
          if (!li) continue;
          const dy = y0 - li.getBoundingClientRect().top;
          if (Math.abs(dy) > 1) gsap.fromTo(li, { y: dy }, { y: 0, duration: 0.7, ease: 'expo.out', clearProps: 'transform' });
        }
      }
      reactor.setTotal(s.order.length);
      s.order.forEach((k, i) => reactor.setSegment(i, s.rows.get(k).status));
    }

    function flashRow(row) {
      const li = rowEls.get(row.key)?.li;
      if (!li || !richMotion()) return;
      gsap.fromTo(li, { '--flash': 1 }, { '--flash': 0, duration: 1.4, ease: 'power2.out' });
    }

    // Auto-scroll follows the running app unless the user scrolled the list in the last 5 s.
    let userScrollUntil = 0;
    const markUser = () => (userScrollUntil = performance.now() + 5000);
    for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart']) cleanups.push(on(list, type, markUser, { passive: true }));
    function follow(force = false) {
      const key = s.currentKey || s.order.find((k) => !DONE.has(s.rows.get(k).status));
      if (!key) return;
      if (!force && performance.now() < userScrollUntil) return;
      const li = rowEls.get(key)?.li;
      if (!li) return;
      const top = Math.max(0, li.offsetTop - list.clientHeight * 0.32);
      if (Math.abs(list.scrollTop - top) < 4) return;
      list.scrollTo({ top, behavior: motionOK() ? 'smooth' : 'auto' });
    }

    // ---- spotlight ----------------------------------------------------------------------------------
    let spotRef = null;

    function nextName(afterKey) {
      const i = s.order.indexOf(afterKey);
      const k = s.order.slice(i + 1).find((x) => s.rows.get(x).status === 'pending') || s.order.find((x) => s.rows.get(x).status === 'requeued' && x !== afterKey);
      return k ? s.rows.get(k).name : '';
    }

    function buildSpotItem(row) {
      const bar = ProgressBar({ value: null, size: 'lg', active: true, label: `Fortschritt ${row.name}` });
      const stageEl = h('span.spot__stage');
      const pctEl = h('span.spot__pct.t-num');
      const bytesEl = h('span.spot__bytes.t-num');
      const nextEl = h('span.spot__next');
      const laneSlot = h('span.spot__lane');
      const el = h(
        'div.spot__card',
        h(
          'div.spot__top',
          h('div.spot__icon', h('span.spot__orbit.deco'), h('span.spot__orbit.spot__orbit--2.deco'), AppIcon({ name: row.name, icon: row.icon, homepage: row.homepage, size: 56 })),
          h('div.spot__text', h('div.spot__eyebrow', h('span.spot__live'), h('span', 'Jetzt dran'), laneSlot), h('div.spot__name', row.name), h('div.spot__line', stageEl, pctEl)),
        ),
        bar,
        h('div.spot__meta', bytesEl, nextEl),
      );
      return { kind: 'item', key: row.key, el, bar, stageEl, pctEl, bytesEl, nextEl, laneSlot, lane: null };
    }

    function buildSpotInfo({ iconName, eyebrow, name, text, tone = 'accent', bar = true }) {
      const pb = bar ? ProgressBar({ value: null, size: 'lg', label: name }) : null;
      const textEl = h('span.spot__stage', text);
      const el = h(
        `div.spot__card.spot__card--info.spot__card--${tone}`,
        h(
          'div.spot__top',
          h('div.spot__icon', h(`div.icon-tile.icon-tile--lg.spot__tile.spot__tile--${tone}`, icon(iconName))),
          h('div.spot__text', h('div.spot__eyebrow', h('span', eyebrow)), h('div.spot__name', name), h('div.spot__line', textEl)),
        ),
        pb,
      );
      return { kind: 'info', key: null, el, textEl, bar: pb };
    }

    function swapSpot(next) {
      const prev = spotRef;
      spotRef = next;
      if (!prev || !motionOK()) {
        spot.replaceChildren(next.el);
        return;
      }
      const rich = richMotion();
      gsap.killTweensOf([prev.el]);
      gsap.to(prev.el, {
        y: -14,
        opacity: 0,
        filter: rich ? 'blur(6px)' : 'none',
        duration: 0.2,
        ease: 'power2.in',
        onComplete: () => {
          if (spotRef !== next) return;
          spot.replaceChildren(next.el);
          gsap.fromTo(next.el, { y: 18, opacity: 0, filter: rich ? 'blur(8px)' : 'none' }, { y: 0, opacity: 1, filter: 'blur(0px)', duration: 0.55, ease: 'expo.out', clearProps: 'filter,transform,opacity' });
        },
      });
    }

    function paintSpotItem(row) {
      const r = spotRef;
      if (!r || r.kind !== 'item' || r.key !== row.key) return;
      if (r.lane !== row.lane) {
        r.lane = row.lane;
        const l = LANE[row.lane] || LANE.admin;
        r.laneSlot.replaceChildren(h('span.q__lane', { title: l.tip, attrs: { 'aria-label': l.tip } }, icon(l.icon, { size: 12, strokeWidth: 2 }), l.label));
      }
      let stageText;
      let pctText = '';
      let barValue = null;
      let bytesText = '';
      if (DONE.has(row.status)) {
        stageText = { installed: 'Installiert', already: 'War schon da', failed: 'Fehlgeschlagen', skipped: 'Übersprungen', cancelled: 'Abgebrochen' }[row.status];
        barValue = 1;
        bytesText = row.status === 'failed' ? row.message : row.status === 'installed' ? `Fertig in ${formatDuration(row.durationMs)}` : '';
        r.bar.setTone(row.status === 'failed' ? 'err' : row.status === 'installed' ? 'ok' : null);
        r.bar.setActive(false);
        r.el.dataset.s = row.status;
      } else if (row.status === 'requeued') {
        stageText = 'Gleich nochmal – ohne Adminrechte';
        r.el.dataset.s = 'requeued';
      } else {
        stageText = `${row.attempts > 1 ? '2. Versuch · ' : ''}${STAGE_TEXT[row.stage] || STAGE_TEXT.resolving}`;
        const frac = row.pct != null ? row.pct / 100 : row.bytes?.total ? row.bytes.done / row.bytes.total : null;
        if (row.stage === 'downloading' && frac != null) {
          barValue = clamp01(frac);
          pctText = `${formatNumber(Math.round(barValue * 100))} %`;
        } else if (row.stage === 'installing' && row.pct != null) {
          barValue = clamp01(row.pct / 100);
          pctText = `${formatNumber(Math.round(row.pct))} %`;
        }
        if (row.bytes?.total) bytesText = `${formatBytes(row.bytes.done)} von ${formatBytes(row.bytes.total)}`;
        else if (row.stage === 'installing') bytesText = 'Der Installer läuft still im Hintergrund';
        else if (row.stage === 'verifying') bytesText = 'Prüfsumme wird kontrolliert';
        else bytesText = 'Paket wird in winget gesucht';
        if (row.stage === 'installing' && row.bytes?.total) bytesText = `${formatBytes(row.bytes.total)} geladen · Installer läuft`;
        r.el.dataset.s = 'active';
      }
      r.stageEl.textContent = stageText;
      r.pctEl.textContent = pctText;
      r.bar.setValue(barValue);
      r.bytesEl.textContent = bytesText;
      const nx = nextName(row.key);
      r.nextEl.textContent = nx ? `Als Nächstes: ${nx}` : DONE.has(row.status) ? '' : 'Das ist die letzte App';
    }

    function showSpotFor(row) {
      if (!spotRef || spotRef.kind !== 'item' || spotRef.key !== row.key) swapSpot(buildSpotItem(row));
      paintSpotItem(row);
    }

    function showSpotPhase() {
      const elev = s.elevation?.status === 'requested';
      const kind = elev ? 'elev' : s.phase === 'finishing' ? 'finish' : s.phase === 'installing' ? 'next' : 'prep';
      const spec = {
        elev: { iconName: 'shield', eyebrow: 'Einmalig', name: 'Warte auf Windows', text: 'Bestätige die Abfrage mit „Ja“' },
        prep: { iconName: 'rocket', eyebrow: 'Startklar', name: 'Wird vorbereitet', text: s.phaseMessage },
        next: { iconName: 'rocket', eyebrow: 'Gleich geht’s los', name: 'Nächste App startet', text: 'winget übernimmt …' },
        finish: { iconName: 'sparkles', eyebrow: 'Fast fertig', name: 'Letzte Prüfungen', text: 'Neustart-Bedarf wird geprüft …' },
      }[kind];
      if (spotRef && spotRef.kind === 'info' && spotRef.phase === kind) {
        spotRef.textEl.textContent = spec.text;
        return;
      }
      const ref = buildSpotInfo(spec);
      ref.phase = kind;
      swapSpot(ref);
    }

    function showSpotDone() {
      const t = s.summary || tally(s);
      const ok = (t.installed || 0) + (t.already || 0);
      const allBad = ok === 0 && (t.failed || 0) > 0;
      const parts = [t.installed && `${t.installed} installiert`, t.already && `${t.already} waren schon da`, t.failed && `${t.failed} fehlgeschlagen`, t.cancelled && `${t.cancelled} abgebrochen`, t.skipped && `${t.skipped} übersprungen`].filter(Boolean);
      const ref = buildSpotInfo({
        iconName: allBad ? 'x-circle' : t.failed ? 'alert' : 'check-circle',
        eyebrow: `Nach ${formatDuration(s.durationMs)}`,
        name: allBad ? 'Leider nichts installiert' : t.cancelled ? 'Abgebrochen' : t.failed ? 'Fast alles erledigt' : 'Alles erledigt',
        text: joinList(parts) || 'Nichts zu tun',
        tone: allBad ? 'err' : t.failed ? 'warn' : 'ok',
        bar: false,
      });
      ref.phase = 'done';
      swapSpot(ref);
    }

    // ---- header updates -------------------------------------------------------------------------------
    let shownPhase = s.phaseMessage;
    function setPhase(text) {
      if (text === shownPhase) return;
      shownPhase = text;
      const sc = scrambleText(phaseEl, text, { duration: 0.5 });
      cleanups.push(() => sc.cancel());
    }

    function updateCounts() {
      const t = tally(s);
      const done = countDone(s);
      const open = s.order.length - done;
      const bits = [`${done} fertig`];
      if (t.failed) bits.push(`${t.failed} Fehler`);
      if (open) bits.push(`${open} offen`);
      qCount.textContent = bits.join(' · ');
      reactor.setCount(done, s.order.length);
    }

    // ---- ticking: overall %, ETA ---------------------------------------------------------------------------
    let lastEtaAt = 0;
    function tick(force = false) {
      if (!alive) return;
      const now = Date.now();
      const v = computeOverall(s, now);
      if (v > s.overall + 0.0005 || force) {
        s.overall = Math.max(s.overall, v);
        reactor.setValue(s.overall, { animate: !force });
        fx.setProgress(s.overall);
      }
      const cur = s.currentKey ? s.rows.get(s.currentKey) : null;
      if (cur) {
        const ref = rowEls.get(cur.key);
        if (ref) ref.li.style.setProperty('--rp', itemFraction(cur, now).toFixed(3));
      }
      if (s.finished || s.error) return;
      if (force || now - lastEtaAt > 950) {
        lastEtaAt = now;
        const eta = computeEta(s, now);
        if (eta == null) {
          reactor.setEta(s.phase === 'installing' ? 'Restzeit wird berechnet …' : '');
        } else {
          s.etaShown = s.etaShown == null ? eta : s.etaShown + (eta - s.etaShown) * 0.35;
          reactor.setEta(s.etaShown < 9000 ? 'gleich fertig' : formatEta(s.etaShown));
        }
      }
    }
    const tickTimer = setInterval(() => tick(false), 400);
    cleanups.push(() => clearInterval(tickTimer));

    // ---- sounds (subtle per item) --------------------------------------------------------------------
    let lastChime = 0;
    function itemSound(status) {
      const now = performance.now();
      if (status === 'failed') {
        sound.error();
        return;
      }
      if (status === 'installed' && now - lastChime > 2600) {
        lastChime = now;
        sound.success();
      } else if (status === 'installed' || status === 'already') {
        sound.play('hover');
      }
    }

    // ---- cancel ---------------------------------------------------------------------------------------
    async function onCancel() {
      if (s.finished || s.cancelRequested || s.error) return;
      const yes = await modal.confirm({
        title: 'Installation abbrechen?',
        message: 'Die laufende App wird gestoppt, alle weiteren werden übersprungen. Was schon installiert ist, bleibt auf deinem PC.',
        confirmLabel: 'Ja, abbrechen',
        cancelLabel: 'Weiter installieren',
        danger: true,
      });
      if (!yes || !alive || s.finished || s.cancelRequested) return;
      s.cancelRequested = true;
      cancelBtn.setLoading(true);
      cancelBtn.setLabel('Wird abgebrochen …');
      sideHint.textContent = 'Die aktuelle App wird noch gestoppt …';
      logDrawer.add(pushLog(s, 'warn', 'Abbruch angefordert'));
      try {
        await api.install.cancel();
      } catch (err) {
        s.cancelRequested = false;
        if (!alive) return;
        cancelBtn.setLoading(false);
        cancelBtn.setLabel('Abbrechen');
        sideHint.textContent = 'Stoppt nach der aktuellen App. Bereits Installiertes bleibt.';
        toast.error('Abbrechen hat nicht geklappt', err.message);
      }
    }

    // ---- finish -----------------------------------------------------------------------------------------
    let leaving = false;
    function goDone() {
      if (leaving || !alive) return;
      leaving = true;
      router.go('done', {}, { transition: 'zoom', replace: true });
    }

    function renderFinished(celebrate) {
      const t = s.summary || tally(s);
      const ok = (t.installed || 0) + (t.already || 0);
      const allBad = ok === 0 && (t.failed || 0) > 0;
      const tone = allBad ? 'err' : t.failed ? 'warn' : 'ok';
      liveDot.classList.add(allBad ? 'is-err' : 'is-done');
      setPhase(t.cancelled ? 'Abgebrochen' : 'Fertig');
      const headline = allBad ? 'Hat nicht geklappt.' : t.cancelled ? 'Abgebrochen.' : t.failed ? 'Fast geschafft.' : 'Geschafft.';
      if (celebrate) relabel(title, headline);
      else title.textContent = headline;
      lead.textContent = allBad ? 'Keine App konnte installiert werden – in der Übersicht siehst du warum.' : 'Gleich siehst du die Übersicht mit allen Ergebnissen.';
      banner.hide();
      reactor.setEta('');
      reactor.finale({ tone, label: allBad ? 'Fehlgeschlagen' : t.cancelled ? 'Abgebrochen' : 'Fertig', sub: formatDuration(s.durationMs) });
      if (!celebrate) reactor.setValue(1, { animate: false });
      s.order.forEach((k, i) => {
        paintRow(s.rows.get(k));
        reactor.setSegment(i, s.rows.get(k).status);
      });
      updateCounts();
      showSpotDone();
      fx.setProgress(1);
      // Swap "Abbrechen" for the way forward.
      cancelBtn.remove();
      if (!nextBtn) {
        nextBtn = Button({ label: 'Zur Übersicht', iconRight: 'arrow-right', variant: 'primary', onClick: goDone });
        cleanups.push(() => nextBtn.destroy());
        sideSlot.prepend(nextBtn);
      }
      sideHint.textContent = celebrate ? 'Geht gleich von selbst weiter.' : 'Alle Ergebnisse, Fehler und Neustart-Hinweise.';
      sr.textContent = `Installation beendet. ${t.installed || 0} installiert, ${t.failed || 0} fehlgeschlagen.`;
      if (!celebrate) return;
      fx.setState(allBad ? 'error' : 'success');
      if (allBad) sound.error();
      else {
        sound.boom();
        if (motionOK()) fx.burst({ count: 220 });
      }
      if (motionOK() && richMotion()) gsap.fromTo(nextBtn, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.8, ease: 'elastic.out(1, 0.5)', clearProps: 'transform,opacity' });
      // Stay if the user is reading the log; otherwise move on after the moment has landed.
      if (logDrawer.isOpen) sideHint.textContent = 'Weiter, sobald du soweit bist.';
      else later(goDone, 1700);
    }

    function renderError(message) {
      liveDot.classList.add('is-err');
      setPhase('Fehler');
      title.textContent = 'Start hat nicht geklappt.';
      lead.textContent = 'PHOENIX konnte die Installation nicht beginnen. Es wurde nichts verändert.';
      banner.hide();
      reactor.setMode('error');
      reactor.setEta('');
      reactor.setCount(0, 0);
      cancelBtn.remove();
      sideHint.remove();
      const retryBtn = Button({ label: 'Erneut versuchen', icon: 'refresh', variant: 'primary', onClick: () => router.go('install', {}, { transition: 'fade', replace: true }) });
      const backBtn = Button({
        label: 'Zur Auswahl',
        icon: 'arrow-left',
        variant: 'secondary',
        onClick: () => router.go('select', { mode: store.get('profile') ? 'restore' : 'catalog' }, { transition: 'slide', direction: 'back' }),
      });
      cleanups.push(() => retryBtn.destroy(), () => backBtn.destroy());
      const card = h(
        'section.card.inst__error',
        { attrs: { role: 'alert' } },
        h('div.icon-tile.icon-tile--lg.icon-tile--danger', icon('x-circle')),
        h('div.inst__error-body', h('h2.inst__error-title', 'Die Installation konnte nicht starten'), h('p.inst__error-msg.selectable', message)),
        h(
          'div.inst__error-actions',
          h('div.inst__error-action', retryBtn, h('span.inst__error-hint', 'Startet denselben Auftrag noch einmal.')),
          h('div.inst__error-action', backBtn, h('span.inst__error-hint', 'Apps ändern oder später weitermachen.')),
        ),
      );
      const grid = inner.querySelector('.inst__grid');
      grid.replaceWith(card);
      if (motionOK()) gsap.fromTo(card, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: 'expo.out', clearProps: 'transform,opacity' });
      fx.setState('error');
      sound.error();
      sr.textContent = `Fehler: ${message}`;
    }

    // ---- event → view ---------------------------------------------------------------------------------
    function onEvent(e, info = {}) {
      if (!alive) return;
      for (const entry of info.logs || []) logDrawer.add(entry);
      switch (e.type) {
        case 'job-start':
          syncOrder(false);
          updateCounts();
          break;
        case 'phase':
          setPhase(s.phaseMessage);
          if (!s.currentKey) showSpotPhase();
          break;
        case 'elevation':
          banner.set(e.status);
          if (e.status === 'requested') {
            fx.pulse(0.7);
            sound.play('rise');
          } else if (e.status === 'granted') {
            sound.play('click');
          }
          if (!s.currentKey) showSpotPhase();
          break;
        case 'item-start': {
          if (info.prevKey) paintRow(s.rows.get(info.prevKey));
          if (info.moved || !rowEls.has(e.key)) syncOrder(true);
          const row = s.rows.get(e.key);
          paintRow(row);
          reactor.setMode('run');
          reactor.setSegment(s.order.indexOf(row.key), 'active');
          if (info.prevKey) reactor.setSegment(s.order.indexOf(info.prevKey), 'requeued');
          showSpotFor(row);
          updateCounts();
          later(() => follow(), 60);
          break;
        }
        case 'item-progress': {
          const row = s.rows.get(e.key);
          if (!row) break;
          paintRow(row);
          if (info.activated) {
            reactor.setMode('run');
            reactor.setSegment(s.order.indexOf(row.key), 'active');
            showSpotFor(row);
          } else paintSpotItem(row);
          break;
        }
        case 'item-done': {
          const row = s.rows.get(e.key);
          if (!row) break;
          paintRow(row);
          paintSpotItem(row);
          reactor.setSegment(s.order.indexOf(row.key), row.status);
          updateCounts();
          if (!info.wasDone && row.status !== 'cancelled') {
            flashRow(row);
            reactor.shock(row.status === 'failed' ? 'err' : row.status === 'installed' ? 'ok' : 'muted');
            fx.pulse(row.status === 'failed' ? 0.35 : 0.5);
            itemSound(row.status);
            sr.textContent = `${row.name}: ${STATUS[row.status].label}. ${countDone(s)} von ${s.order.length} fertig.`;
          }
          tick();
          break;
        }
        case 'log':
          if (info.row) {
            paintRow(info.row);
            paintSpotItem(info.row);
            reactor.setSegment(s.order.indexOf(info.row.key), info.row.status);
          }
          break;
        case 'job-done':
          renderFinished(true);
          break;
        case 'start-error':
          renderError(e.message);
          break;
        default:
          break;
      }
    }
    s.listeners.add(onEvent);
    cleanups.push(() => s.listeners.delete(onEvent));

    // ---- keyboard: L toggles the log -----------------------------------------------------------------------
    cleanups.push(
      on(window, 'keydown', (e) => {
        if (e.key !== 'l' && e.key !== 'L') return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if (container.inert || document.documentElement.classList.contains('modal-open')) return;
        if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]')) return;
        e.preventDefault();
        logDrawer.toggle();
        if (s.finished && logDrawer.isOpen && !leaving) sideHint.textContent = 'Weiter, sobald du soweit bist.';
      }),
    );

    // ---- initial paint ---------------------------------------------------------------------------------------
    syncOrder(false);
    logDrawer.setLines(s.logs);
    setPhase(s.phaseMessage);
    if (s.elevation && !s.finished && !s.error && (s.elevation.status !== 'granted' || !s.currentKey)) banner.set(s.elevation.status);
    if (s.error) renderError(s.error);
    else if (s.finished) renderFinished(false);
    else {
      const cur = s.currentKey ? s.rows.get(s.currentKey) : null;
      if (cur) {
        reactor.setMode('run');
        showSpotFor(cur);
      } else showSpotPhase();
      updateCounts();
      tick(true);
      later(() => follow(true), 400);
    }

    if (isNew) startSession(s, job, ctx);

    return cleanup;
  },
};
