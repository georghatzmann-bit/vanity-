'use strict';
// Datei-Hilfen: sicheres Schreiben, Schreibschutz, Prüfsummen, Ordner durchsuchen.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { HelixError } = require('../sys/exec');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function sha256File(file) {
  return sha256(await fsp.readFile(file));
}

/** Wandelt einen gespeicherten relativen Pfad ("a/b.ini") sicher in einen echten Pfad um. */
function safeJoin(root, rel) {
  const s = String(rel || '');
  if (!s || s.includes('\0')) throw new HelixError('BAD_PATH', 'Ungültiger Dateipfad.');
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) throw new HelixError('BAD_PATH', 'Ungültiger Dateipfad.');
  if (/^[a-zA-Z]:$/.test(parts[0]) || s.startsWith('/') || s.startsWith('\\')) {
    throw new HelixError('BAD_PATH', `Absoluter Pfad nicht erlaubt: ${s}`);
  }
  for (const p of parts) {
    if (p === '..' || p === '.' || /[<>:"|?*]/.test(p) || /[. ]$/.test(p)) {
      throw new HelixError('BAD_PATH', `Ungültiger Pfadteil "${p}" in ${s}`);
    }
  }
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  if (!full.startsWith(base + path.sep)) throw new HelixError('BAD_PATH', `Pfad zeigt aus dem Ordner heraus: ${s}`);
  return full;
}

/** Vereinheitlicht relative Pfade auf "/" als Trenner. */
function normRel(rel) {
  return String(rel).split(/[\\/]+/).filter(Boolean).join('/');
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function isReadOnly(file) {
  try {
    const st = await fsp.stat(file);
    return (st.mode & 0o200) === 0;
  } catch { return false; }
}

async function setReadOnly(file, on) {
  // Unter Windows setzt bzw. entfernt chmod das Attribut "Schreibgeschützt".
  await fsp.chmod(file, on ? 0o444 : 0o666);
}

/** Wiederholt eine Datei-Aktion kurz, wenn Windows die Datei gerade sperrt. */
async function retry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      await sleep(80 * (i + 1));
    }
  }
  throw last;
}

/**
 * Schreibt eine Datei möglichst sicher: erst in eine Hilfsdatei, dann umbenennen.
 * Ein vorhandener Schreibschutz wird vorher entfernt.
 */
async function writeFileSafe(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (await exists(file) && await isReadOnly(file)) await setReadOnly(file, false);
  const tmp = `${file}.helix-tmp`;
  await fsp.writeFile(tmp, data);
  try {
    await retry(() => fsp.rename(tmp, file));
  } catch (e) {
    // Fallback: direkt überschreiben (z. B. wenn ein Virenscanner das Umbenennen blockiert)
    try {
      await retry(() => fsp.writeFile(file, data));
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
    if (!(await exists(file))) throw e;
  }
}

async function removeFileSafe(file) {
  if (!(await exists(file))) return;
  if (await isReadOnly(file)) await setReadOnly(file, false);
  await retry(() => fsp.rm(file, { force: true }));
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    if (e instanceof SyntaxError) {
      // kaputte Datei beiseitelegen statt Daten zu verlieren
      await fsp.rename(file, `${file}.kaputt-${Date.now()}`).catch(() => {});
      return fallback;
    }
    throw e;
  }
}

async function writeJson(file, obj) {
  await writeFileSafe(file, JSON.stringify(obj, null, 2));
}

/**
 * Durchsucht einen Ordner rekursiv (ohne Verknüpfungen zu folgen).
 * Rückgabe: { files: [{rel, abs, size, mtimeMs, readOnly}], errors: [{rel, code}] }
 */
async function walk(root, { maxDepth = 10, maxFiles = 5000, skipDir } = {}) {
  const files = [];
  const errors = [];
  async function visit(dir, relParts, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ rel: relParts.join('/') || '.', code: e.code || 'ERR' });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (files.length >= maxFiles) return;
      const abs = path.join(dir, ent.name);
      const relP = [...relParts, ent.name];
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (skipDir && skipDir(relP.join('/'), ent.name)) continue;
        await visit(abs, relP, depth + 1);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(abs);
          files.push({ rel: relP.join('/'), abs, size: st.size, mtimeMs: Math.round(st.mtimeMs), readOnly: (st.mode & 0o200) === 0 });
        } catch (e) {
          errors.push({ rel: relP.join('/'), code: e.code || 'ERR' });
        }
      }
    }
  }
  await visit(root, [], 0);
  return { files, errors };
}

async function dirSize(root) {
  const { files } = await walk(root, { maxDepth: 30, maxFiles: 200000 });
  return { bytes: files.reduce((n, f) => n + f.size, 0), count: files.length };
}

module.exports = {
  sleep, sha256, sha256File, safeJoin, normRel, exists, isDir, isReadOnly, setReadOnly, retry,
  writeFileSafe, removeFileSafe, readJson, writeJson, walk, dirSize, fs,
};
