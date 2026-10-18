'use strict';
// Vorsichtiger INI-Leser/-Schreiber für Unreal-Engine-Dateien.
// Jede Zeile bleibt erhalten (Kommentare, Leerzeilen, doppelte Schlüssel, +/- Präfixe).
// Geändert werden nur die Zeilen, die wirklich geändert werden sollen.

/** Erkennt die Kodierung einer Datei anhand von BOM bzw. Null-Bytes. */
function decode(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8bom' };
  }
  // UTF-16 ohne BOM: sehr viele Null-Bytes an ungeraden Stellen
  if (buf.length >= 8) {
    let zeros = 0;
    const n = Math.min(buf.length, 512);
    for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++;
    if (zeros > n / 4) return { text: buf.toString('utf16le'), encoding: 'utf16le-nobom' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

function encode(text, encoding) {
  switch (encoding) {
    case 'utf16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16le-nobom': return Buffer.from(text, 'utf16le');
    case 'utf16be': {
      const b = Buffer.from(text, 'utf16le');
      b.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
    }
    case 'utf8bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    default: return Buffer.from(text, 'utf8');
  }
}

const SECTION_RE = /^\s*\[(.+)\]\s*$/;

function parseLine(raw, section) {
  const m = SECTION_RE.exec(raw);
  if (m) return { raw, type: 'section', name: m[1].trim() };
  const t = raw.trim();
  if (!t || t.startsWith(';') || t.startsWith('#')) return { raw, type: 'other', section };
  const eq = raw.indexOf('=');
  if (eq <= 0) return { raw, type: 'other', section };
  const keyRaw = raw.slice(0, eq).trim();
  const op = /^[+\-.!]/.test(keyRaw) ? keyRaw[0] : '';
  const key = op ? keyRaw.slice(1) : keyRaw;
  return { raw, type: 'kv', section, op, key, value: raw.slice(eq + 1) };
}

function parse(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const parts = text.split(/\r?\n/);
  const trailingNewline = parts.length > 1 && parts[parts.length - 1] === '';
  if (trailingNewline) parts.pop();
  const lines = [];
  let section = null;
  for (const raw of parts) {
    const line = parseLine(raw, section);
    if (line.type === 'section') section = line.name;
    lines.push(line);
  }
  return { lines, eol, trailingNewline };
}

function stringify(doc) {
  const body = doc.lines.map((l) => l.raw).join(doc.eol);
  return doc.trailingNewline || doc.lines.length === 0 ? body + doc.eol : body;
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function sectionNames(doc) {
  const names = [];
  for (const l of doc.lines) if (l.type === 'section' && !names.some((n) => same(n, l.name))) names.push(l.name);
  return names;
}

/** Letzter Wert eines Schlüssels (ohne +/- Präfix) in einem Abschnitt, sonst null. */
function get(doc, section, key) {
  let val = null;
  for (const l of doc.lines) {
    if (l.type === 'kv' && !l.op && same(l.section, section) && same(l.key, key)) val = l.value;
  }
  return val;
}

function toObject(doc) {
  const obj = {};
  for (const l of doc.lines) {
    if (l.type !== 'kv' || l.op) continue;
    const s = l.section ?? '';
    (obj[s] ||= {})[l.key] = l.value;
  }
  return obj;
}

/** Setzt einen Wert. Vorhandene Zeilen werden ersetzt, sonst am Ende des Abschnitts eingefügt. */
function set(doc, section, key, value) {
  const v = String(value);
  let found = false;
  for (const l of doc.lines) {
    if (l.type === 'kv' && !l.op && same(l.section, section) && same(l.key, key)) {
      l.value = v;
      l.raw = `${l.key}=${v}`;
      found = true;
    }
  }
  if (found) return doc;
  // letzte Zeile, die zum Abschnitt gehört (Abschnittskopf oder Inhalt), Leerzeilen am Ende überspringen
  let insertAt = -1;
  for (let i = 0; i < doc.lines.length; i++) {
    const l = doc.lines[i];
    if (l.type === 'section' && same(l.name, section)) insertAt = i;
    else if (l.type !== 'section' && same(l.section, section) && l.raw.trim() !== '') insertAt = i;
  }
  const newLine = { raw: `${key}=${v}`, type: 'kv', section, op: '', key, value: v };
  if (insertAt >= 0) {
    doc.lines.splice(insertAt + 1, 0, newLine);
  } else {
    if (doc.lines.length && doc.lines[doc.lines.length - 1].raw.trim() !== '') {
      doc.lines.push({ raw: '', type: 'other', section: doc.lines[doc.lines.length - 1].section });
    }
    doc.lines.push({ raw: `[${section}]`, type: 'section', name: section });
    doc.lines.push(newLine);
    doc.trailingNewline = true;
  }
  return doc;
}

function remove(doc, section, key) {
  doc.lines = doc.lines.filter((l) => !(l.type === 'kv' && !l.op && same(l.section, section) && same(l.key, key)));
  return doc;
}

module.exports = { decode, encode, parse, stringify, get, set, remove, toObject, sectionNames };
