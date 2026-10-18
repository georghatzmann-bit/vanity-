'use strict';
// Replay-Tresor – reine Logik (testbar ohne Windows).
// Liest NUR den Dateikopf einer Fortnite-Replay-Datei (Unreal-Engine-Format, erste 64 KB).
// Es wird nichts entschlüsselt und nichts verändert. Der Schlüssel im Kopf wird übersprungen, nie benutzt.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { HelixError } = require('../sys/exec');

const REPLAY_MAGIC = 0x1ca2e27f;
const HEADER_CHUNK_MAGIC = 0x2cf5a13d;
const HEAD_BYTES = 64 * 1024;
const TICKS_UNIX_EPOCH = 621355968000000000n; // 0001-01-01 bis 1970-01-01 in 100-ns-Schritten
const RECORDING_WINDOW_MS = 2 * 60 * 1000;
const BRANCH_MARK = '++Fortnite+Release-';

/** Liest den Kopf. buf = die ersten Bytes der Datei. Wirft HelixError('BAD_REPLAY') bei fremden/kaputten Dateien. */
function parseReplayHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) throw new HelixError('BAD_REPLAY', 'Keine Replay-Datei.');
  let o = 0;
  const need = (n) => { if (o + n > buf.length) throw new HelixError('BAD_REPLAY', 'Replay-Kopf ist unvollständig.'); };
  const u32 = () => { need(4); const v = buf.readUInt32LE(o); o += 4; return v; };
  const i32 = () => { need(4); const v = buf.readInt32LE(o); o += 4; return v; };
  const fstr = () => {
    const n = i32();
    if (n === 0) return '';
    if (Math.abs(n) > 4096) throw new HelixError('BAD_REPLAY', 'Replay-Name ist ungültig.');
    const bytes = n < 0 ? -2 * n : n;
    need(bytes);
    const s = n < 0 ? buf.toString('utf16le', o, o + bytes) : buf.toString('latin1', o, o + bytes);
    o += bytes;
    return s.replace(/\0+$/, '').replace(/\0/g, '').trim();
  };

  if (u32() !== REPLAY_MAGIC) throw new HelixError('BAD_REPLAY', 'Keine Fortnite-Replay-Datei.');
  const fileVersion = u32();
  if (fileVersion > 64) throw new HelixError('BAD_REPLAY', 'Unbekannte Replay-Version.');
  if (fileVersion >= 7) {
    const count = i32();
    if (count < 0 || count > 1000) throw new HelixError('BAD_REPLAY', 'Replay-Kopf ist ungültig.');
    need(count * 20);
    o += count * 20; // je FGuid (16) + int32
  }
  const lengthMs = Math.max(0, i32());
  const networkVersion = u32();
  const changelist = u32();
  const friendlyName = fstr();
  const isLive = u32() !== 0;
  const r = { fileVersion, lengthMs, networkVersion, changelist, friendlyName, isLive, ticks: null, timestampUtcMs: null, compressed: null, encrypted: null };
  if (fileVersion >= 3) {
    need(8);
    const t = buf.readBigInt64LE(o);
    o += 8;
    r.ticks = t.toString();
    if (t > TICKS_UNIX_EPOCH) r.timestampUtcMs = Number((t - TICKS_UNIX_EPOCH) / 10000n);
  }
  if (fileVersion >= 2) r.compressed = u32() !== 0;
  if (fileVersion >= 6) {
    r.encrypted = u32() !== 0;
    const keyLen = i32();
    if (keyLen < 0 || keyLen > 1024) throw new HelixError('BAD_REPLAY', 'Replay-Kopf ist ungültig.');
    need(keyLen);
    o += keyLen; // Schlüssel wird übersprungen, nie gelesen oder gespeichert
  }
  r.firstChunkOffset = o;
  r.branch = findBranch(buf, o);
  r.version = versionFromBranch(r.branch);
  return r;
}

/**
 * Sucht im ersten Abschnitt (Header-Chunk, unverschlüsselt) nach "++Fortnite+Release-xx.yy".
 * Liest nur innerhalb der vorhandenen Bytes.
 */
function findBranch(buf, offset) {
  try {
    if (offset + 8 > buf.length) return null;
    const type = buf.readUInt32LE(offset);
    const size = buf.readInt32LE(offset + 4);
    if (type !== 0 || size <= 4) return null;
    const start = offset + 8;
    const end = Math.min(buf.length, start + size);
    if (start + 4 > end || buf.readUInt32LE(start) !== HEADER_CHUNK_MAGIC) return null;
    const idx = buf.indexOf(BRANCH_MARK, start, 'latin1');
    if (idx < 0 || idx >= end) return null;
    let stop = idx;
    while (stop < end && stop - idx < 80 && buf[stop] !== 0 && buf[stop] >= 0x20 && buf[stop] < 0x7f) stop++;
    return buf.toString('latin1', idx, stop);
  } catch {
    return null;
  }
}

function versionFromBranch(branch) {
  const m = /Release-(\d+(?:\.\d+)*)/.exec(String(branch || ''));
  return m ? m[1] : null;
}

