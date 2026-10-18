'use strict';
// Herzstück: Zustand sichern (Profil oder Backup) und einen gesicherten Zustand anwenden.
//
// Profile und Backups haben dasselbe Format:
//   <ordner>/meta.json
//   <ordner>/files/config/<relativer Pfad>   (aus ...\FortniteGame\Saved\Config)
//   <ordner>/files/saved/<relativer Pfad>    (z. B. ClientSettings.Sav außerhalb von Config)

const path = require('node:path');
const fsp = require('node:fs/promises');
const ini = require('./ini');
const { sanitizeIniText, mergeKeepTargetSensitive, isBlockedPath } = require('./sensitive');
const { SAVED_ALLOWED } = require('./scanner');
const {
  sha256, safeJoin, normRel, exists, isReadOnly, setReadOnly, writeFileSafe, removeFileSafe,
} = require('./fsutil');
const { HelixError } = require('../sys/exec');

const ROOTS = ['config', 'saved'];
const isIni = (rel) => /\.ini$/i.test(rel);
const keyOf = (root, rel) => `${root}:${normRel(rel).toLowerCase()}`;

function rootDir(roots, root) {
  const dir = roots[root];
  if (!dir) throw new HelixError('NO_TARGET', `Zielordner für "${root}" fehlt.`);
  return dir;
}

/**
 * Kopiert alle eingeschlossenen Dateien eines Scans in einen Profil-/Backup-Ordner.
 * INI-Dateien werden dabei von Login-Daten befreit.
 * Rückgabe: Liste der gespeicherten Dateien für meta.json
 */
async function capture(scanResult, destDir, { allAccounts = false } = {}) {
  const out = [];
  for (const f of scanResult.files) {
    if (!f.included && !(allAccounts && f.otherAccount)) continue;
    if (!ROOTS.includes(f.root)) continue;
    let buf = await fsp.readFile(f.abs);
    let sanitized = null;
    if (isIni(f.rel)) {
      const dec = ini.decode(buf);
      const s = sanitizeIniText(dec.text);
      if (s.changed) {
        buf = ini.encode(s.text, dec.encoding);
        sanitized = s.removed;
      }
    }
    const target = safeJoin(path.join(destDir, 'files', f.root), f.rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buf);
    out.push({
      root: f.root,
      rel: normRel(f.rel),
      size: buf.length,
      sha256: sha256(buf),
      kind: f.kind,
      label: f.label,
      readOnly: !!f.readOnly,
      ...(sanitized ? { sanitized } : {}),
    });
  }
  return out;
}

/** Liest den Inhalt einer gespeicherten Datei aus einem Profil/Backup. */
async function readStored(snapDir, file) {
  const p = safeJoin(path.join(snapDir, 'files', file.root), file.storedRel || file.rel);
  return fsp.readFile(p);
}

/** Berechnet, was beim Anwenden geschrieben würde (inkl. Übernahme sensibler Teile des Ziels). */
async function contentToWrite(stored, file, targetPath) {
  if (!isIni(file.rel)) return { buf: stored, merged: false };
  let current = null;
  try { current = await fsp.readFile(targetPath); } catch { /* neu */ }
  const dec = ini.decode(stored);
  const curText = current ? ini.decode(current).text : null;
  const m = mergeKeepTargetSensitive(dec.text, curText);
  // nichts aus dem Ziel zu übernehmen und nichts zu entfernen: gespeicherten Inhalt 1:1 schreiben
  if (!m.kept && !sanitizeIniText(dec.text).changed) return { buf: stored, merged: false };
  return { buf: ini.encode(m.text, dec.encoding), merged: true, kept: m.kept };
}

/**
 * Plant das Anwenden: welche Dateien sind neu, geändert, gleich oder werden entfernt?
 * currentScan: Ergebnis von scanner.scan() für das Ziel.
 */
