'use strict';
// Spawns winget for install / export / source update. Exit code = truth (see errors.js).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createProgressParser } = require('./progress');
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
      child = spawn(wingetPath, args, { windowsHide: true });
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

function installArgs(item) {
  return [
    'install',
    '--id', item.id,
    '--exact',
    '--source', item.source,
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ];
}

async function updateSources(wingetPath) {
  const res = await runWinget(wingetPath, ['source', 'update', '--disable-interactivity'], { timeoutMs: 5 * 60 * 1000 });
  return res.code === 0;
}

/**
 * Installs one package with live progress and one smart retry.
 * @returns {Promise<{status, rebootRequired, message, code?, codeHex?, retry?}>}
 */
async function installPackage(item, { wingetPath, onProgress = () => {}, onLog = () => {}, signal } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const parser = createProgressParser(onProgress, onLog);
    onProgress({ stage: 'resolving', pct: null });
    const res = await runWinget(wingetPath, installArgs(item), { onData: (c) => parser.feed(c), signal });
    parser.flush();
    if (res.aborted || (signal && signal.aborted)) return { status: 'cancelled', rebootRequired: false, message: 'Abgebrochen.' };
    if (res.timedOut) return { status: 'failed', rebootRequired: false, message: 'Zeitüberschreitung – die Installation hat zu lange gedauert.' };
    if (res.spawnError) return { status: 'failed', rebootRequired: false, message: `winget konnte nicht gestartet werden (${res.spawnError}).` };

    last = classify(res.code);
    log.info(`winget install ${item.id}: ${last.codeHex} ${last.name} -> ${last.status} (Versuch ${attempt})`);
    if (attempt === 2 || !last.retry || last.retry === 'user-lane') break;

    if (last.retry === 'source') {
      onLog('Paketquellen werden aktualisiert und es wird erneut versucht …');
      await updateSources(wingetPath);
    } else if (last.retry === 'network') {
      onLog('Netzwerkproblem – neuer Versuch in 5 Sekunden …');
      await sleep(5000);
    } else if (last.retry === 'in-use') {
      onLog('Die App ist geöffnet – neuer Versuch in 10 Sekunden …');
      await sleep(10000);
    } else if (last.retry === 'busy') {
      onLog('Eine andere Installation läuft – neuer Versuch in 30 Sekunden …');
      await sleep(30000);
    }
    if (signal && signal.aborted) return { status: 'cancelled', rebootRequired: false, message: 'Abgebrochen.' };
  }
  return { status: last.status, rebootRequired: last.rebootRequired, message: last.message, code: last.code, codeHex: last.codeHex, retry: last.retry };
}

/** `winget export` into a temp file. Resolves { ok, json, code }. */
async function exportPackages({ wingetPath, timeoutMs = 5 * 60 * 1000 } = {}) {
  const dir = path.join(os.tmpdir(), 'phoenix');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `export-${crypto.randomUUID()}.json`);
  const res = await runWinget(wingetPath, ['export', '--output', file, '--accept-source-agreements', '--disable-interactivity'], { timeoutMs });
  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    json = null;
  }
  fs.rm(file, { force: true }, () => {});
  log.info(`winget export: code ${res.code}, ${json && json.Sources ? json.Sources.reduce((n, s) => n + ((s.Packages || []).length), 0) : 0} Pakete`);
  return { ok: !!(json && Array.isArray(json.Sources)), json, code: res.code };
}

module.exports = { installPackage, exportPackages, updateSources, runWinget, installArgs };
