'use strict';
// Cache-Cleaner – reine Logik (testbar ohne Windows).
// Bereiche, Pfade, Durchsuchen ohne Verknüpfungen zu folgen, sicheres Löschen mit Pfad-Prüfung.
//
// Grundregeln:
// - Pfade kommen nur aus Umgebungsvariablen (LOCALAPPDATA, USERPROFILE, TEMP) und dem gefundenen
//   Fortnite-"Saved"-Ordner. Keine festen Benutzerpfade.
// - Gelöscht werden nur Dateien INNERHALB der Bereichsordner, nie die Ordner selbst.
// - Symbolische Verknüpfungen und Junctions werden nie verfolgt (lstat, Dirent.isSymbolicLink).
// - Vor jedem Löschen: echte Lage des Ordners (realpath) muss im Bereichsordner liegen.
// - Nie: Config, Cloud, Demos, PersistentDownloadDir, Fortnite-Installation, Epic Games Launcher, Anti-Cheat.

const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Ordnernamen, die nie angefasst werden – egal wo sie liegen (Kleinschreibung). */
const FORBIDDEN_SEGMENTS = new Set([
  'epicgameslauncher', 'epic games', 'epic online services', 'eosoverlay',
  'easyanticheat', 'easyanticheat_eos', 'battleye',
]);

/** Innerhalb von FortniteGame\Saved dürfen nur diese Unterordner geleert werden. */
const SAVED_ALLOWED = new Set(['logs', 'crashes']);

/** Temporäre Dateien: nur Einträge direkt in %TEMP%, deren Name so beginnt (vorsichtig gewählt). */
const TEMP_PREFIX_RE = /^(UE4|UE5|UE-|UE_|UECC|UECrash|Unreal|Fortnite|CrashReport)/i;

function isTempEntryName(name) {
  return TEMP_PREFIX_RE.test(String(name || ''));
}

function absBase(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  if (!path.isAbsolute(p)) return null;
  const r = path.resolve(p);
  // Laufwerkswurzel oder "/" ist nie eine gültige Basis
  if (path.parse(r).root === r) return null;
  return r;
}

function segments(p) {
  return String(p).split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
}

/** Echter (langer) Pfad, falls es ihn gibt – sonst der Pfad selbst. */
function realOrSelf(p) {
  try { return fsSync.realpathSync.native(p); } catch { return p; }
}

