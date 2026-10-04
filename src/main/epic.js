'use strict';
// Konten-Schnellwechsel für den Epic Games Launcher (nur Windows).
//
// Der Launcher merkt sich die Anmeldung ("Angemeldet bleiben") in der Datei
//   %LOCALAPPDATA%\EpicGamesLauncher\Saved\Config\Windows\GameUserSettings.ini
// im Abschnitt [RememberMe]. Der Konto-Retter sichert diesen Abschnitt pro Konto und
// spielt ihn beim Wechsel wieder ein. Danach startet der Launcher mit dem gewählten Konto.
//
// Sicherheit: Es werden keine Passwörter gelesen oder verschickt. Der gesicherte Zugang ist
// vom Launcher selbst an diesen Windows-Benutzer gebunden (DPAPI) und funktioniert nur auf
// diesem PC. Gespeichert wird zusätzlich verschlüsselt (Electron safeStorage). Die Oberfläche
// bekommt den Zugang nie zu sehen – nur Name, E-Mail-Adresse und Zeitpunkt.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const nodeCrypto = require('crypto');

const LAUNCHER_EXE = 'EpicGamesLauncher.exe';
const SECTION = 'RememberMe';
const FILE_NAME = 'epic-konten.json';

let dataDir = null;
let crypto = null;        // { isAvailable, encrypt, decrypt } (Electron safeStorage) oder null
let iniOverride = null;   // für Tests: eigene GameUserSettings.ini
let exeOverride = null;   // für Tests
let noProcess = false;    // für Tests: Launcher nicht schließen/starten

function isWindows() {
  return process.platform === 'win32';
}

function ok(message, extra) { return Object.assign({ ok: true, message }, extra || {}); }
function fail(message) { return { ok: false, message }; }

function init(opts) {
  dataDir = opts.dataDir;
  crypto = opts.crypto || null;
  iniOverride = opts.ini || null;
  exeOverride = opts.exe || null;
  noProcess = Boolean(opts.noProcess);
}

function supported() {
  return isWindows() || noProcess;
}

function localAppData() {
  return process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
}

function settingsFile() {
  return iniOverride || path.join(localAppData(), 'EpicGamesLauncher', 'Saved', 'Config', 'Windows', 'GameUserSettings.ini');
}

function profilesFile() {
  return path.join(dataDir, FILE_NAME);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeout || 15000, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
    });
  });
}

function exists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

// ---------- INI-Datei lesen und schreiben (Kodierung und Zeilenenden bleiben erhalten) ----------

function readIni(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), enc: 'utf16le', bom: true };
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), enc: 'utf8', bom: true };
  return { text: buf.toString('utf8'), enc: 'utf8', bom: false };
}

function writeIni(file, ini, text) {
  let out;
  if (ini.enc === 'utf16le') out = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  else out = Buffer.concat([ini.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.kr-tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
}

function newlineOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

// Zeilenbereich eines Abschnitts: start = Kopfzeile "[Name]", end = erste Zeile des nächsten Abschnitts
function findSection(lines, name) {
  const head = new RegExp('^\\[' + name + '\\]\\s*$', 'i');
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\[[^\]]+\]\s*$/.test(lines[end])) end++;
  return { start, end };
}

// Inhalt eines Abschnitts (ohne Kopfzeile, ohne Leerzeilen am Rand) oder null
function getSection(text, name) {
  const lines = splitLines(text);
  const r = findSection(lines, name);
  if (!r) return null;
  return trimBlank(lines.slice(r.start + 1, r.end)).join('\n');
}

// Ersetzt den Inhalt eines Abschnitts (oder hängt ihn an). Alles andere bleibt unverändert.
function setSection(text, name, body) {
  const nl = newlineOf(text);
  const lines = splitLines(text);
  const bodyLines = trimBlank(String(body || '').split(/\r?\n/));
  const r = findSection(lines, name);
  let out;
  if (r) {
    const after = lines.slice(r.end);
    out = lines.slice(0, r.start + 1).concat(bodyLines, after.length ? [''] : [], after);
  } else {
    out = trimBlank(lines).concat(['', '[' + name + ']'], bodyLines);
  }
  // Datei endet immer mit genau einem Zeilenumbruch
  return trimBlank(out).join(nl) + nl;
}

