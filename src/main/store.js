'use strict';
// Speichert den kompletten Programmstand (Fortschritt, eigene Daten, Einstellungen)
// in einer Datei im Benutzerordner. Unter Windows wird der Inhalt mit
// Electron safeStorage (Windows-Datenschutz DPAPI) verschlüsselt, damit andere
// Benutzerkonten auf dem PC die Daten nicht lesen können.

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

function createStore({ dir, crypto, defaults }) {
  const file = path.join(dir, FILE_NAME);
  const backup = file + '.bak';
  let writing = Promise.resolve();

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
    return wrapper.data;
  }

  function readFileState(f) {
    try {
      return decode(fs.readFileSync(f, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[store] Datei nicht lesbar:', f, err.message);
      return null;
    }
  }

  function load() {
    const state = readFileState(file) || readFileState(backup) || {};
    return withDefaults(state, structuredClone(defaults));
  }

  function writeNow(state) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, encode(state), 'utf8');
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, backup); } catch (_) { /* Sicherung ist nur ein Extra */ }
    }
    fs.renameSync(tmp, file);
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
    return withDefaults({}, structuredClone(defaults));
  }

  return { file, load, save, reset, encrypted: () => Boolean(crypto && crypto.isAvailable()) };
}

module.exports = { createStore, withDefaults, FILE_NAME };