/** Liegt child innerhalb von parent (nicht gleich)? Unter Windows ohne Groß-/Kleinschreibung. */
function isInside(parent, child, { allowEqual = false } = {}) {
  const rel = path.relative(parent, child);
  if (rel === '') return allowEqual;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Darf dieser Pfad niemals gelöscht werden?
 * savedDir: Fortnite-"Saved"-Ordner (oder null, wenn nicht gefunden).
 */
function isForbiddenPath(abs, { savedDir = null } = {}) {
  const segs = segments(abs);
  if (segs.some((s) => FORBIDDEN_SEGMENTS.has(s))) return true;
  if (savedDir && isInside(savedDir, abs, { allowEqual: true })) {
    const rel = path.relative(savedDir, abs);
    const first = segments(rel)[0];
    return !first || !SAVED_ALLOWED.has(first);
  }
  // Alles mit "FortniteGame" außerhalb von Saved\Logs|Crashes (z. B. die Installation) bleibt tabu.
  if (segs.includes('fortnitegame')) return true;
  return false;
}

/**
 * Baut die Liste der Bereiche aus den Umgebungsvariablen und dem Fortnite-Ordner.
 * Rückgabe: [{ id, group, label, hint, privacy?, roots: [abs], filterTop? }]
 */
function buildCategories(env = {}, location = null) {
  const local = absBase(env.LOCALAPPDATA) || (absBase(env.USERPROFILE) ? path.join(absBase(env.USERPROFILE), 'AppData', 'Local') : null);
  const profile = absBase(env.USERPROFILE);
  const localLow = profile ? path.join(profile, 'AppData', 'LocalLow') : null;
  let temp = absBase(env.TEMP) || absBase(env.TMP) || (local ? path.join(local, 'Temp') : null);
  // Nur einen Temp-Ordner im eigenen Benutzerordner benutzen (nie z. B. C:\Windows\Temp).
  // Windows setzt TEMP oft als Kurznamen (C:\Users\GEORGH~1\…) – dann über die echten Pfade vergleichen.
  const inProfile = (t, p, l) => (p && isInside(p, t)) || (l && isInside(l, t));
  if (temp && !inProfile(temp, profile, local)) {
    const t = realOrSelf(temp);
    temp = inProfile(t, profile && realOrSelf(profile), local && realOrSelf(local)) ? t : null;
  }
  const saved = location && location.found && absBase(location.savedDir) ? path.resolve(location.savedDir) : null;
  // Protokolle/Absturzberichte nur, wenn der Ordner wirklich wie ...\<Fortnite…>\Saved aussieht
  // (schützt vor einem selbst gewählten, fremden Ordner).
  const savedOk = !!saved && path.basename(saved).toLowerCase() === 'saved' && /fortnite/i.test(path.basename(path.dirname(saved)));
  const savedRoot = savedOk ? saved : null;

  const j = (base, ...parts) => (base ? path.join(base, ...parts) : null);
  const list = [
    {
      id: 'directx',
      group: 'shader',
      label: 'DirectX-Shader-Cache',
      hint: 'Von Windows gespeicherte Grafik-Bausteine (Shader). Wird beim nächsten Spielstart neu aufgebaut – das erste Match kann kurz ruckeln.',
      roots: [j(local, 'D3DSCache')],
    },
    {
      id: 'nvidia',
      group: 'shader',
      label: 'NVIDIA-Shader-Cache',
      hint: 'Zwischenspeicher des NVIDIA-Grafiktreibers. Wird neu aufgebaut – das erste Match danach kann kurz ruckeln.',
      roots: [
        j(local, 'NVIDIA', 'DXCache'),
        j(local, 'NVIDIA', 'GLCache'),
        j(local, 'NVIDIA Corporation', 'NV_Cache'),
        j(localLow, 'NVIDIA', 'PerDriverVersion', 'DXCache'),
        j(temp, 'NVIDIA Corporation', 'NV_Cache'),
      ],
    },
    {
      id: 'amd',
      group: 'shader',
      label: 'AMD-Shader-Cache',
      hint: 'Zwischenspeicher des AMD-Grafiktreibers. Wird neu aufgebaut – das erste Match danach kann kurz ruckeln.',
      roots: ['DxCache', 'DxcCache', 'VkCache', 'GLCache', 'OglCache', 'DX9Cache'].map((n) => j(local, 'AMD', n)),
    },
    {
      id: 'intel',
      group: 'shader',
      label: 'Intel-Shader-Cache',
      hint: 'Zwischenspeicher des Intel-Grafiktreibers. Wird neu aufgebaut – das erste Match danach kann kurz ruckeln.',
      roots: [j(localLow, 'Intel', 'ShaderCache'), j(local, 'Intel', 'ShaderCache')],
    },
    {
      id: 'logs',
      group: 'fortnite',
      label: 'Fortnite-Protokolle',
      hint: 'Textdateien, in denen Fortnite mitschreibt, was beim Spielen passiert. Fortnite legt beim nächsten Start neue an.',
      privacy: 'Fortnite legt dort auch einmalige Anmelde-Codes ab. Löschen entfernt sie.',
      roots: [j(savedRoot, 'Logs')],
    },
    {
      id: 'crashes',
      group: 'fortnite',
      label: 'Fortnite-Absturzberichte',
      hint: 'Berichte von früheren Abstürzen. Werden nur für die Fehlersuche gebraucht.',
      privacy: 'Enthalten oft Kopien der Protokolle – also auch dort alte Anmelde-Codes.',
      roots: [j(savedRoot, 'Crashes')],
    },
    {
      id: 'temp',
      group: 'fortnite',
      label: 'Temporäre Fortnite-Dateien',
      hint: 'Reste von Fortnite und der Unreal Engine (das Spiel-Grundgerüst) im Windows-Temp-Ordner. Nur Einträge, deren Name mit UE, Unreal, Fortnite oder CrashReport beginnt.',
      roots: [temp],
      filterTop: isTempEntryName,
    },
  ];

  for (const c of list) {
    const seen = new Set();
    c.roots = c.roots.filter((r) => {
      if (!r) return false;
      const key = r.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return !isForbiddenPath(r, { savedDir: saved });
    });
  }
  return list.filter((c) => c.roots.length);
}

/** Prüft einen Bereichsordner: existiert, ist ein echter Ordner (keine Verknüpfung)? */
async function inspectRoot(root, fs = fsp) {
  try {
    const st = await fs.lstat(root);
    if (st.isSymbolicLink()) return { ok: false, reason: 'link' };
    if (!st.isDirectory()) return { ok: false, reason: 'notdir' };
    const real = await fs.realpath(root);
    return { ok: true, real };
  } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : (e.code || 'error') };
  }
}

