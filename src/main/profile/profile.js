'use strict';
// Profile format (docs/ARCHITECTURE.md §5): normalize/validate (PURE) + save/load/find (fs).
const fs = require('fs');
const path = require('path');
const catalog = require('../catalog');

const FORMAT = 'phoenix-profile';
const VERSION = 1;
const EXT = '.phoenix.json';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+_\-]{0,127}$/;
const MAX_ICON = 64 * 1024;

const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);

function normalizeMachine(m) {
  const src = m && typeof m === 'object' ? m : {};
  const os = src.os && typeof src.os === 'object' ? src.os : {};
  return {
    hostname: str(src.hostname, 64),
    user: str(src.user, 64),
    os: { caption: str(os.caption, 120), version: str(os.version, 40), build: str(os.build, 20), displayVersion: str(os.displayVersion, 20) },
    cpu: str(src.cpu, 120),
    ramGB: num(src.ramGB) || 0,
    gpus: (Array.isArray(src.gpus) ? src.gpus : [])
      .slice(0, 8)
      .map((g) => ({ name: str(g && g.name, 120), vendor: ['nvidia', 'amd', 'intel'].includes(g && g.vendor) ? g.vendor : 'other' }))
      .filter((g) => g.name),
  };
}

function normalizeApp(a) {
  if (!a || typeof a !== 'object') return null;
  const id = str(a.id, 128);
  const source = a.source === 'msstore' ? 'msstore' : 'winget';
  if (!ID_RE.test(id)) return null;
  const out = { id, source, name: catalog.displayName(id, source, str(a.name, 120)) };
  const version = str(a.version, 40);
  if (version) out.version = version;
  const publisher = str(a.publisher, 120);
  if (publisher) out.publisher = publisher;
  const hit = catalog.lookup(id, source);
  const category = str(a.category, 40) || (hit && hit.category) || '';
  if (category) out.category = category;
  if (hit && hit.elevation) out.elevation = hit.elevation;
  else if (['required', 'prohibited', 'none', 'unknown'].includes(a.elevation)) out.elevation = a.elevation;
  if (typeof a.icon === 'string' && a.icon.startsWith('data:image/') && a.icon.length <= MAX_ICON) out.icon = a.icon;
  return out;
}

function normalizeGame(g) {
  if (!g || typeof g !== 'object') return null;
  const platform = ['epic', 'steam'].includes(g.platform) ? g.platform : 'other';
  const title = str(g.title, 160);
  if (!title) return null;
  const out = { platform, title };
  const size = num(g.sizeBytes);
  if (size) out.sizeBytes = size;
  if (platform === 'epic') {
    const appName = str(g.appName, 120);
    if (!/^[A-Za-z0-9_.\-]+$/.test(appName)) return null;
    out.appName = appName;
    const ns = str(g.namespace, 64);
    const item = str(g.catalogItemId, 64);
    if (/^[A-Za-z0-9_\-]+$/.test(ns)) out.namespace = ns;
    if (/^[A-Za-z0-9]+$/.test(item)) out.catalogItemId = item;
  } else if (platform === 'steam') {
    const appId = Math.trunc(Number(g.appId));
    if (!Number.isFinite(appId) || appId <= 0) return null;
    out.appId = appId;
  }
  return out;
}

