'use strict';
// Makes sure winget works – a freshly reset Windows often has none registered yet, or an old one.
// Fast path in Node; the full repair chain lives in Ensure-Winget.ps1 (register -> Microsoft.WinGet.Client
// -> GitHub release msixbundle + dependencies -> Microsoft Store), each followed by a re-detect.
const fs = require('fs');
const path = require('path');
const locate = require('./locate');
const { runPs } = require('../util/ps');
const log = require('../log');

const STEP_TEXT = {
  detect: 'winget wird gesucht …',
  register: 'App-Installer wird registriert …',
  module: 'winget wird über Microsoft repariert …',
  manual: 'winget wird heruntergeladen (ca. 300 MB) …',
  store: 'Microsoft Store wird um ein Update gebeten …',
  source: 'Paketquellen werden geprüft …',
};

const FAIL_TEXT = {
  NO_WINGET: 'winget konnte nicht installiert werden.',
  TOO_OLD: 'winget ist zu alt und konnte nicht aktualisiert werden.',
  NO_LICENSE: 'Windows hat noch keine Lizenz für den App-Installer – bitte einige Minuten warten oder neu starten.',
  OS_UNSUPPORTED: 'Diese Windows-Version wird von winget nicht unterstützt (mind. Windows 10 1809).',
  SYSTEM_ACCOUNT: 'winget läuft nicht unter dem SYSTEM-Konto.',
};

let running = null;

function scriptText() {
  return fs.readFileSync(path.join(__dirname, 'Ensure-Winget.ps1'), 'utf8').replace(/^﻿/, '');
}

async function repair(onProgress) {
  let failure = null;
  const res = await runPs(scriptText(), {
    raw: true,
    timeoutMs: 30 * 60 * 1000,
    onLine: (line) => {
      const m = /^PHX:([A-Z]+):(.*)$/.exec(line.trim());
      if (!m) return;
      const [, kind, text] = m;
      log.info(`Ensure-Winget ${kind}: ${text}`);
      if (kind === 'STEP') onProgress({ step: text, message: STEP_TEXT[text] || text });
      else if (kind === 'INFO' && text.startsWith('progress=')) {
        const pct = Number(text.split(' ').pop());
        if (Number.isFinite(pct)) onProgress({ step: 'manual', message: `winget wird heruntergeladen … ${pct} %`, pct });
      } else if (kind === 'FAIL') failure = text;
    },
  });
  return { code: res.code, failure, timedOut: res.timedOut };
}

/** Resolves { ok, version, path?, error? }. Never throws. Concurrent callers share one run. */
function ensureWinget({ onProgress = () => {} } = {}) {
  if (running) return running;
  running = (async () => {
    onProgress({ step: 'detect', message: STEP_TEXT.detect });
    let status = await locate.getStatus({ refresh: true });
    if (status.ok) return { ok: true, version: status.version, path: status.path };
    if (process.platform !== 'win32') return { ok: false, version: null, error: 'Nur unter Windows verfügbar.' };

    let outcome;
    try {
      outcome = await repair(onProgress);
    } catch (err) {
      log.error('Ensure-Winget konnte nicht ausgeführt werden', err);
      outcome = { code: -1, failure: `UNEXPECTED:${err.message}` };
    }
    status = await locate.getStatus({ refresh: true });
    if (status.ok) return { ok: true, version: status.version, path: status.path };

    const code = outcome.failure ? outcome.failure.split(':')[0] : '';
    const error = outcome.timedOut
      ? 'Die winget-Reparatur hat zu lange gedauert.'
      : FAIL_TEXT[code] || 'winget konnte nicht eingerichtet werden. Installiere „App-Installer“ aus dem Microsoft Store und starte Phoenix neu.';
    return { ok: false, version: status.version, error };
  })().finally(() => {
    running = null;
  });
  return running;
}

module.exports = { ensureWinget };
