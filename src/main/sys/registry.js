'use strict';
// Lesen und Schreiben in der Windows-Registrierung über reg.exe.
// Schreiben ist nur unter HKCU (aktueller Benutzer) erlaubt.

const { run, IS_WIN, notOnWindows, HelixError } = require('./exec');

const TYPES = ['REG_SZ', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_BINARY', 'REG_NONE'];

/** Zerlegt die Ausgabe von `reg query KEY` in { name: {type, value} }. */
function parseRegQuery(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    if (!/^\s{2,}\S/.test(raw)) continue;
    const parts = raw.trim().split(/\s{4,}/);
    if (parts.length < 2) continue;
    const [name, type, ...rest] = parts;
    if (!TYPES.includes(type)) continue;
    const str = rest.join('    ');
    let value = str;
    if (type === 'REG_DWORD' || type === 'REG_QWORD') value = Number.parseInt(str, 16);
    values[name] = { type, value };
  }
  return values;
}

async function readKey(key, exec = run) {
  if (!IS_WIN && exec === run) throw notOnWindows('Die Registrierung');
  try {
    const out = await exec('reg.exe', ['query', key], { timeout: 10000 });
    return parseRegQuery(out);
  } catch (e) {
    if (e.code === 'EXEC_FAILED') return null; // Schlüssel fehlt
    throw e;
  }
}

async function readValue(key, name, exec = run) {
  const values = await readKey(key, exec);
  if (!values || !(name in values)) return null;
  return values[name];
}

async function writeValue(key, name, type, value, exec = run) {
  if (!IS_WIN && exec === run) throw notOnWindows('Die Registrierung');
  if (!/^HKCU\\|^HKEY_CURRENT_USER\\/i.test(key)) {
    throw new HelixError('REG_DENIED', 'HELIX ändert nur Einstellungen deines eigenen Benutzerkontos.');
  }
  if (!TYPES.includes(type)) throw new HelixError('REG_TYPE', `Unbekannter Typ ${type}`);
  await exec('reg.exe', ['add', key, '/v', name, '/t', type, '/d', String(value), '/f'], { timeout: 10000 });
}

module.exports = { parseRegQuery, readKey, readValue, writeValue };