/**
 * Durchsucht einen Bereichsordner, ohne Verknüpfungen zu folgen.
 * Rückgabe: { files: [{abs, size, readOnly}], dirs: [abs] (tiefste zuerst), bytes, count, truncated, links, errors }
 */
async function collect(root, { filterTop = null, maxFiles = 200000, maxDepth = 24, fs = fsp } = {}) {
  const files = [];
  const dirs = [];
  let bytes = 0;
  let links = 0;
  let errors = 0;
  let truncated = false;

  async function visit(dir, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      errors++;
      return;
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      if (depth === 0 && filterTop && !filterTop(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) { links++; continue; }
      let st;
      try { st = await fs.lstat(abs); } catch { errors++; continue; }
      if (st.isSymbolicLink()) { links++; continue; }
      if (st.isDirectory()) {
        if (depth >= maxDepth) { truncated = true; continue; }
        await visit(abs, depth + 1);
        dirs.push(abs);
      } else if (st.isFile()) {
        files.push({ abs, size: st.size, readOnly: (st.mode & 0o200) === 0 });
        bytes += st.size;
      }
    }
  }
  await visit(root, 0);
  return { files, dirs, bytes, count: files.length, truncated, links, errors };
}

/**
 * Echter Pfad des Saved-Ordners. Echte Pfade (realpath) werden nur mit ihm verglichen – sonst passt
 * z. B. ein Kurzname (C:\Users\JRGEN~1) oder eine Verknüpfung im Benutzerordner nie zusammen.
 */
async function realSaved(savedDir, fs = fsp) {
  if (!savedDir) return null;
  try { return await fs.realpath(savedDir); } catch { return savedDir; }
}

/**
 * Misst alle Bereiche. Nur Bereiche mit mindestens einem vorhandenen Ordner kommen zurück.
 */
async function scanCategories(categories, { savedDir = null, fs = fsp, maxFiles } = {}) {
  const savedReal = await realSaved(savedDir, fs);
  const out = [];
  for (const c of categories) {
    const roots = [];
    for (const root of c.roots) {
      const info = await inspectRoot(root, fs);
      if (!info.ok) continue;
      if (isForbiddenPath(info.real, { savedDir: savedReal }) || isForbiddenPath(root, { savedDir })) continue;
      const r = await collect(root, { filterTop: c.filterTop, fs, maxFiles });
      roots.push({ path: root, bytes: r.bytes, count: r.count, truncated: r.truncated, links: r.links });
    }
    if (!roots.length) continue;
    out.push({
      id: c.id,
      group: c.group,
      label: c.label,
      hint: c.hint,
      privacy: c.privacy || null,
      roots,
      bytes: roots.reduce((n, r) => n + r.bytes, 0),
      count: roots.reduce((n, r) => n + r.count, 0),
      truncated: roots.some((r) => r.truncated),
    });
  }
  return out;
}

