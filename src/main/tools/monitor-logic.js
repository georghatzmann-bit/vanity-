'use strict';
// Monitor-Tuner: reine Hilfsfunktionen des Hauptprozesses (testbar ohne Windows).

const path = require('node:path');

/** Ausgabe von Get-CimInstance Win32_VideoController (ConvertTo-Json) -> Liste. */
function parseAdapters(json) {
  const arr = Array.isArray(json) ? json : json && typeof json === 'object' ? [json] : [];
  return arr
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      name: String(a.Name || '').trim(),
      vendorText: String(a.AdapterCompatibility || '').trim(),
      pnp: String(a.PNPDeviceID || '').trim(),
    }))
    .filter((a) => a.name || a.pnp);
}

function vendorOf(a) {
  const text = `${a.name} ${a.vendorText} ${a.pnp}`;
  if (/VEN_10DE|nvidia/i.test(text)) return 'nvidia';
  if (/VEN_1002|VEN_1022|\bamd\b|radeon|advanced micro devices|\bati\b/i.test(text)) return 'amd';
  if (/VEN_8086|intel/i.test(text)) return 'intel';
  return null;
}

/** Hersteller der eigentlichen Grafikkarte (eigene Karte vor eingebauter Intel-Grafik). */
function pickVendor(adapters) {
  const found = new Set(adapters.map(vendorOf).filter(Boolean));
  for (const v of ['nvidia', 'amd', 'intel']) if (found.has(v)) return v;
  return null;
}

/** Pfad zur Windows-Farbkalibrierung, nur aus Umgebungsvariablen (kein fester Pfad). */
function dccwPath(env = {}) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR;
  return root ? path.win32.join(root, 'System32', 'dccw.exe') : 'dccw.exe';
}

/** Datum als TT.MM.JJJJ (ohne Abhängigkeit von der Spracheinstellung). */
function fmtDay(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Zeile fürs Cockpit oder null. */
function summaryText(state) {
  const at = state?.wizard?.completedAt;
  const tests = Array.isArray(state?.stormTests) ? state.stormTests : [];
  const last = tests[tests.length - 1];
  const parts = [];
  if (at && fmtDay(at)) parts.push(`Monitor eingerichtet am ${fmtDay(at)}`);
  if (last && Number.isFinite(last.seen) && Number.isFinite(last.total)) parts.push(`Sturm-Test ${last.seen} von ${last.total}`);
  return parts.length ? { text: parts.join(' · ') } : null;
}

const CHECK_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Haken aus der Oberfläche säubern: nur bekannte Form, nur true-Werte. */
function cleanChecks(checks) {
  const out = {};
  if (!checks || typeof checks !== 'object') return out;
  for (const [k, v] of Object.entries(checks).slice(0, 100)) if (CHECK_ID.test(k) && v === true) out[k] = true;
  return out;
}

function cleanStormTest(a) {
  const total = Math.round(Number(a?.total));
  const seen = Math.round(Number(a?.seen));
  if (!Number.isFinite(total) || total < 1 || total > 20) return null;
  if (!Number.isFinite(seen) || seen < 0 || seen > 20) return null;
  return { seen, total };
}

module.exports = { parseAdapters, vendorOf, pickVendor, dccwPath, fmtDay, summaryText, cleanChecks, cleanStormTest };
