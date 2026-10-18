'use strict';
// Liest den kompletten Fortnite-Config-Ordner (mit allen Unterordnern) ein
// und entscheidet für jede Datei, ob sie in ein Profil gehört.

const path = require('node:path');
const fsp = require('node:fs/promises');
const { walk, sha256 } = require('./fsutil');
const { isBlockedPath, findSensitive } = require('./sensitive');
const ini = require('./ini');

const MAX_FILE = 25 * 1024 * 1024;

const KINDS = [
  { re: /(^|\/)GameUserSettings\.ini$/i, kind: 'video', label: 'Grafik, Auflösung, FPS & Anzeige' },
  { re: /(^|\/)ClientSettings[^/]*\.sav$/i, kind: 'controls', label: 'Tastenbelegung, Empfindlichkeit & Spieleinstellungen' },
  { re: /(^|\/)Engine\.ini$/i, kind: 'engine', label: 'Engine-Einstellungen' },
  { re: /(^|\/)Input\.ini$/i, kind: 'input', label: 'Eingabe' },
  { re: /(^|\/)Game\.ini$/i, kind: 'game', label: 'Spiel' },
  { re: /(^|\/)Scalability\.ini$/i, kind: 'quality', label: 'Qualitätsstufen' },
  { re: /(^|\/)DeviceProfiles\.ini$/i, kind: 'device', label: 'Geräteprofile' },
  { re: /CrashReport/i, kind: 'crash', label: 'Einstellungen für Fehlerberichte' },
  { re: /\.sav$/i, kind: 'save', label: 'Gespeicherte Einstellungen' },
  { re: /\.ini$/i, kind: 'ini', label: 'Weitere Einstellungen' },
];

function classify(rel) {
  for (const k of KINDS) if (k.re.test(rel)) return { kind: k.kind, label: k.label };
  return { kind: 'other', label: 'Weitere Datei' };
}

const isIni = (rel) => /\.ini$/i.test(rel);

/** Ordner außerhalb von Config, in denen zusätzlich nach ClientSettings*.Sav gesucht wird. */
function skipSavedDir(rel, name) {
  if (rel.split('/').length === 1 && /^config$/i.test(name)) return true; // Config wird separat gelesen
  return isBlockedPath(rel + '/x');
}

async function describe(root, f) {
  const entry = {
    root,
    rel: f.rel,
    abs: f.abs,
    size: f.size,
    mtimeMs: f.mtimeMs,
    readOnly: f.readOnly,
    ...classify(f.rel),
    included: true,
    reason: null,
    sensitive: null,
    sha256: null,
  };
  if (isBlockedPath(f.rel)) {
    entry.included = false;
    entry.reason = 'Schutzfilter: sieht nach Login-, Browser- oder Protokolldaten aus';
    return entry;
  }
  if (f.size > MAX_FILE) {
    entry.included = false;
    entry.reason = 'Zu groß für ein Einstellungsprofil';
    return entry;
  }
  try {
    const buf = await fsp.readFile(f.abs);
    entry.sha256 = sha256(buf);
    if (isIni(f.rel)) {
      const found = findSensitive(ini.parse(ini.decode(buf).text));
      const n = found.sections.length + found.keys.length;
      if (n) entry.sensitive = { sections: found.sections, keys: found.keys.map((k) => `${k.section || ''}:${k.key}`) };
    }
  } catch (e) {
    entry.included = false;
    entry.reason = e.code === 'EBUSY' || e.code === 'EPERM' ? 'Gerade gesperrt (läuft Fortnite?)' : 'Nicht lesbar';
  }
  return entry;
}

/**
 * Liest alle Einstellungsdateien.
 * Rückgabe: { configDir, savedDir, files: [...], errors: [...], totals }
 */
async function scan({ configDir, savedDir }) {
  const files = [];
  const errors = [];

  const cfg = await walk(configDir, { maxDepth: 10, maxFiles: 3000 });
  errors.push(...cfg.errors.map((e) => ({ root: 'config', ...e })));
  for (const f of cfg.files) files.push(await describe('config', f));

  // ClientSettings*.Sav kann je nach Fortnite-Version auch außerhalb von Config liegen
  if (savedDir) {
    const extra = await walk(savedDir, { maxDepth: 5, maxFiles: 3000, skipDir: skipSavedDir });
    for (const f of extra.files) {
      if (f.rel.split('/').length === 1 && !/^ClientSettings[^/]*\.sav$/i.test(f.rel)) continue;
      if (!/(^|\/)ClientSettings[^/]*\.sav$/i.test(f.rel)) continue;
      files.push(await describe('saved', f));
    }
  }

  const included = files.filter((f) => f.included);
  return {
    configDir,
    savedDir,
    scannedAt: Date.now(),
    files,
    errors,
    totals: {
      found: files.length,
      included: included.length,
      bytes: included.reduce((n, f) => n + f.size, 0),
      readOnly: files.filter((f) => f.readOnly).length,
      hasGameUserSettings: included.some((f) => f.kind === 'video'),
      hasClientSettings: included.some((f) => f.kind === 'controls'),
    },
  };
}

module.exports = { scan, classify };