/** Löscht eine Datei, wenn sie wirklich im Bereichsordner liegt. Rückgabe: 'deleted' | 'locked' | 'gone' | 'outside' */
async function deleteInside(abs, rootReal, { savedDir = null, savedReal = savedDir, fs = fsp } = {}) {
  let st;
  try { st = await fs.lstat(abs); } catch (e) { return e.code === 'ENOENT' ? 'gone' : 'locked'; }
  if (st.isSymbolicLink() || !st.isFile()) return 'outside';
  let parentReal;
  try { parentReal = await fs.realpath(path.dirname(abs)); } catch { return 'gone'; }
  if (!isInside(rootReal, parentReal, { allowEqual: true })) return 'outside';
  if (isForbiddenPath(abs, { savedDir }) || isForbiddenPath(path.join(parentReal, path.basename(abs)), { savedDir: savedReal })) return 'outside';
  try {
    await fs.unlink(abs);
    return 'deleted';
  } catch (e) {
    if (e.code === 'ENOENT') return 'gone';
    // Schreibgeschützte Cache-Datei: Schutz kurz aufheben, sonst Schutz wiederherstellen
    if ((e.code === 'EPERM' || e.code === 'EACCES') && (st.mode & 0o200) === 0) {
      try {
        await fs.chmod(abs, 0o666);
        try {
          await fs.unlink(abs);
          return 'deleted';
        } catch {
          await fs.chmod(abs, st.mode & 0o777).catch(() => {});
          return 'locked';
        }
      } catch { return 'locked'; }
    }
    if (LOCK_CODES.has(e.code)) return 'locked';
    return 'locked';
  }
}

/**
 * Leert die gewählten Bereiche. categories = Ergebnis von buildCategories (nicht von außen!).
 * onProgress({ index, total, id, label })
 * Rückgabe: { freedBytes, deleted, skipped, skippedBytes, perCategory: [{id, label, freedBytes, deleted, skipped}] }
 */
async function cleanCategories(categories, { savedDir = null, fs = fsp, onProgress, maxFiles } = {}) {
  const savedReal = await realSaved(savedDir, fs);
  const perCategory = [];
  let index = 0;
  for (const c of categories) {
    onProgress?.({ index, total: categories.length, id: c.id, label: c.label });
    index++;
    const res = { id: c.id, label: c.label, freedBytes: 0, deleted: 0, skipped: 0, skippedBytes: 0 };
    for (const root of c.roots) {
      const info = await inspectRoot(root, fs);
      if (!info.ok) continue;
      if (isForbiddenPath(info.real, { savedDir: savedReal }) || isForbiddenPath(root, { savedDir })) continue;
      const r = await collect(root, { filterTop: c.filterTop, fs, maxFiles });
      for (const f of r.files) {
        const what = await deleteInside(f.abs, info.real, { savedDir, savedReal, fs });
        if (what === 'deleted') { res.deleted++; res.freedBytes += f.size; } else if (what === 'locked') { res.skipped++; res.skippedBytes += f.size; }
      }
      // leere Unterordner entfernen (tiefste zuerst) – nie den Bereichsordner selbst
      for (const d of r.dirs) {
        try {
          const st = await fs.lstat(d);
          if (st.isSymbolicLink() || !st.isDirectory()) continue;
          const real = await fs.realpath(d);
          if (!isInside(info.real, real)) continue;
          await fs.rmdir(d);
        } catch { /* nicht leer oder gesperrt – bleibt */ }
      }
    }
    perCategory.push(res);
  }
  return {
    freedBytes: perCategory.reduce((n, r) => n + r.freedBytes, 0),
    deleted: perCategory.reduce((n, r) => n + r.deleted, 0),
    skipped: perCategory.reduce((n, r) => n + r.skipped, 0),
    skippedBytes: perCategory.reduce((n, r) => n + r.skippedBytes, 0),
    perCategory,
  };
}

/** Bytes auf Deutsch: "2,1 GB", "820 MB" (wie ui.fmtBytes in der Oberfläche). */
function fmtBytesDe(n) {
  if (!Number.isFinite(n)) return '–';
  if (n < 1024) return `${Math.round(n)} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  const s = n < 10 ? (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.round(n));
  return `${s.replace('.', ',')} ${u[i]}`;
}

/** Zeile fürs Cockpit aus der letzten Messung. */
function summaryText(lastScan) {
  if (!lastScan || !Number.isFinite(lastScan.bytes) || lastScan.bytes < 1024 * 1024) return null;
  return `${fmtBytesDe(lastScan.bytes)} können frei werden`;
}

module.exports = {
  FORBIDDEN_SEGMENTS,
  SAVED_ALLOWED,
  isTempEntryName,
  isInside,
  isForbiddenPath,
  buildCategories,
  inspectRoot,
  collect,
  scanCategories,
  deleteInside,
  cleanCategories,
  fmtBytesDe,
  summaryText,
};
