'use strict';
// Monitor-Tuner: Testbilder und geführte Einrichtung (Monitor, Windows, Treiber, Fortnite).
// Der Hauptprozess macht nur drei Dinge: die Windows-Farbkalibrierung (dccw.exe) starten,
// die Microsoft-Store-Seite der HDR-Kalibrierung öffnen und die Grafikkarte erkennen (nur lesen).
// Es wird nichts an Monitor, Treiber oder Fortnite verändert.

const { spawn } = require('node:child_process');
const { HelixError } = require('../../sys/exec');
const logic = require('../../tools/monitor-logic');

const ID = 'monitor';
const STATE = 'tool-monitor';
const TESTS_MAX = 50;
// Windows HDR Calibration (kostenlose Microsoft-App)
const HDR_STORE_URI = 'ms-windows-store://pdp/?ProductId=9N7F2SM5D1LR';

const PS_GPU = String.raw`
$l = @(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {
  [pscustomobject]@{ Name = [string]$_.Name; AdapterCompatibility = [string]$_.AdapterCompatibility; PNPDeviceID = [string]$_.PNPDeviceID }
})
ConvertTo-Json -InputObject $l -Compress -Depth 3
`;

// Für Tests austauschbar
const deps = { spawn };

// Schreibzugriffe auf den Zustand nacheinander (sonst könnte ein Sturm-Test beim gleichzeitigen
// Speichern des Fortschritts verloren gehen).
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function isWin(ctx) {
  return ctx?.exec ? !!ctx.exec.IS_WIN : process.platform === 'win32';
}

/** Startet ein Windows-Programm sichtbar und unabhängig von HELIX. */
function launchDetached(file, args = []) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = deps.spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    } catch (e) {
      reject(e);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid ?? null });
    });
  });
}

async function readState(ctx) {
  const s = await ctx.core.readState(STATE, {});
  return s && typeof s === 'object' ? s : {};
}

module.exports = {
  id: ID,
  handlers: {
    async state(_a, ctx) {
      const s = await readState(ctx);
      return { wizard: s.wizard || null, stormTests: Array.isArray(s.stormTests) ? s.stormTests : [] };
    },

    /** Fortschritt der Einrichtung merken. done = true -> Abschlussdatum setzen. */
    saveWizard: (a, ctx) => serial(async () => {
      const s = await readState(ctx);
      const prev = s.wizard || {};
      const step = Math.min(4, Math.max(0, Math.round(Number(a.step) || 0)));
      const vendor = ['nvidia', 'amd', 'intel'].includes(a.vendor) ? a.vendor : prev.vendor || null;
      s.wizard = { ...prev, checks: logic.cleanChecks(a.checks), step, vendor, updatedAt: Date.now() };
      if (a.done === true) s.wizard.completedAt = Date.now();
      await ctx.core.writeState(STATE, s);
      return s.wizard;
    }),

    saveStormTest: (a, ctx) => serial(async () => {
      const t = logic.cleanStormTest(a);
      if (!t) throw new HelixError('BAD_ARG', 'Ungültiges Testergebnis.');
      const s = await readState(ctx);
      s.stormTests = [...(Array.isArray(s.stormTests) ? s.stormTests : []), { at: Date.now(), ...t }].slice(-TESTS_MAX);
      await ctx.core.writeState(STATE, s);
      return { saved: true, count: s.stormTests.length };
    }),

    /** Windows-Farbkalibrierung (dccw.exe) starten – ein Windows-eigenes Programm. */
    async openCalibration(_a, ctx) {
      if (!isWin(ctx)) throw new HelixError('NOT_WINDOWS', 'Die Farbkalibrierung gibt es nur unter Windows.');
      try {
        await launchDetached(logic.dccwPath(ctx.env));
      } catch (e) {
        throw new HelixError('START_FAILED', 'Die Windows-Farbkalibrierung konnte nicht gestartet werden. Tippe im Startmenü „Bildschirmfarbe kalibrieren“ ein.', { reason: e?.code || String(e?.message || e) });
      }
      return { started: true };
    },

    /** Microsoft Store: Seite der App „Windows HDR Calibration“. */
    async openHdrStore(_a, ctx) {
      if (!isWin(ctx)) throw new HelixError('NOT_WINDOWS', 'Den Microsoft Store gibt es nur unter Windows.');
      await ctx.electron.shell.openExternal(HDR_STORE_URI);
      return { opened: true };
    },

    /** Hersteller der Grafikkarte (nur lesen, für die passende Treiber-Anleitung). */
    async detectGpu(_a, ctx) {
      if (!isWin(ctx)) return { unsupported: true, vendor: null, adapters: [] };
      let json;
      try {
        json = await ctx.exec.powershell(PS_GPU, { json: true, timeout: 20000 });
      } catch (e) {
        if (e.code === 'NOT_WINDOWS') return { unsupported: true, vendor: null, adapters: [] };
        ctx.log?.('warn', 'monitor.detectGpu', e.message);
        return { vendor: null, adapters: [], failed: true };
      }
      const adapters = logic.parseAdapters(json);
      const vendor = logic.pickVendor(adapters);
      const main = vendor ? adapters.find((x) => logic.vendorOf(x) === vendor) : null;
      return { vendor, name: main?.name || null, adapters: adapters.map((x) => x.name) };
    },

    async summary(_a, ctx) {
      return logic.summaryText(await readState(ctx));
    },
  },
  _test: { deps, launchDetached, HDR_STORE_URI, PS_GPU },
};
