'use strict';
// Spawns winget for install / export / source update. Exit code = truth (see errors.js).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createProgressParser } = require('./progress');
const { watchDownload } = require('./download-watch');
const { compareVersions } = require('./locate');
const catalog = require('../catalog');
const { classify } = require('./errors');
const { killTree } = require('../util/ps');
const log = require('../log');

const ITEM_TIMEOUT_MS = 40 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs winget once. Resolves { code, timedOut, aborted }.
 * @param {string} wingetPath
 * @param {string[]} args
 * @param {{onData?: (chunk: Buffer) => void, signal?: AbortSignal, timeoutMs?: number}} opts
 */
function runWinget(wingetPath, args, { onData, signal, timeoutMs = ITEM_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve({ code: null, timedOut: false, aborted: true });
    let child;
    try {
      // stdin must be closed: an unexpected prompt would otherwise wait forever
      child = spawn(wingetPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log.error('winget konnte nicht gestartet werden', err);
      return resolve({ code: -1, timedOut: false, aborted: false, spawnError: err.message });
    }
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (onData) {
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
    } else {
      child.stdout.resume();
      child.stderr.resume();
    }
    child.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code: -1, timedOut, aborted, spawnError: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, timedOut, aborted });
    });
  });
}

function installArgs(item, wingetVersion) {
  const args = [
    'install',
    '--id', item.id,
    '--exact',
    '--source', item.source,
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ];
  // --no-upgrade: skip packages that are already installed (exit 0x8A150061) instead of upgrading them
  if (!wingetVersion || compareVersions(wingetVersion, '1.9.0') >= 0) args.push('--no-upgrade');
  // Per-package extras come only from the bundled catalog (never from the renderer), e.g.
  // DirectX: --installer-type exe (legacy runtime instead of the UWP appx), Battle.net: --location.
  const hit = catalog.lookup(item.id, item.source);
  if (hit && Array.isArray(hit.args) && (!wingetVersion || compareVersions(wingetVersion, '1.7.0') >= 0)) {
    args.push(...hit.args.map(String));
  }
  return args;
}

// Waits before the next attempt, per retry reason (index = attempt number - 1).
const BACKOFF = {
  network: [5000, 15000],
  source: [0],
  'in-use': [10000],
  busy: [30000, 60000, 120000], // MSI 1618 – Windows Update often installs right after a reset
};

async function updateSources(wingetPath) {
  const res = await runWinget(wingetPath, ['source', 'update', '--disable-interactivity'], { timeoutMs: 5 * 60 * 1000 });
  return res.code === 0;
}

/**
 * Installs one package with live progress and smart retries.
 * @returns {Promise<{status, rebootRequired, message, code?, codeHex?, retry?}>}
 */
async function installPackage(item, { wingetPath, wingetVersion, onProgress = () => {}, onLog = () => {}, signal } = {}) {
  let last = null;
  for (let attempt = 1; ; attempt++) {
    let stopWatch = null;
    let sawBarBytes = 0;
    const parser = createProgressParser(
      (p) => {
        if (p.bytes) sawBarBytes = Date.now();
        if (p.stage !== 'downloading' && stopWatch) {
          stopWatch();
          stopWatch = null;
        }
        onProgress(p);
      },
      onLog,
      {
        onUrl: (url) => {
          if (stopWatch || item.source !== 'winget') return;
          stopWatch = watchDownload(url, ({ pct, bytes }) => {
            // winget <= 1.28 draws its own bar – prefer that when present
            if (Date.now() - sawBarBytes > 2000) parser.report('downloading', pct, bytes);
          });
        },
      },
    );
    onProgress({ stage: 'resolving', pct: null });
    const res = await runWinget(wingetPath, installArgs(item, wingetVersion), { onData: (c) => parser.feed(c), signal });
    parser.flush();
    if (stopWatch) stopWatch();
    if (res.aborted || (signal && signal.aborted)) return { status: 'cancelled', rebootRequired: false, message: 'Abgebrochen.' };
    if (res.timedOut) return { status: 'failed', rebootRequired: false, message: 'Zeitüberschreitung – die Installation hat zu lange gedauert.' };
    if (res.spawnError) return { status: 'failed', rebootRequired: false, message: `winget konnte nicht gestartet werden (${res.spawnError}).` };

    last = classify(res.code);
    log.info(`winget install ${item.id}: ${last.codeHex} ${last.name} -> ${last.status} (Versuch ${attempt})`);
    const waits = last.retry ? BACKOFF[last.retry] : null;
    if (!waits || attempt > waits.length) break;

    if (last.retry === 'source') {
      onLog('Paketquellen werden aktualisiert und es wird erneut versucht …');
      await updateSources(wingetPath);
    } else if (last.retry === 'network') {
      onLog(`Netzwerkproblem – neuer Versuch in ${waits[attempt - 1] / 1000} Sekunden …`);
    } else if (last.retry === 'in-use') {
      onLog('Die App ist gerade geöffnet – neuer Versuch gleich …');
    } else if (last.retry === 'busy') {
      onLog(`Windows installiert gerade etwas anderes (z. B. Updates) – neuer Versuch in ${waits[attempt - 1] / 1000} Sekunden …`);
    }
    onProgress({ stage: 'resolving', pct: null });
    await sleep(waits[attempt - 1]);
    if (signal && signal.aborted) return { status: 'cancelled', rebootRequired: false, message: 'Abgebrochen.' };
  }
  return { status: last.status, rebootRequired: last.rebootRequired, message: last.message, code: last.code, codeHex: last.codeHex, retry: last.retry };
}

/** Folder for winget export: winget <= 1.29 mishandles non-ASCII paths (e.g. C:\\Users\\Jürgen). */
function exportDir() {
  const tmp = path.join(os.tmpdir(), 'phoenix');
  if (/^[\x20-\x7E]+$/.test(tmp)) return tmp;
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Phoenix');
}

/** `winget export` into a temp file. Resolves { ok, json, code }. */
async function exportPackages({ wingetPath, timeoutMs = 5 * 60 * 1000 } = {}) {
  const dir = exportDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `export-${crypto.randomUUID()}.json`);
  const res = await runWinget(wingetPath, ['export', '--output', file, '--accept-source-agreements', '--disable-interactivity'], { timeoutMs });
  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    json = null;
  }
  fs.rm(file, { force: true }, () => {});
  log.info(`winget export: code ${res.code}, ${json && json.Sources ? json.Sources.reduce((n, s) => n + ((s.Packages || []).length), 0) : 0} Pakete`);
  return { ok: !!(json && Array.isArray(json.Sources)), json, code: res.code };
}

module.exports = { installPackage, exportPackages, updateSources, runWinget, installArgs };