/** Validates/cleans any profile-like object. Throws a German error if it is not usable. */
function normalize(input) {
  if (!input || typeof input !== 'object') throw new Error('Das ist kein gültiges Phoenix-Profil.');
  if (input.format && input.format !== FORMAT) throw new Error('Das ist kein gültiges Phoenix-Profil.');
  if (input.version && Number(input.version) > VERSION) {
    throw new Error('Dieses Profil stammt aus einer neueren Phoenix-Version. Bitte aktualisiere Phoenix.');
  }
  const seen = new Set();
  const apps = [];
  for (const raw of Array.isArray(input.apps) ? input.apps : []) {
    const app = normalizeApp(raw);
    if (!app) continue;
    const key = `${app.source}:${app.id}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push(app);
  }
  const gameKeys = new Set();
  const games = [];
  for (const raw of Array.isArray(input.games) ? input.games : []) {
    const game = normalizeGame(raw);
    if (!game) continue;
    const key = `${game.platform}:${game.appName || game.appId || game.title}`.toLowerCase();
    if (gameKeys.has(key)) continue;
    gameKeys.add(key);
    games.push(game);
  }
  const unmatched = (Array.isArray(input.unmatched) ? input.unmatched : [])
    .slice(0, 1000)
    .map((u) => {
      const name = str(u && u.name, 160);
      if (!name) return null;
      const out = { name };
      const publisher = str(u.publisher, 120);
      const version = str(u.version, 40);
      if (publisher) out.publisher = publisher;
      if (version) out.version = version;
      return out;
    })
    .filter(Boolean);
  const created = new Date(input.createdAt);
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: Number.isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
    appVersion: str(input.appVersion, 40),
    machine: normalizeMachine(input.machine),
    apps,
    games,
    unmatched,
  };
}

/** True if the parsed JSON looks like the output of `winget export`. */
function isWingetExport(json) {
  return !!(json && typeof json === 'object' && Array.isArray(json.Sources));
}

/** Converts a raw `winget export` document into a profile. */
function fromWingetExport(json) {
  const apps = [];
  for (const src of json.Sources || []) {
    const name = String((src && src.SourceDetails && src.SourceDetails.Name) || 'winget').toLowerCase();
    const source = name === 'msstore' ? 'msstore' : name === 'winget' ? 'winget' : null;
    if (!source) continue;
    for (const pkg of (src && src.Packages) || []) {
      if (pkg && pkg.PackageIdentifier) apps.push({ id: pkg.PackageIdentifier, source, version: pkg.Version });
    }
  }
  return normalize({ createdAt: json.CreationDate || new Date().toISOString(), apps, games: [], unmatched: [] });
}

/** Parses file contents (Phoenix profile or winget export). */
function parseProfileText(text) {
  let json;
  try {
    json = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    throw new Error('Die Datei ist beschädigt oder kein Phoenix-Profil.');
  }
  if (isWingetExport(json)) return fromWingetExport(json);
  return normalize(json);
}

function fileNameFor(profile) {
  const host = (profile.machine && profile.machine.hostname ? profile.machine.hostname : 'PC').replace(/[^A-Za-z0-9_\-]/g, '') || 'PC';
  const day = (profile.createdAt || new Date().toISOString()).slice(0, 10);
  return `Phoenix-Profil-${host}-${day}${EXT}`;
}

// ---------------------------------------------------------------- fs part

function writeProfile(profile, dir) {
  const clean = normalize(profile);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileNameFor(clean));
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

/** Save to a directory ('documents' = Documents\Phoenix) or via a save dialog when dir is empty. */
async function saveProfile(profile, { dir, parentWin } = {}) {
  const { app, dialog } = require('electron');
  if (dir === 'documents') return { path: writeProfile(profile, path.join(app.getPath('documents'), 'Phoenix')) };
  if (typeof dir === 'string' && dir) {
    if (!path.isAbsolute(dir)) throw new Error('Ungültiger Speicherort.');
    return { path: writeProfile(profile, dir) };
  }
  const clean = normalize(profile);
  const res = await dialog.showSaveDialog(parentWin || undefined, {
    title: 'Phoenix-Profil speichern',
    defaultPath: path.join(app.getPath('desktop'), fileNameFor(clean)),
    filters: [{ name: 'Phoenix-Profil', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { path: null, canceled: true };
  fs.writeFileSync(res.filePath, JSON.stringify(clean, null, 2), 'utf8');
  return { path: res.filePath };
}

/** Writes <root>\Phoenix\<file> and copies the Setup.exe next to it if one can be found. */
async function saveToDrive(profile, root) {
  if (!/^[A-Za-z]:\\?$/.test(root) && !(process.platform !== 'win32' && path.isAbsolute(root))) {
    throw new Error('Ungültiges Laufwerk.');
  }
  const base = /^[A-Za-z]:$/.test(root) ? `${root}\\` : root;
  const dir = path.join(base, 'Phoenix');
  const file = writeProfile(profile, dir);
  let setupCopied = false;
  let setupPath;
  try {
    const { findSetupExe } = require('../util/paths');
    const found = await findSetupExe();
    if (found && found.path) {
      setupPath = path.join(dir, path.basename(found.path));
      if (!fs.existsSync(setupPath) || fs.statSync(setupPath).size !== fs.statSync(found.path).size) {
        fs.copyFileSync(found.path, setupPath);
      }
      setupCopied = true;
    }
  } catch {
    setupCopied = false;
  }
  return { path: file, setupCopied, setupPath };
}

function loadProfile(file) {
  if (!path.isAbsolute(file)) throw new Error('Ungültiger Pfad.');
  const stat = fs.statSync(file);
  if (stat.size > 20 * 1024 * 1024) throw new Error('Die Datei ist zu groß für ein Phoenix-Profil.');
  return parseProfileText(fs.readFileSync(file, 'utf8'));
}

async function openProfileDialog(parentWin) {
  const { app, dialog } = require('electron');
  const res = await dialog.showOpenDialog(parentWin || undefined, {
    title: 'Phoenix-Profil öffnen',
    defaultPath: app.getPath('desktop'),
    properties: ['openFile'],
    filters: [{ name: 'Phoenix-Profil oder winget-Export', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
  return loadProfile(res.filePaths[0]);
}

function summarize(file, location) {
  try {
    const p = loadProfile(file);
    return { path: file, location, createdAt: p.createdAt, hostname: p.machine.hostname, appCount: p.apps.length, gameCount: p.games.length };
  } catch {
    return null;
  }
}

function listProfileFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(EXT))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Searches drive roots, <drive>\Phoenix, Desktop, Downloads, Documents(\Phoenix), OneDrive. Newest first. */
async function findProfiles() {
  const { getSearchLocations } = require('../util/paths');
  const locations = await getSearchLocations();
  const seen = new Set();
  const out = [];
  for (const loc of locations) {
    for (const file of listProfileFiles(loc.dir)) {
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const summary = summarize(file, loc.label);
      if (summary) out.push(summary);
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

module.exports = {
  FORMAT,
  VERSION,
  EXT,
  normalize,
  isWingetExport,
  fromWingetExport,
  parseProfileText,
  fileNameFor,
  writeProfile,
  saveProfile,
  saveToDrive,
  loadProfile,
  openProfileDialog,
  findProfiles,
};
