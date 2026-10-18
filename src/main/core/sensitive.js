'use strict';
// Schutzfilter: HELIX speichert und kopiert NIE Login-Daten, Tokens, Cookies
// oder Dateien des Epic Games Launchers.
//
// 1. Ganze Ordner/Dateien, die nie angefasst werden (Pfadregeln).
// 2. Innerhalb von INI-Dateien: Abschnitte und Schlüssel, die nach Anmeldedaten aussehen,
//    werden beim Speichern entfernt und beim Anwenden aus der Zieldatei übernommen.

const ini = require('./ini');

// Ordner- oder Dateinamen, die nie in ein Profil kommen
const BLOCKED_SEGMENT = /^(webcache.*|cef.*|epicgameslauncher|epiconlineservices.*|eos.*cache.*|cookies?|local storage|session storage|indexeddb|network|gpucache|code cache|service worker|blob_storage|login data.*|web data.*|logs?|crashes|demos|persistentdownloaddir|cloudstorage)$/i;
const BLOCKED_FILE = /(token|credential|cookie|password|passwd|oauth|secret|login\s*data|\.ldb$|\.log$|\.dmp$|\.tmp$|\.helix-tmp$|^lock$|^lockfile$)/i;

/** true, wenn ein relativer Pfad (Ordner/Datei) nie gesichert werden darf. */
function isBlockedPath(rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return true;
  const file = parts[parts.length - 1];
  if (parts.slice(0, -1).some((p) => BLOCKED_SEGMENT.test(p))) return true;
  if (BLOCKED_SEGMENT.test(file)) return true;
  return BLOCKED_FILE.test(file);
}

const SECTION_RE = /(remember\s*me|credential|oauth|\bauth\b|authentication|token|password|cookie|login)/i;
const KEY_RE = /(token|password|passwd|secret|credential|cookie|refresh|oauth|api_?key|session_?id|auth_?code|exchange_?code|remember_?me|^auth$|^authorization$)/i;
const BLOB_RE = /^[A-Za-z0-9+/=_\-.]{120,}$/;

function isSensitiveSection(name) {
  return SECTION_RE.test(String(name || ''));
}

function isSensitiveKey(key, value) {
  if (KEY_RE.test(String(key || ''))) return true;
  const v = String(value ?? '').trim().replace(/^"|"$/g, '');
  return BLOB_RE.test(v);
}

/** Findet sensible Stellen in einem geparsten INI-Dokument. */
function findSensitive(doc) {
  const sections = new Set();
  const keys = [];
  for (const l of doc.lines) {
    if (l.type === 'section' && isSensitiveSection(l.name)) sections.add(l.name.toLowerCase());
  }
  for (const l of doc.lines) {
    if (l.type !== 'kv') continue;
    if (l.section && sections.has(String(l.section).toLowerCase())) continue;
    if (isSensitiveKey(l.key, l.value)) keys.push({ section: l.section, key: l.key, op: l.op });
  }
  return { sections: [...sections], keys };
}

function lineIsSensitive(l, sensSections) {
  const sec = String(l.section ?? (l.type === 'section' ? l.name : '')).toLowerCase();
  if (l.type === 'section') return sensSections.has(String(l.name).toLowerCase());
  if (l.section && sensSections.has(sec)) return true;
  return l.type === 'kv' && isSensitiveKey(l.key, l.value);
}

/**
 * Entfernt sensible Abschnitte/Schlüssel aus einem INI-Text.
 * Rückgabe: { text, removed: [{section, key?}], changed }
 */
function sanitizeIniText(text) {
  const doc = ini.parse(text);
  const found = findSensitive(doc);
  if (!found.sections.length && !found.keys.length) return { text, removed: [], changed: false };
  const sens = new Set(found.sections);
  doc.lines = doc.lines.filter((l) => !lineIsSensitive(l, sens));
  const removed = [
    ...found.sections.map((s) => ({ section: s })),
    ...found.keys.map((k) => ({ section: k.section, key: k.key })),
  ];
  return { text: ini.stringify(doc), removed, changed: true };
}

/** Hängt eine Zeile an das Ende eines Abschnitts (legt ihn bei Bedarf an). */
function appendToSection(doc, section, line) {
  if (section == null) {
    let i = 0;
    while (i < doc.lines.length && doc.lines[i].type !== 'section') i++;
    doc.lines.splice(i, 0, line);
    return;
  }
  let at = -1;
  for (let i = 0; i < doc.lines.length; i++) {
    const l = doc.lines[i];
    if (l.type === 'section' && l.name.toLowerCase() === String(section).toLowerCase()) at = i;
    else if (l.type !== 'section' && l.section && String(l.section).toLowerCase() === String(section).toLowerCase() && l.raw.trim() !== '') at = i;
  }
  if (at >= 0) {
    doc.lines.splice(at + 1, 0, line);
    return;
  }
  if (doc.lines.length && doc.lines[doc.lines.length - 1].raw.trim() !== '') {
    doc.lines.push({ raw: '', type: 'other', section: null });
  }
  doc.lines.push({ raw: `[${section}]`, type: 'section', name: section });
  doc.lines.push(line);
  doc.trailingNewline = true;
}

/**
 * Baut die Datei, die beim Anwenden geschrieben wird:
 * Inhalt aus dem Profil + sensible Teile aus der aktuellen Datei des Zielkontos.
 * So bleiben z. B. Anmeldedaten des gerade eingeloggten Kontos unangetastet.
 */
function mergeKeepTargetSensitive(profileText, currentText) {
  const clean = sanitizeIniText(profileText).text;
  if (currentText == null) return { text: clean, kept: 0 };
  const cur = ini.parse(currentText);
  const found = findSensitive(cur);
  if (!found.sections.length && !found.keys.length) return { text: clean, kept: 0 };
  const out = ini.parse(clean);
  const sens = new Set(found.sections);
  let kept = 0;
  // ganze sensible Abschnitte unverändert ans Ende hängen
  const blocks = [];
  let inSens = false;
  for (const l of cur.lines) {
    if (l.type === 'section') inSens = sens.has(l.name.toLowerCase());
    if (inSens) blocks.push(l.raw);
  }
  // einzelne sensible Schlüssel wieder in ihren Abschnitt setzen (Reihenfolge wie im Original)
  for (const l of cur.lines) {
    if (l.type !== 'kv') continue;
    if (l.section && sens.has(String(l.section).toLowerCase())) continue;
    if (!isSensitiveKey(l.key, l.value)) continue;
    appendToSection(out, l.section, { ...l });
    kept++;
  }
  let text = ini.stringify(out);
  if (blocks.length) {
    const eol = out.eol;
    if (!text.endsWith(eol)) text += eol;
    if (text.trim()) text += eol;
    text += blocks.join(eol) + eol;
    kept += found.sections.length;
  }
  return { text, kept };
}

module.exports = {
  isBlockedPath, isSensitiveSection, isSensitiveKey, findSensitive, sanitizeIniText, mergeKeepTargetSensitive,
};
