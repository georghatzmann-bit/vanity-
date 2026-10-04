'use strict';
// Speichert den kompletten Programmstand (Fortschritt, eigene Daten, Einstellungen)
// in einer Datei im Benutzerordner. Unter Windows wird der Inhalt mit
// Electron safeStorage (Windows-Datenschutz DPAPI) verschlüsselt, damit andere
// Benutzerkonten auf dem PC die Daten nicht lesen können.
//
// Wichtig: Eine vorhandene Datei, die sich nicht lesen lässt (z. B. weil Windows den
// Schlüssel verloren hat), wird NIE überschrieben, sondern beiseitegelegt.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'konto-retter-daten.json';
const STATE_VERSION = 1;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Füllt fehlende Schlüssel aus den Standardwerten auf, ohne vorhandene Werte zu überschreiben.
function withDefaults(value, defaults) {
  if (!isPlainObject(defaults)) return value === undefined ? defaults : value;
  const out = isPlainObject(value) ? { ...value } : {};
  for (const key of Object.keys(defaults)) {
    out[key] = withDefaults(out[key], defaults[key]);
  }
  return out;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createStore({ dir, crypto, defaults }) {
  const file = path.join(dir, FILE_NAME);
  const backup = file + '.bak';
  let writing = Promise.resolve();
  // Darf die aktuelle Datei als Sicherung (.bak) weitergereicht werden?
  // Nur wenn sie in dieser Sitzung gelesen oder von uns geschrieben wurde.
  let fileTrusted = false;
  let loadProblem = null;

  function encode(state) {
    const json = JSON.stringify(state);
    if (crypto && crypto.isAvailable()) {
      return JSON.stringify({ format: 'konto-retter', version: STATE_VERSION, enc: 'safeStorage', data: crypto.encrypt(json).toString('base64') });
    }
    return JSON.stringify({ format: 'konto-retter', version: STATE_VERSION, enc: 'none', data: state }, null, 2);
  }

  function decode(raw) {
    const wrapper = JSON.parse(raw);
    if (!wrapper || wrapper.format !== 'konto-retter') throw new Error('Unbekanntes Dateiformat');
    if (wrapper.enc === 'safeStorage') {
      if (!crypto || !crypto.isAvailable()) throw new Error('Verschlüsselung auf diesem PC nicht verfügbar');
      return JSON.parse(crypto.decrypt(Buffer.from(wrapper.data, 'base64')));
    }
    if (!isPlainObject(wrapper.data)) throw new Error('Leerer Speicherstand');
    return wrapper.data;
  }

  // Ergebnis: { state } wenn lesbar, { missing: true } wenn nicht vorhanden, { error } wenn kaputt
  function readFileState(f) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { missing: true };
      return { error: err };
    }
    try {
      return { state: decode(raw) };
    } catch (err) {
      return { error: err };
    }
  }

  // Unlesbare Datei umbenennen, damit sie garantiert nie überschrieben wird.
  function setAside(f) {
    const target = path.join(dir, 'konto-retter-daten.unlesbar-' + timestamp() + (f === backup ? '.bak' : '') + '.json');
    try {
      fs.renameSync(f, target);
      return target;
    } catch (_) {
      // Umbenennen gesperrt (z. B. Virenscanner hält die Datei offen): dann wenigstens kopieren
      try {
        fs.copyFileSync(f, target);
        return target;
      } catch (err) {
        console.warn('[store] Konnte unlesbare Datei nicht sichern:', err.message);
        return null;
      }
    }
  }

  function load() {
    loadProblem = null;
    const main = readFileState(file);
    if (main.state) {
      fileTrusted = true;
      return withDefaults(main.state, structuredClone(defaults));
    }
    const bak = readFileState(backup);
    const kept = [];
    if (main.error) {
      const moved = setAside(file);
      if (moved) kept.push(moved);
    }
    if (bak.state) {
      // Hauptdatei kaputt, Sicherung gut: mit der Sicherung weitermachen
      fileTrusted = false;
      if (main.error) loadProblem = { kind: 'restored-backup', kept };
      return withDefaults(bak.state, structuredClone(defaults));
    }
    if (bak.error) {
      const moved = setAside(backup);
      if (moved) kept.push(moved);
    }
    if (main.error || bak.error) loadProblem = { kind: 'unreadable', kept };
    fileTrusted = false;
    return withDefaults({}, structuredClone(defaults));
  }

  function writeNow(state) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, encode(state), 'utf8');
    if (fileTrusted && fs.existsSync(file)) {
      try { fs.copyFileSync(file, backup); } catch (_) { /* Sicherung ist nur ein Extra */ }
    }
    fs.renameSync(tmp, file);
    fileTrusted = true;
  }

  // Schreibvorgänge nacheinander ausführen, damit sich zwei Speicherungen nie überholen.
  function save(state) {
    const clean = withDefaults(state, structuredClone(defaults));
    writing = writing.then(() => writeNow(clean), () => writeNow(clean));
    return writing;
  }

  function reset() {
    for (const f of [file, backup]) {
      try { fs.unlinkSync(f); } catch (_) { /* nicht vorhanden */ }
    }
    fileTrusted = false;
    return withDefaults({}, structuredClone(defaults));
  }

  return {
    file,
    load,
    save,
    reset,
    problem: () => loadProblem,
    encrypted: () => Boolean(crypto && crypto.isAvailable()),
  };
}

module.exports = { createStore, withDefaults, FILE_NAME };