function parseKeys(body) {
  const o = {};
  for (const l of String(body || '').split(/\r?\n/)) {
    const m = /^\s*([^=;#[]+?)\s*=\s*(.*?)\s*$/.exec(l);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

// ---------- Was ist gerade im Launcher angemeldet? ----------

function readCurrent() {
  const ini = readIni(settingsFile());
  if (!ini) return { found: false, remembered: false, email: '', data: '', section: '' };
  const body = getSection(ini.text, SECTION);
  if (!body) return { found: true, remembered: false, email: '', data: '', section: '' };
  const k = parseKeys(body);
  const remembered = /^true$/i.test(k.Enable || '') && Boolean(k.Data);
  return { found: true, remembered, email: k.Email || '', data: k.Data || '', section: body };
}

// ---------- Gespeicherte Konten (verschlüsselt) ----------

function encrypted() {
  try { return Boolean(crypto && crypto.isAvailable && crypto.isAvailable()); } catch (_) { return false; }
}

function loadProfiles() {
  let raw;
  try {
    raw = fs.readFileSync(profilesFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const w = JSON.parse(raw);
  if (!w || w.format !== 'konto-retter-epic') throw new Error('Unbekanntes Dateiformat der gespeicherten Konten.');
  let list;
  if (w.enc === 'safeStorage') {
    if (!encrypted()) throw new Error('Die gespeicherten Konten lassen sich auf diesem PC nicht entschlüsseln (z. B. nach einem Wechsel des Windows-Benutzers).');
    list = JSON.parse(crypto.decrypt(Buffer.from(w.data, 'base64')));
  } else {
    list = w.data;
  }
  return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object' && p.id && p.section) : [];
}

function saveProfiles(list) {
  fs.mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(list);
  const w = encrypted()
    ? { format: 'konto-retter-epic', version: 1, enc: 'safeStorage', data: crypto.encrypt(json).toString('base64') }
    : { format: 'konto-retter-epic', version: 1, enc: 'none', data: list };
  const file = profilesFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(w), 'utf8');
  fs.renameSync(tmp, file);
}

function sameLogin(p, cur) {
  return Boolean(cur && cur.data) && parseKeys(p.section).Data === cur.data;
}

// Nur das, was die Oberfläche sehen darf
function publicView(p, cur) {
  return { id: p.id, label: p.label, email: p.email || '', savedAt: p.savedAt || null, lastUsed: p.lastUsed || null, isCurrent: sameLogin(p, cur) };
}

function newId() {
  return nodeCrypto.randomBytes(8).toString('hex');
}

// ---------- Launcher steuern ----------

async function isRunning() {
  if (!isWindows() || noProcess) return false;
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq ' + LAUNCHER_EXE, '/NH', '/FO', 'CSV']);
  return r.code === 0 && r.stdout.toLowerCase().includes(LAUNCHER_EXE.toLowerCase());
}

async function stopLauncher() {
  if (noProcess) return true;
  if (!(await isRunning())) return true;
  await run('taskkill', ['/IM', LAUNCHER_EXE, '/T', '/F']);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (!(await isRunning())) return true;
  }
  return false;
}

async function findExe() {
  if (exeOverride) return exeOverride;
  if (!isWindows()) return null;
  // 1. Über das Protokoll "com.epicgames.launcher://" (so startet Windows den Launcher selbst)
  const r = await run('reg', ['query', 'HKCR\\com.epicgames.launcher\\shell\\open\\command', '/ve']);
  const m = /"([^"]+EpicGamesLauncher\.exe)"/i.exec(r.stdout || '');
  if (m && exists(m[1])) return m[1];
  // 2. Übliche Installationsordner
  const cands = [];
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean)) {
    cands.push(path.join(base, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', LAUNCHER_EXE));
    cands.push(path.join(base, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win32', LAUNCHER_EXE));
  }
  for (const d of ['C', 'D', 'E', 'F']) cands.push(d + ':\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\' + LAUNCHER_EXE);
  return cands.find(exists) || null;
}

function startLauncher(exe) {
  if (noProcess || !exe) return;
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
  child.unref();
}

// ---------- Öffentliche Funktionen ----------

async function getStatus() {
  const sup = supported();
  let cur = { found: false, remembered: false, email: '' };
  let problem = null;
  let accounts = [];
  let exe = null;
  if (sup) {
    try { cur = readCurrent(); } catch (err) { problem = 'Die Launcher-Einstellungen konnten nicht gelesen werden: ' + err.message; }
    try { accounts = loadProfiles(); } catch (err) { problem = err.message; }
    exe = await findExe();
  }
  return {
    supported: sup,
    launcherInstalled: Boolean(exe) || cur.found,
    running: sup ? await isRunning() : false,
    settingsFound: cur.found,
    remembered: Boolean(cur.remembered),
    currentEmail: cur.email || '',
    encrypted: encrypted(),
    problem,
    accounts: accounts.map((p) => publicView(p, cur)),
  };
}

const NOT_FOUND = 'Die Einstellungen des Epic Games Launchers wurden nicht gefunden. Ist der Launcher installiert und wurde er schon einmal gestartet?';

async function saveCurrent(label) {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  const cur = readCurrent();
  if (!cur.found) return fail(NOT_FOUND);
  if (!cur.remembered) return fail('Im Launcher ist gerade niemand mit "Angemeldet bleiben" angemeldet. Starte den Launcher, melde dich an und setz den Haken bei "Angemeldet bleiben". Dann hier speichern.');
  const list = loadProfiles();
  const name = String(label || '').trim() || cur.email || 'Epic-Konto ' + (list.length + 1);
  const now = new Date().toISOString();
  const existing = list.find((p) => sameLogin(p, cur))
    || (cur.email ? list.find((p) => p.email && p.email.toLowerCase() === cur.email.toLowerCase()) : null);
  if (existing) {
    existing.section = cur.section;
    existing.email = cur.email || existing.email;
    existing.savedAt = now;
    if (String(label || '').trim()) existing.label = name;
    saveProfiles(list);
    return ok('"' + existing.label + '" wurde aktualisiert.', { id: existing.id });
  }
  const p = { id: newId(), label: name, email: cur.email || '', savedAt: now, lastUsed: null, section: cur.section };
  list.push(p);
  saveProfiles(list);
  return ok('"' + name + '" wurde gespeichert.', { id: p.id });
}

async function switchTo(id) {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  const list = loadProfiles();
  const p = list.find((x) => x.id === id);
  if (!p) return fail('Dieses Konto ist nicht mehr gespeichert.');
  const exe = await findExe();
  if (!exe && !noProcess) return fail('Der Epic Games Launcher wurde auf diesem PC nicht gefunden.');
  const file = settingsFile();
  if (!readIni(file)) return fail(NOT_FOUND);

  // Das bisher angemeldete Konto nicht verlieren: automatisch mitsichern
  const cur = readCurrent();
  let kept = null;
  if (cur.remembered && !list.some((x) => sameLogin(x, cur))) {
    kept = { id: newId(), label: cur.email || 'Vorheriges Konto', email: cur.email || '', savedAt: new Date().toISOString(), lastUsed: null, section: cur.section };
    list.push(kept);
  }

  const closed = await stopLauncher();
  if (!closed) return fail('Der Launcher ließ sich nicht schließen. Bitte schließ ihn von Hand (auch unten rechts im Infobereich) und versuch es nochmal.');

  // Erst nach dem Schließen schreiben: Der Launcher speichert die Datei beim Beenden selbst noch einmal
  const ini = readIni(file);
  if (!ini) return fail(NOT_FOUND);
  writeIni(file, ini, setSection(ini.text, SECTION, p.section));
  p.lastUsed = new Date().toISOString();
  saveProfiles(list);
  startLauncher(exe);
  return ok('Der Launcher startet jetzt mit "' + p.label + '".' + (kept ? ' Dein bisheriges Konto wurde als "' + kept.label + '" mitgesichert.' : ''), { id: p.id });
}

async function remove(id) {
  const list = loadProfiles();
  const p = list.find((x) => x.id === id);
  if (!p) return fail('Dieses Konto ist nicht mehr gespeichert.');
  saveProfiles(list.filter((x) => x.id !== id));
  return ok('"' + p.label + '" wurde entfernt. Im Launcher ändert sich dadurch nichts.');
}

async function rename(id, label) {
  const name = String(label || '').trim();
  if (!name) return fail('Bitte einen Namen eingeben.');
  const list = loadProfiles();
  const p = list.find((x) => x.id === id);
  if (!p) return fail('Dieses Konto ist nicht mehr gespeichert.');
  p.label = name.slice(0, 60);
  saveProfiles(list);
  return ok('Umbenannt in "' + p.label + '".');
}

// Für "Alle Daten löschen"
function removeAll() {
  try { fs.unlinkSync(profilesFile()); } catch (_) { /* nicht vorhanden */ }
}

module.exports = {
  init, getStatus, saveCurrent, switchTo, remove, rename, removeAll,
  // für Tests
  _ini: { readIni, writeIni, getSection, setSection, parseKeys },
};
