'use strict';
// Install orchestrator in the (non-elevated) UI process: winget check, lanes, elevated worker,
// sequential execution, summary. Contract: docs/ARCHITECTURE.md §2 and §6.
const crypto = require('crypto');
const log = require('../log');
const { sanitizeItems } = require('./protocol');
const { isElevated, launchWorker } = require('./elevate');
const { runItems } = require('./runItems');
const bootstrap = require('../winget/bootstrap');
const { regKeysExist } = require('../util/reg');

const REBOOT_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired',
];

let current = null;

/**
 * User lane (this non-elevated process): installers that refuse admin rights, per-user installers
 * (scope user/both) and Store apps – they belong to the logged-in user. Everything else goes to the
 * elevated worker.
 */
function laneOf(item) {
  // 'both': winget prefers the per-user installer by default, which needs no admin rights
  return item.elevation === 'prohibited' || item.scope === 'user' || item.scope === 'both' || item.source === 'msstore' ? 'user' : 'admin';
}

function startJob(rawItems, { emit }) {
  if (current && !current.done) throw new Error('Es läuft bereits eine Installation.');
  const items = sanitizeItems(rawItems);
  if (!items.length) throw new Error('Keine gültigen Apps ausgewählt.');
  const job = { id: crypto.randomUUID(), done: false, controller: new AbortController(), worker: null };
  current = job;
  run(job, items, emit)
    .catch((err) => {
      log.error('Installationsauftrag abgestürzt', err);
      emit({ type: 'log', line: `Interner Fehler: ${err.message}` });
    })
    .finally(() => {
      job.done = true;
    });
  return { jobId: job.id };
}

/** True while an install job runs (used to confirm closing the window). */
function isRunning() {
  return !!(current && !current.done);
}

function cancelJob() {
  if (!current || current.done) return true;
  current.controller.abort();
  if (current.worker) current.worker.cancel();
  return true;
}

async function run(job, items, emitEvent) {
  // winget's own output (installer exit codes, hash/agreement texts) must reach the exported log
  const emit = (event) => {
    if (event && event.type === 'log' && event.line) log.info(event.key ? `[${event.key}] ${event.line}` : event.line);
    emitEvent(event);
  };
  const started = Date.now();
  const summary = { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0, rebootRequired: false };
  const finished = new Set();
  const track = (event) => {
    if (event.type === 'item-done' && !finished.has(event.key)) {
      finished.add(event.key);
      if (summary[event.status] !== undefined) summary[event.status]++;
      if (event.rebootRequired) summary.rebootRequired = true;
    }
    emit(event);
  };

  // 1) winget must work (non-elevated attempt; the worker retries with admin rights if needed).
  emit({ type: 'phase', phase: 'winget-check', message: 'winget wird geprüft …' });
  const wg = await bootstrap.ensureWinget({ onProgress: (p) => emitEvent({ type: 'log', line: p.message }) }); // bootstrap logs itself
  if (!wg.ok) emit({ type: 'log', line: `winget nicht bereit: ${wg.error || 'unbekannt'}` });

  // 2) lanes
  let admin = items.filter((i) => laneOf(i) === 'admin');
  let user = items.filter((i) => laneOf(i) === 'user');
  let localAdmin = [];

  // 3) elevation (one UAC prompt for the whole admin lane)
  if (admin.length && isElevated()) {
    localAdmin = admin; // Phoenix itself already runs as admin
    admin = [];
  } else if (admin.length && !job.controller.signal.aborted) {
    emit({ type: 'phase', phase: 'elevating', message: 'Administratorrechte werden angefordert …' });
    emit({ type: 'elevation', status: 'requested', message: 'Windows fragt gleich nach Administratorrechten – bitte mit „Ja“ bestätigen.' });
    try {
      job.worker = await launchWorker();
      emit({ type: 'elevation', status: 'granted', message: 'Administratorrechte erteilt.' });
    } catch (err) {
      log.warn('Elevation fehlgeschlagen', err);
      emit({
        type: 'elevation',
        status: err.code === 'DECLINED' ? 'declined' : 'failed',
        message:
          err.code === 'DECLINED'
            ? 'Ohne Administratorrechte fragt Windows bei manchen Apps einzeln nach – bitte dann jeweils bestätigen.'
            : `Admin-Modus nicht verfügbar (${err.message}). Phoenix installiert ohne – Windows fragt ggf. einzeln nach.`,
      });
      user = [...admin, ...user];
      admin = [];
    }
  }

  const local = [...localAdmin, ...user];
  const order = [
    ...admin.map((i) => ({ ...i, lane: 'admin' })),
    ...localAdmin.map((i) => ({ ...i, lane: 'admin' })),
    ...user.map((i) => ({ ...i, lane: 'user' })),
  ];
  log.info(`Installation (${job.worker ? 'mit' : 'ohne'} Admin-Prozess): ${order.map((i) => `${i.key} [${i.lane}]`).join(', ')}`);
  emit({ type: 'job-start', jobId: job.id, items: order.map((i) => ({ key: i.key, name: i.name, lane: i.lane })) });
  emit({ type: 'phase', phase: 'installing', message: 'Installation läuft …' });

  // 4) admin lane in the elevated worker
  if (job.worker && admin.length) {
    const retryLocal = [];
    const pending = job.worker.runJob(admin, (event) => {
      // Installers that refuse admin rights are retried in this (non-elevated) process.
      if (event.type === 'item-done' && event.retryLane === 'user') {
        const item = admin.find((i) => i.key === event.key);
        if (item) {
          retryLocal.push(item);
          emit({ type: 'log', key: event.key, line: 'Wird ohne Administratorrechte erneut installiert …' });
          return;
        }
      }
      track({ ...event, ...(event.type === 'item-start' ? { total: order.length } : {}) });
    });
    if (job.controller.signal.aborted) job.worker.cancel(); // cancelled while the UAC prompt was open
    const res = await pending;
    job.worker.close();
    job.worker = null;
    if (res.disconnected) {
      for (const item of admin) {
        if (finished.has(item.key)) continue;
        if (retryLocal.includes(item)) continue;
        track({ type: 'item-done', key: item.key, status: 'failed', rebootRequired: false, message: 'Die Verbindung zum Admin-Prozess wurde unterbrochen.', durationMs: 0 });
      }
    }
    local.unshift(...retryLocal);
  }

  // 5) user lane (and the admin lane when Phoenix itself already runs as admin) in this process
  if (local.length) {
    await runItems(local, {
      emit: track,
      log: (line) => emit({ type: 'log', line }),
      signal: job.controller.signal,
      indexOffset: order.length - local.length,
      total: order.length,
    });
  }

  emit({ type: 'phase', phase: 'finishing', message: 'Abschluss …' });
  // Installers that exit with "reboot required" (e.g. MSI 3010) are reported by winget as success.
  if ((await regKeysExist(REBOOT_KEYS)).some(Boolean)) summary.rebootRequired = true;
  emit({ type: 'job-done', summary, durationMs: Date.now() - started });
}

module.exports = { startJob, cancelJob, isRunning, laneOf };