/** Konto-Platzhalter aus Exporten ("Cloud/_konto_/...") auf das zuletzt benutzte Konto abbilden. */
function resolveAccount(rel, currentScan) {
  if (!/^Cloud\/_konto_\//i.test(rel)) return rel;
  const newest = (currentScan?.files || []).find((f) => f.root === 'saved' && f.kind === 'controls' && f.included);
  if (!newest) return null;
  const folder = newest.rel.split('/')[1];
  return rel.replace(/^Cloud\/_konto_\//i, `Cloud/${folder}/`);
}

async function plan(snapDir, meta, roots, currentScan, { removeExtra = true } = {}) {
  const items = [];
  const inSnap = new Set();
  for (const original of meta.files) {
    if (!ROOTS.includes(original.root) || isBlockedPath(original.rel)
      || (original.root === 'saved' && !SAVED_ALLOWED.test(original.rel))) {
      items.push({ ...original, action: 'skip', reason: 'Schutzfilter' });
      continue;
    }
    const rel = original.root === 'saved' ? resolveAccount(original.rel, currentScan) : original.rel;
    if (!rel) {
      items.push({ ...original, action: 'skip', reason: 'Kein Fortnite-Konto auf diesem PC gefunden' });
      continue;
    }
    const file = { ...original, rel, storedRel: original.rel };
    inSnap.add(keyOf(file.root, file.rel));
    const target = safeJoin(rootDir(roots, file.root), file.rel);
    const stored = await readStored(snapDir, file);
    const { buf, merged } = await contentToWrite(stored, file, target);
    let action = 'new';
    let currentSha = null;
    if (await exists(target)) {
      try {
        currentSha = sha256(await fsp.readFile(target));
        action = currentSha === sha256(buf) ? 'same' : 'change';
      } catch (e) {
        action = e.code === 'EBUSY' || e.code === 'EPERM' ? 'locked' : 'change';
      }
    }
    items.push({ ...file, action, target, merged, expectedSha: sha256(buf), currentSha });
  }
  if (removeExtra && currentScan) {
    for (const f of currentScan.files) {
      if (f.root !== 'config' || !f.included) continue;
      if (inSnap.has(keyOf(f.root, f.rel))) continue;
      if (f.sensitive) continue; // Datei mit geschützten Daten bleibt immer liegen
      items.push({ root: f.root, rel: f.rel, kind: f.kind, label: f.label, size: f.size, action: 'remove', target: f.abs });
    }
  }
  const count = (a) => items.filter((i) => i.action === a).length;
  return {
    items,
    counts: { new: count('new'), change: count('change'), same: count('same'), remove: count('remove'), skip: count('skip'), locked: count('locked') },
  };
}

/**
 * Wendet ein Profil/Backup an. Vorher muss der Aufrufer ein Backup erstellt haben.
 * options.readOnly: 'none' | 'all' | Array von kinds (z. B. ['controls','video'])
 * options.restoreReadOnly: Schreibschutz wie im Backup gespeichert wiederherstellen
 */
async function apply(snapDir, meta, roots, currentScan, options = {}) {
  const { removeExtra = true, readOnly = 'none', restoreReadOnly = false } = options;
  const p = await plan(snapDir, meta, roots, currentScan, { removeExtra });
  const written = [];
  const removed = [];
  const same = [];
  const failed = [];
  const readOnlySet = [];
  const readOnlyCleared = [];

  for (const item of p.items) {
    if (item.action === 'skip') continue;
    if (item.action === 'locked') {
      failed.push({ root: item.root, rel: item.rel, label: item.label, code: 'LOCKED', message: 'Die Datei ist gerade von einem anderen Programm geöffnet (z. B. Virenscanner).' });
      continue;
    }
    try {
      if (item.action === 'remove') {
        await removeFileSafe(item.target);
        removed.push({ root: item.root, rel: item.rel, label: item.label });
        continue;
      }
      const stored = await readStored(snapDir, item);
      const { buf } = await contentToWrite(stored, item, item.target);
      if (item.action === 'same') {
        same.push({ root: item.root, rel: item.rel, label: item.label, sha256: sha256(buf) });
      } else {
        await writeFileSafe(item.target, buf);
        const check = sha256(await fsp.readFile(item.target));
        if (check !== sha256(buf)) throw new HelixError('VERIFY_FAILED', 'Datei wurde nicht korrekt geschrieben.');
        written.push({ root: item.root, rel: item.rel, label: item.label, size: buf.length, sha256: check, action: item.action });
      }
    } catch (e) {
      failed.push({ root: item.root, rel: item.rel, label: item.label, code: e.code || 'ERR', message: e.message });
    }
  }

  if (failed.length) {
    return { ok: false, plan: p.counts, written, removed, same, failed, readOnlySet, readOnlyCleared };
  }

  // Schreibschutz setzen bzw. aufheben
  const applied = [...written, ...same];
  for (const f of applied) {
    const target = safeJoin(rootDir(roots, f.root), f.rel);
    const fileMeta = p.items.find((m) => keyOf(m.root, m.rel) === keyOf(f.root, f.rel)) || {};
    let want;
    if (restoreReadOnly) want = !!fileMeta.readOnly;
    // ClientSettings (Cloud-Kopie) wird nie schreibgeschützt: Fortnite holt sie ohnehin aus der Cloud
    else if (readOnly === 'all') want = f.root === 'config';
    else if (Array.isArray(readOnly)) want = f.root === 'config' && readOnly.includes(fileMeta.kind);
    else want = false;
    try {
      const isRo = await isReadOnly(target);
      if (want && !isRo) { await setReadOnly(target, true); readOnlySet.push(f.rel); }
      if (!want && isRo) { await setReadOnly(target, false); readOnlyCleared.push(f.rel); }
      f.readOnly = want;
    } catch (e) {
      failed.push({ root: f.root, rel: f.rel, code: e.code || 'ERR', message: `Schreibschutz: ${e.message}` });
    }
  }

  return { ok: failed.length === 0, plan: p.counts, written, removed, same, failed, readOnlySet, readOnlyCleared };
}

module.exports = { capture, plan, apply, readStored, contentToWrite, keyOf, resolveAccount, ROOTS };