/** Vergleicht Versionen wie "42.20" und "41.4". */
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Ob der Zeitstempel im Kopf als UTC oder als Ortszeit gespeichert ist, ist nicht sicher belegt.
 * Wir nehmen die Deutung, die am besten zur Änderungszeit der Datei passt (Ende der Aufnahme).
 */
function resolveRecordedAt({ timestampUtcMs, mtimeMs, lengthMs = 0, nameMs = null }) {
  const expectedStart = Number.isFinite(mtimeMs) ? mtimeMs - (lengthMs || 0) : null;
  if (Number.isFinite(timestampUtcMs) && timestampUtcMs > Date.UTC(2017, 0, 1)) {
    const asUtc = timestampUtcMs;
    const offsetMin = new Date(asUtc).getTimezoneOffset();
    const asLocal = asUtc + offsetMin * 60000;
    if (expectedStart == null || asLocal === asUtc) return asUtc;
    const dU = Math.abs(asUtc - expectedStart);
    const dL = Math.abs(asLocal - expectedStart);
    if (Math.min(dU, dL) > 36 * 3600 * 1000) return asUtc;
    return dL < dU ? asLocal : asUtc;
  }
  if (Number.isFinite(nameMs)) return nameMs;
  return Number.isFinite(expectedStart) ? expectedStart : null;
}

