'use strict';
// Export und Import von Profilen als einzelne Datei (*.helixprofil, intern ein ZIP).
// Beim Import wird alles genau geprüft: keine Pfade außerhalb, keine Login-Daten, Größenlimits.

const path = require('node:path');
const fsp = require('node:fs/promises');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const ini = require('./ini');
const { sanitizeIniText, isBlockedPath } = require('./sensitive');
const { safeJoin, normRel, sha256, writeJson, retry } = require('./fsutil');
const { readStored, ROOTS } = require('./engine');
const { classify } = require('./scanner');
const { HelixError } = require('../sys/exec');

const MANIFEST = 'helix-profil.json';
const MAX_ARCHIVE = 60 * 1024 * 1024;
const MAX_ENTRY = 25 * 1024 * 1024;
const MAX_FILES = 2000;

async function exportProfile(store, id, outFile) {
  const meta = await store.get(id);
  const dir = store.dir(id);
  const entries = {};
  for (const f of meta.files) {
    entries[`files/${f.root}/${normRel(f.rel)}`] = new Uint8Array(await readStored(dir, f));
  }
  const manifest = {
    format: 'helix-profil',
    version: 1,
    exportedAt: Date.now(),
    profile: {
      name: meta.name, notes: meta.notes || '', color: meta.color, options: meta.options, summary: meta.summary,
      files: meta.files.map(({ root, rel, size, sha256: h, kind, label, sanitized }) => ({ root, rel, size, sha256: h, kind, label, sanitized })),
    },
  };
  entries[MANIFEST] = strToU8(JSON.stringify(manifest, null, 2));
  const zip = zipSync(entries, { level: 6 });
  await fsp.writeFile(outFile, zip);
  return { file: outFile, bytes: zip.length, files: meta.files.length };
}

/**
 * Liest eine Exportdatei und legt daraus ein neues Profil an.
 * uniqueName(name) liefert einen freien Namen (z. B. "Main (2)").
 */
async function importProfile(store, inFile, uniqueName) {
  const st = await fsp.stat(inFile);
  if (st.size > MAX_ARCHIVE) throw new HelixError('IMPORT_TOO_BIG', 'Die Datei ist zu groß für ein Einstellungsprofil.');
  const data = new Uint8Array(await fsp.readFile(inFile));
  let count = 0;
  let entries;
  try {
    entries = unzipSync(data, {
      filter: (f) => {
        count++;
        return count <= MAX_FILES + 1 && f.originalSize <= MAX_ENTRY;
      },
    });
  } catch {
    throw new HelixError('IMPORT_BROKEN', 'Die Datei ist beschädigt oder kein HELIX-Profil.');
  }
  if (!entries[MANIFEST]) throw new HelixError('IMPORT_BROKEN', 'Das ist kein HELIX-Profil (Inhaltsverzeichnis fehlt).');
  let manifest;
  try { manifest = JSON.parse(strFromU8(entries[MANIFEST])); } catch {
    throw new HelixError('IMPORT_BROKEN', 'Das Inhaltsverzeichnis des Profils ist beschädigt.');
  }
  if (manifest.format !== 'helix-profil' || !manifest.profile) {
    throw new HelixError('IMPORT_BROKEN', 'Das ist kein HELIX-Profil.');
  }

  await fsp.mkdir(store.root, { recursive: true });
  const name = await uniqueName(String(manifest.profile.name || 'Importiert').slice(0, 40).trim() || 'Importiert');
  const id = store.newId(name);
  const tmp = path.join(store.root, `.tmp-${id}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  const files = [];
  const rejected = [];
  try {
    for (const [entryName, content] of Object.entries(entries)) {
      if (entryName === MANIFEST || entryName.endsWith('/')) continue;
      const m = /^files\/(config|saved)\/(.+)$/.exec(entryName);
      if (!m || !ROOTS.includes(m[1])) { rejected.push(entryName); continue; }
      const root = m[1];
      const rel = normRel(m[2]);
      if (isBlockedPath(rel)) { rejected.push(rel); continue; }
      let target;
      try { target = safeJoin(path.join(tmp, 'files', root), rel); } catch { rejected.push(rel); continue; }
      let buf = Buffer.from(content);
      let sanitized = null;
      if (/\.ini$/i.test(rel)) {
        const dec = ini.decode(buf);
        const s = sanitizeIniText(dec.text);
        if (s.changed) { buf = ini.encode(s.text, dec.encoding); sanitized = s.removed; }
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, buf);
      const fromManifest = (manifest.profile.files || []).find((f) => f.root === root && normRel(f.rel) === rel) || {};
      files.push({
        root, rel, size: buf.length, sha256: sha256(buf), ...classify(rel),
        readOnly: false, ...(sanitized || fromManifest.sanitized ? { sanitized: sanitized || fromManifest.sanitized } : {}),
      });
    }
    if (!files.length) throw new HelixError('IMPORT_EMPTY', 'Im Profil waren keine verwendbaren Dateien.');
    const opts = manifest.profile.options || {};
    const meta = {
      schema: 1,
      type: 'profile',
      id,
      name,
      notes: String(manifest.profile.notes || '').slice(0, 500),
      color: Number.isFinite(manifest.profile.color) ? manifest.profile.color : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      importedAt: Date.now(),
      source: { imported: path.basename(inFile) },
      files,
      summary: manifest.profile.summary && typeof manifest.profile.summary === 'object' ? manifest.profile.summary : null,
      options: {
        readOnly: opts.readOnly === 'all' || Array.isArray(opts.readOnly) ? opts.readOnly : 'none',
        removeExtra: opts.removeExtra !== false,
      },
      stats: { appliedCount: 0, lastAppliedAt: null },
    };
    await writeJson(path.join(tmp, 'meta.json'), meta);
    await retry(() => fsp.rename(tmp, store.dir(id)));
    return { meta, rejected };
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

module.exports = { exportProfile, importProfile, MANIFEST };