/** "UnsavedReplay-2018.10.17-20.22.26.replay" -> Zeit (Ortszeit) oder null */
function timeFromFileName(name) {
  const m = /(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/.exec(String(name || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

/** Wird die Datei gerade noch geschrieben? (bIsLive und vor weniger als 2 Minuten geändert) */
function isRecording({ isLive, mtimeMs, now = Date.now(), parsed = true }) {
  const fresh = Number.isFinite(mtimeMs) && now - mtimeMs < RECORDING_WINDOW_MS;
  if (!parsed) return fresh; // Kopf noch nicht lesbar und gerade geändert: wird wohl angelegt
  return !!isLive && fresh;
}

/** Nur ein einfacher Dateiname mit .replay – kein Pfad, keine Tricks. */
function checkReplayFileName(name) {
  const s = String(name ?? '');
  if (!s || s.length > 200 || /[\\/:*?"<>|\u0000-\u001f]/.test(s) || s === '.' || s === '..' || /[. ]$/.test(s)) {
    throw new HelixError('BAD_PATH', 'Ungültiger Dateiname.');
  }
  if (!/\.replay$/i.test(s)) throw new HelixError('BAD_PATH', 'Das ist keine Replay-Datei.');
  return s;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Macht aus einer Eingabe einen sicheren Dateinamen (ohne Endung). */
function cleanReplayName(name) {
  let n = String(name ?? '').replace(/\.replay$/i, '');
  n = n.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!n) throw new HelixError('BAD_NAME', 'Bitte gib einen Namen ein.');
  if (n.length > 80) throw new HelixError('BAD_NAME', 'Der Name darf höchstens 80 Zeichen haben.');
  if (RESERVED.test(n)) throw new HelixError('BAD_NAME', 'Diesen Namen erlaubt Windows nicht. Bitte wähle einen anderen.');
  return n;
}

/** Erkennt dieselbe Aufnahme auch nach dem Umbenennen. */
function replayKey(e) {
  if (e.ticks && e.ticks !== '0') return `${e.ticks}|${e.lengthMs}|${e.size}`;
  return `${String(e.file).toLowerCase()}|${e.size}`;
}

/** Liegt der Ordner im Fortnite-Bereich oder an einer unerlaubten Stelle? */
function vaultProblem(dir, { savedDir = null } = {}) {
  if (!dir || !path.isAbsolute(dir)) return 'Bitte wähle einen festen Ordner aus.';
  const r = path.resolve(dir);
  if (path.parse(r).root === r) return 'Bitte wähle nicht die ganze Festplatte, sondern einen Ordner darauf.';
  const segs = r.split(/[\\/]+/).map((s) => s.toLowerCase());
  if (savedDir) {
    const rel = path.relative(path.resolve(savedDir), r);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return 'Der Tresor darf nicht im Fortnite-Ordner liegen – dort könnte Fortnite die Dateien löschen.';
  }
  if (segs.some((s) => ['fortnitegame', 'epicgameslauncher', 'epic games', 'easyanticheat', 'easyanticheat_eos', 'battleye'].includes(s))) {
    return 'Bitte wähle einen Ordner außerhalb von Fortnite und Epic Games.';
  }
  return null;
}

/** Liest Kopf + Dateiinfos eines Replays (nur die ersten 64 KB). */
async function readReplayEntry(dir, file, { now = Date.now(), fs = fsp } = {}) {
  const abs = path.join(dir, file);
  const st = await fs.lstat(abs);
  if (st.isSymbolicLink() || !st.isFile()) return null;
  const entry = {
    file,
    size: st.size,
    mtimeMs: Math.round(st.mtimeMs),
    lengthMs: 0,
    friendlyName: '',
    isLive: false,
    ticks: null,
    recordedAt: null,
    version: null,
    changelist: null,
    fileVersion: null,
    encrypted: null,
    ok: false,
    error: null,
  };
  let fh;
  try {
    fh = await fs.open(abs, 'r');
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const info = parseReplayHeader(buf.subarray(0, bytesRead));
    Object.assign(entry, {
      lengthMs: info.lengthMs,
      friendlyName: info.friendlyName,
      isLive: info.isLive,
      ticks: info.ticks,
      version: info.version,
      changelist: info.changelist,
      fileVersion: info.fileVersion,
      encrypted: info.encrypted,
      ok: true,
    });
    entry.recordedAt = resolveRecordedAt({ timestampUtcMs: info.timestampUtcMs, mtimeMs: entry.mtimeMs, lengthMs: info.lengthMs, nameMs: timeFromFileName(file) });
  } catch (e) {
    entry.error = e.code === 'BAD_REPLAY' ? e.message : 'Datei konnte nicht gelesen werden.';
    entry.recordedAt = timeFromFileName(file) ?? entry.mtimeMs;
  } finally {
    await fh?.close().catch(() => {});
  }
  entry.recording = isRecording({ isLive: entry.isLive, mtimeMs: entry.mtimeMs, now, parsed: entry.ok });
  entry.incomplete = entry.ok && entry.isLive && !entry.recording;
  return entry;
}

/** Listet alle *.replay direkt in einem Ordner (ohne Unterordner, ohne Verknüpfungen). */
async function listReplays(dir, { max = 2000, now = Date.now(), fs = fsp } = {}) {
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { found: false, entries: [] };
    throw e;
  }
  const entries = [];
  for (const ent of ents) {
    if (entries.length >= max) break;
    // Nicht auf den Dirent-Typ verlassen: Windows meldet OneDrive-Dateien (z. B. in "Dokumente")
    // als Verknüpfung. readReplayEntry prüft mit lstat, ob es eine echte Datei ist.
    if (ent.isDirectory() || !/\.replay$/i.test(ent.name)) continue;
    try {
      const e = await readReplayEntry(dir, ent.name, { now, fs });
      if (e) entries.push(e);
    } catch { /* Datei verschwunden – egal */ }
  }
  entries.sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0));
  return { found: true, entries };
}

/** Freier Name im Zielordner: "Name.replay", sonst "Name (2).replay" … */
async function uniqueTarget(dir, file, fs = fsp) {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? file : `${base} (${i})${ext}`;
    try { await fs.lstat(path.join(dir, name)); } catch (e) { if (e.code === 'ENOENT') return name; throw e; }
  }
  throw new HelixError('NAME_TAKEN', 'Es gibt schon zu viele Dateien mit diesem Namen.');
}

/**
 * Kopiert sicher: erst in eine Hilfsdatei, dann umbenennen. Änderungszeit bleibt erhalten.
 * Gibt den endgültigen Dateinamen zurück.
 */
async function safeCopy(srcAbs, destDir, file, fs = fsp) {
  try {
    await fs.mkdir(destDir, { recursive: true });
  } catch (e) {
    throw new HelixError('FOLDER_MISSING', `Der Zielordner ist nicht erreichbar (${e.code || 'Fehler'}). Ist das Laufwerk angeschlossen?`);
  }
  const st = await fs.stat(srcAbs);
  if (typeof fs.statfs === 'function') {
    try {
      const sf = await fs.statfs(destDir);
      if (Number(sf.bavail) * Number(sf.bsize) < st.size + 16 * 1024 * 1024) {
        throw new HelixError('NO_SPACE', 'Auf dem Laufwerk ist nicht genug Platz frei.');
      }
    } catch (e) { if (e.code === 'NO_SPACE') throw e; }
  }
  const name = await uniqueTarget(destDir, file, fs);
  const dest = path.join(destDir, name);
  const tmp = `${dest}.helix-tmp`;
  try {
    await fs.copyFile(srcAbs, tmp);
    await fs.utimes(tmp, st.atime, st.mtime).catch(() => {});
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (e.code === 'ENOSPC') throw new HelixError('NO_SPACE', 'Auf dem Laufwerk ist nicht genug Platz frei.');
    throw new HelixError('COPY_FAILED', `Kopieren hat nicht geklappt (${e.code || 'Fehler'}).`);
  }
  return name;
}

/** Text fürs Cockpit. */
function summaryText(count) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count === 1 ? '1 Replay im Tresor' : `${count} Replays im Tresor`;
}

module.exports = {
  REPLAY_MAGIC,
  HEADER_CHUNK_MAGIC,
  HEAD_BYTES,
  RECORDING_WINDOW_MS,
  parseReplayHeader,
  findBranch,
  versionFromBranch,
  compareVersions,
  resolveRecordedAt,
  timeFromFileName,
  isRecording,
  checkReplayFileName,
  cleanReplayName,
  replayKey,
  vaultProblem,
  readReplayEntry,
  listReplays,
  uniqueTarget,
  safeCopy,
  summaryText,
};
