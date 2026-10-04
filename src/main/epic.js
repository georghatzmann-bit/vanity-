'use strict';
// Konten-Schnellwechsel für den Epic Games Launcher (nur Windows).
//
// Der Launcher merkt sich die Anmeldung ("Angemeldet bleiben") im Abschnitt [RememberMe] der Datei
//   %LOCALAPPDATA%\EpicGamesLauncher\Saved\Config\WindowsEditor\GameUserSettings.ini   (ab Launcher 19, Nov. 2025)
//   %LOCALAPPDATA%\EpicGamesLauncher\Saved\Config\Windows\GameUserSettings.ini         (ältere Launcher)
// und die Konto-ID unter HKCU\Software\Epic Games\Unreal Engine\Identifiers (Wert AccountId).
// Der Konto-Retter sichert beides pro Konto und spielt es beim Wechsel wieder ein – so macht es
// auch der TcNo Account Switcher. Danach startet der Launcher neu.
//
// Wichtig: "Abmelden" im Launcher macht den gespeicherten Zugang auf Epic-Seite ungültig.
// Für ein weiteres Konto deshalb addNew() benutzen: Das leert nur die lokale Anmeldung.
//
// Sicherheit: Es werden keine Passwörter gelesen oder verschickt. Der gesicherte Zugang ist
// vom Launcher selbst verschlüsselt und funktioniert nur auf diesem PC. Gespeichert wird zusätzlich
// verschlüsselt (Electron safeStorage). Die Oberfläche bekommt den Zugang nie zu sehen.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const nodeCrypto = require('crypto');

const LAUNCHER_EXE = 'EpicGamesLauncher.exe';
// Hilfsprogramme des Launchers, die nach dem Beenden manchmal weiterlaufen und die Anmeldung festhalten
const HELPER_EXES = ['EpicWebHelper.exe', 'UnrealCEFSubProcess.exe', 'EpicOnlineServicesUserHelper.exe', 'EOSOverlayRenderer-Win64-Shipping.exe'];
const SECTION = 'RememberMe';
const SETTINGS_NAME = 'GameUserSettings.ini';
const FILE_NAME = 'epic-konten.json';
const REG_KEY = 'HKCU\\Software\\Epic Games\\Unreal Engine\\Identifiers';
const REG_VALUE = 'AccountId';
const RE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const EMPTY_LOGIN = 'Enable=True\nData=';

let dataDir = null;
let crypto = null;        // { isAvailable, encrypt, decrypt } (Electron safeStorage) oder null
let iniOverride = null;   // für Tests: eigene GameUserSettings.ini
let exeOverride = null;   // für Tests
let noProcess = false;    // für Tests: Launcher nicht suchen/beenden
let registry = null;      // { get(): Promise<string|null>, set(v): Promise<boolean>, del(): Promise<boolean> }
let launchOverride = null; // für Tests: async (exe) => '' oder Fehlermeldung
let openFallback = null;  // Electron shell.openPath: startet über Windows selbst (auch mit Administrator-Abfrage)
let writeHook = null;     // für Tests: simuliert Schreibfehler

function isWindows() {
  return process.platform === 'win32';
}

function ok(message, extra) { return Object.assign({ ok: true, message }, extra || {}); }
function fail(message, extra) { return Object.assign({ ok: false, message }, extra || {}); }

function init(opts) {
  dataDir = opts.dataDir;
  crypto = opts.crypto || null;
  iniOverride = opts.ini || null;
  exeOverride = opts.exe || null;
  noProcess = Boolean(opts.noProcess);
  launchOverride = opts.launch || null;
  openFallback = opts.openFallback || null;
  writeHook = null;
  if (opts.registry) registry = opts.registry;
  else if (opts.noProcess) registry = memoryRegistry();
  else if (isWindows()) registry = regExeRegistry(opts.regKey || REG_KEY);
  else registry = null;
}

function supported() {
  return isWindows() || noProcess;
}

function localAppData() {
  return process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
}

function savedDir() {
  return path.join(localAppData(), 'EpicGamesLauncher', 'Saved');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; }
}

// ---------- Registry (Konto-ID des zuletzt angemeldeten Kontos) ----------

function regExeRegistry(key) {
  return {
    async get() {
      const r = await run('reg', ['query', key, '/v', REG_VALUE]);
      const m = new RegExp(REG_VALUE + '\\s+REG_SZ\\s+(\\S+)', 'i').exec(r.stdout || '');
      return m ? m[1].trim() : null;
    },
    async set(value) {
      const r = await run('reg', ['add', key, '/v', REG_VALUE, '/t', 'REG_SZ', '/d', String(value), '/f']);
      return r.code === 0;
    },
    async del() {
      // Fehlt der Wert schon, meldet reg einen Fehler – das ist in Ordnung
      await run('reg', ['delete', key, '/v', REG_VALUE, '/f']);
      return true;
    },
  };
}

function memoryRegistry() {
  let value = null;
  return {
    async get() { return value; },
    async set(v) { value = v; return true; },
    async del() { value = null; return true; },
  };
}

async function registryAccountId() {
  if (!registry) return null;
  try {
    const v = await registry.get();
    return v && RE_ACCOUNT_ID.test(v) ? v.toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// Stellt die Konto-ID des Ziels ein. Hat das Ziel keine, wird der Wert gelöscht, damit nie die ID
// eines anderen Kontos stehen bleibt (der Launcher schreibt sie beim Anmelden selbst neu).
async function applyRegistry(accountId) {
  if (!registry) return;
  try {
    if (accountId) await registry.set(accountId);
    else if (registry.del) await registry.del();
  } catch (_) { /* nur Hilfe für den Launcher */ }
}

// Nur als Hinweis (Anzeige, Vorschlag für den Namen), nie zum Zuordnen: Der Launcher legt pro
// angemeldetem Konto Saved\Data\<Konto-ID>.dat an (manchmal mit "OC_" davor).
function dataFolderAccountId() {
  if (iniOverride) return null;
  const dir = path.join(savedDir(), 'Data');
  let best = null;
  try {
    for (const n of fs.readdirSync(dir)) {
      const m = /^(?:OC_)?([0-9a-f]{32})\.dat$/i.exec(n);
      if (!m) continue;
      const t = mtimeOf(path.join(dir, n));
      if (!best || t > best.t) best = { id: m[1].toLowerCase(), t };
    }
  } catch (_) { /* Ordner fehlt */ }
  return best ? best.id : null;
}

// ---------- Einstellungsdateien des Launchers ----------

function configDir() {
  return path.join(savedDir(), 'Config');
}

// Alle GameUserSettings.ini unter Saved\Config\<Ordner>\ (für Diagnose und zum Aufräumen alter Kopien).
// Reihenfolge: WindowsEditor (aktueller Launcher), Windows (älterer Launcher), dann alle anderen.
function allLoginFiles() {
  if (iniOverride) return exists(iniOverride) ? [iniOverride] : [];
  let dirs = [];
  try { dirs = fs.readdirSync(configDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { return []; }
  const rank = (d) => (d === 'WindowsEditor' ? 0 : d === 'Windows' ? 1 : 2);
  dirs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return dirs.map((d) => path.join(configDir(), d, SETTINGS_NAME)).filter(exists);
}

// Die Datei, die der installierte Launcher liest: WindowsEditor, sobald es den Ordner gibt (Launcher 19+),
// sonst Windows. Nur diese zählt – Kopien in anderen Ordnern werden ignoriert.
function launcherFile() {
  if (iniOverride) return iniOverride;
  const editor = path.join(configDir(), 'WindowsEditor', SETTINGS_NAME);
  const legacy = path.join(configDir(), 'Windows', SETTINGS_NAME);
  if (exists(path.dirname(editor))) return editor;
  if (exists(path.dirname(legacy))) return legacy;
  return allLoginFiles()[0] || editor;
}

// Launcher-Version aus dem Anfang der Logdatei (nur für die Diagnose)
function launcherVersion() {
  try {
    const fd = fs.openSync(path.join(savedDir(), 'Logs', 'EpicGamesLauncher.log'), 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('utf8');
    const m = /Build:\s*(\S+)/.exec(head) || /Version:\s*([^\r\n]{1,80})/.exec(head);
    return m ? m[1].trim().slice(0, 80) : '';
  } catch (_) {
    return '';
  }
}

function profilesFile() {
  return path.join(dataDir, FILE_NAME);
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
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), enc: 'utf16le', bom: true, raw: buf };
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), enc: 'utf8', bom: true, raw: buf };
  return { text: buf.toString('utf8'), enc: 'utf8', bom: false, raw: buf };
}

// Ersetzt eine Datei atomar. Hält ein anderes Programm (Virenscanner, Launcher-Rest) sie kurz fest,
// wird bis zu ~2 Sekunden erneut versucht.
function replaceFile(file, bytes) {
  if (writeHook) writeHook(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.kr-tmp';
  fs.writeFileSync(tmp, bytes);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i < 10 && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        sleepSync(200);
        continue;
      }
      try { fs.unlinkSync(tmp); } catch (_) { /* schon weg */ }
      throw err;
    }
  }
}

function writeIni(file, ini, text) {
  let out;
  if (ini.enc === 'utf16le') out = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  else out = Buffer.concat([ini.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
  replaceFile(file, out);
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

// Schreibt die Anmeldung in die Datei des Launchers und leert alte Kopien in anderen Ordnern
// (damit kein überflüssiger Zugang auf der Platte liegt). Geht dabei etwas schief, werden alle
// schon geänderten Dateien wiederhergestellt.
function writeLogin(body) {
  const target = launcherFile();
  const plan = [{ file: target, body }];
  for (const f of allLoginFiles()) {
    if (f === target) continue;
    const ini = readIni(f);
    const sec = ini ? getSection(ini.text, SECTION) : null;
    if (sec !== null && parseKeys(sec).Data) plan.push({ file: f, body: 'Enable=False\nData=' });
  }
  const done = [];
  try {
    for (const step of plan) {
      const ini = readIni(step.file);
      if (!ini) continue;
      writeIni(step.file, ini, setSection(ini.text, SECTION, step.body));
      done.push({ file: step.file, raw: ini.raw });
    }
  } catch (err) {
    for (const d of done.reverse()) {
      try { replaceFile(d.file, d.raw); } catch (_) { /* nichts mehr zu machen */ }
    }
    const e = new Error('Die Launcher-Einstellungen konnten nicht geschrieben werden (' + (err.code || err.message) + '). Es wurde nichts verändert.');
    e.userMessage = e.message;
    throw e;
  }
}

// ---------- Was ist gerade im Launcher angemeldet? ----------

function readLoginFile(file) {
  const ini = readIni(file);
  if (!ini) return null;
  const body = getSection(ini.text, SECTION);
  if (body === null) return { file, sectionFound: false, enable: '', data: '', email: '', section: '', remembered: false, mtime: mtimeOf(file) };
  const k = parseKeys(body);
  const data = k.Data || '';
  // "Angemeldet bleiben" gilt, sobald ein Zugang (Data) da ist und Enable nicht ausdrücklich auf False steht
  const remembered = data.length > 0 && !/^false$/i.test(k.Enable || '');
  return { file, sectionFound: true, enable: k.Enable || '', data, email: k.Email || '', section: body, remembered, mtime: mtimeOf(file) };
}

async function readCurrent() {
  const file = launcherFile();
  const r = readLoginFile(file);
  const accountId = await registryAccountId();
  const others = allLoginFiles().filter((f) => f !== file).map(readLoginFile).filter(Boolean);
  const files = (r ? [r] : []).concat(others);
  const hint = accountId || dataFolderAccountId();
  if (!r) {
    return { found: false, file, sectionFound: false, enable: '', dataLength: 0, remembered: false, email: '', data: '', section: '', accountId, accountIdHint: hint, files };
  }
  return {
    found: true,
    file,
    sectionFound: r.sectionFound,
    enable: r.enable,
    dataLength: r.data.length,
    remembered: r.remembered,
    email: r.email,
    data: r.data,
    section: r.section,
    accountId,
    accountIdHint: hint,
    files,
  };
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
  return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object' && p.id && typeof p.section === 'string') : [];
}

function saveProfiles(list) {
  fs.mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(list);
  const w = encrypted()
    ? { format: 'konto-retter-epic', version: 1, enc: 'safeStorage', data: crypto.encrypt(json).toString('base64') }
    : { format: 'konto-retter-epic', version: 1, enc: 'none', data: list };
  replaceFile(profilesFile(), Buffer.from(JSON.stringify(w), 'utf8'));
}

function profileData(p) {
  return parseKeys(p.section).Data || '';
}

function sameEmail(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

// Welches gespeicherte Konto ist gerade angemeldet? Ergebnis { profile, how } oder null.
// 1. exakt derselbe Zugang, 2. dieselbe Konto-ID (Epic hat den Zugang erneuert), 3. dieselbe E-Mail-Adresse.
// Widersprechen sich E-Mail-Adresse und Konto-ID, wird nichts zugeordnet – lieber ein Eintrag zu viel
// als der Zugang eines Kontos unter dem Namen eines anderen.
function matchProfile(list, cur) {
  if (!cur || !cur.remembered) return null;
  const byData = cur.data ? list.find((p) => profileData(p) === cur.data) : null;
  if (byData) return { profile: byData, how: 'data' };
  if (cur.accountId) {
    const p = list.find((x) => x.accountId === cur.accountId && !(x.email && cur.email && !sameEmail(x.email, cur.email)));
    if (p) return { profile: p, how: 'id' };
  }
  if (cur.email) {
    const p = list.find((x) => x.email && sameEmail(x.email, cur.email) && !(x.accountId && cur.accountId && x.accountId !== cur.accountId));
    if (p) return { profile: p, how: 'email' };
  }
  return null;
}

function shortId(id) {
  return id ? id.slice(0, 8) : '';
}

// Nur das, was die Oberfläche sehen darf (nie den Zugang selbst)
function publicView(p, currentId) {
  return {
    id: p.id,
    label: p.label,
    email: p.email || '',
    accountIdShort: shortId(p.accountId),
    legacy: !p.accountId,
    savedAt: p.savedAt || null,
    lastUsed: p.lastUsed || null,
    isCurrent: p.id === currentId,
  };
}

function newId() {
  return nodeCrypto.randomBytes(8).toString('hex');
}

function defaultLabel(cur, list) {
  if (cur.email) return cur.email;
  if (cur.accountIdHint) return 'Epic-Konto ' + shortId(cur.accountIdHint);
  return 'Epic-Konto ' + (list.length + 1);
}

// Übernimmt die aktuelle Anmeldung in ein vorhandenes Konto.
// Eine gespeicherte Konto-ID wird nur ersetzt, wenn der Nutzer das Konto ausdrücklich gewählt hat.
function applyCurrent(p, cur, how) {
  p.section = cur.section;
  if (cur.email) p.email = cur.email;
  if (cur.accountId && (!p.accountId || how === 'explicit')) p.accountId = cur.accountId;
  p.savedAt = new Date().toISOString();
}

// Aktuelle Anmeldung in die Liste übernehmen: passendes Konto auffrischen oder neu anlegen.
// Gibt { profile, created } zurück. Ändert nur die Liste im Speicher.
function upsertCurrent(list, cur, label) {
  const m = matchProfile(list, cur);
  if (m) {
    applyCurrent(m.profile, cur, m.how);
    if (label) m.profile.label = label.slice(0, 60);
    return { profile: m.profile, created: false };
  }
  const p = {
    id: newId(),
    label: (label || defaultLabel(cur, list)).slice(0, 60),
    email: cur.email || '',
    accountId: cur.accountId || '',
    savedAt: new Date().toISOString(),
    lastUsed: null,
    section: cur.section,
  };
  list.push(p);
  return { profile: p, created: true };
}

// ---------- Launcher steuern ----------

async function isRunning() {
  if (!isWindows() || noProcess) return false;
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq ' + LAUNCHER_EXE, '/NH', '/FO', 'CSV']);
  return r.code === 0 && r.stdout.toLowerCase().includes(LAUNCHER_EXE.toLowerCase());
}

async function waitGone(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!(await isRunning())) return true;
    await sleep(250);
  }
  return !(await isRunning());
}

// Der Launcher reagiert nicht auf "Fenster schließen" (er zieht sich nur in den Infobereich zurück).
// Deshalb sofort hart beenden – genau wie der TcNo Account Switcher. Danach die Hilfsprogramme.
async function stopLauncher() {
  if (noProcess) return true;
  if (await isRunning()) {
    await run('taskkill', ['/IM', LAUNCHER_EXE, '/T', '/F']);
    if (!(await waitGone(10000))) return false;
  }
  for (const exe of HELPER_EXES) await run('taskkill', ['/IM', exe, '/T', '/F'], 8000);
  await sleep(500);
  return true;
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

function spawnDetached(exe) {
  return new Promise((resolve) => {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
      child.once('error', (err) => resolve((err && (err.code || err.message)) || 'unbekannter Fehler'));
      child.once('spawn', () => {
        child.unref();
        resolve('');
      });
    } catch (err) {
      resolve(err.code || err.message);
    }
  });
}

// Startet den Launcher. Ergebnis: '' = gestartet, sonst Fehlerbeschreibung.
// Klappt der direkte Start nicht (z. B. "Als Administrator ausführen" ist eingestellt), startet Windows ihn selbst.
async function startLauncher(exe) {
  const msg = (v) => (v ? String(v) : '');
  if (launchOverride) {
    try { return msg(await launchOverride(exe)); } catch (err) { return err.message; }
  }
  if (noProcess) return '';
  if (!exe) return 'Launcher nicht gefunden';
  const err = await spawnDetached(exe);
  if (!err) return '';
  if (openFallback) {
    try { return msg(await openFallback(exe)); } catch (e) { return e.message; }
  }
  return err;
}

function startedMessage(text, startErr) {
  return startErr
    ? fail(text + ' Der Launcher konnte aber nicht automatisch gestartet werden (' + startErr + '). Starte ihn bitte selbst.', { code: 'start-failed' })
    : ok(text);
}

// ---------- Öffentliche Funktionen ----------

async function getStatus() {
  const sup = supported();
  let cur = { found: false, file: '', sectionFound: false, enable: '', dataLength: 0, remembered: false, email: '', accountId: null, accountIdHint: null, files: [] };
  let problem = null;
  let accounts = [];
  let exe = null;
  if (sup) {
    try { cur = await readCurrent(); } catch (err) { problem = 'Die Launcher-Einstellungen konnten nicht gelesen werden: ' + err.message; }
    try { accounts = loadProfiles(); } catch (err) { problem = err.message; }
    exe = await findExe();
  }
  const running = sup ? await isRunning() : false;
  const m = matchProfile(accounts, cur);
  const currentId = m ? m.profile.id : null;
  return {
    supported: sup,
    launcherInstalled: Boolean(exe) || cur.found,
    running,
    settingsFound: cur.found,
    remembered: Boolean(cur.remembered),
    currentEmail: cur.email || '',
    currentAccountIdShort: shortId(cur.accountIdHint),
    currentMatchId: currentId,
    encrypted: encrypted(),
    problem,
    accounts: accounts.map((p) => publicView(p, currentId)),
    // Was der Konto-Retter auf diesem PC sieht (ohne den Zugang selbst): hilft, wenn etwas nicht klappt
    diag: {
      localAppData: localAppData(),
      file: cur.file || '',
      fileFound: Boolean(cur.found),
      sectionFound: Boolean(cur.sectionFound),
      enable: cur.enable || '',
      dataLength: cur.dataLength || 0,
      email: cur.email || '',
      accountId: cur.accountId || '',
      accountIdHint: cur.accountIdHint || '',
      launcherExe: exe || '',
      launcherVersion: sup && !noProcess ? launcherVersion() : '',
      configFiles: (cur.files || []).map((f) => ({
        file: f.file,
        hasSection: f.sectionFound,
        dataLength: f.data ? f.data.length : 0,
        modified: f.mtime ? new Date(f.mtime).toISOString() : null,
        used: f.file === cur.file,
      })),
    },
  };
}

// Launcher beenden (wird von außen nur noch selten gebraucht)
async function closeLauncher() {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  if (!(await isRunning())) return ok('Der Launcher war schon beendet.');
  const closed = await stopLauncher();
  if (!closed) return fail('Der Launcher ließ sich nicht beenden. Bitte beende ihn von Hand: unten rechts im Infobereich Rechtsklick auf das Epic-Symbol, dann "Beenden".');
  return ok('Der Launcher wurde beendet.');
}

const NOT_FOUND = 'Die Einstellungen des Epic Games Launchers wurden nicht gefunden. Ist der Launcher installiert und wurde er schon einmal gestartet?';
const NOT_CLOSED = 'Der Launcher ließ sich nicht schließen. Bitte schließ ihn von Hand (unten rechts im Infobereich: Rechtsklick auf das Epic-Symbol, "Beenden") und versuch es nochmal.';

// targetId: Der Nutzer hat ausdrücklich gewählt, welchen Eintrag die aktuelle Anmeldung ersetzen soll
// (z. B. einen alten Eintrag, der nicht mehr funktioniert).
async function saveCurrent(label, targetId) {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  const cur = await readCurrent();
  if (!cur.found) return fail(NOT_FOUND);
  if (!cur.remembered) {
    return fail('Im Launcher ist gerade niemand mit "Angemeldet bleiben" angemeldet. Melde dich im Launcher an, setz den Haken bei "Angemeldet bleiben" und speichere dann hier.', { code: 'not-remembered', running: await isRunning() });
  }
  const list = loadProfiles();
  const name = String(label || '').trim();
  if (targetId) {
    const p = list.find((x) => x.id === targetId);
    if (!p) return fail('Dieses Konto ist nicht mehr gespeichert.');
    applyCurrent(p, cur, 'explicit');
    if (name) p.label = name.slice(0, 60);
    saveProfiles(list);
    return ok('"' + p.label + '" wurde mit der aktuellen Anmeldung aktualisiert.', { id: p.id });
  }
  const { profile, created } = upsertCurrent(list, cur, name);
  saveProfiles(list);
  return ok('"' + profile.label + '" wurde ' + (created ? 'gespeichert.' : 'aktualisiert.'), { id: profile.id });
}

async function switchTo(id) {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  const list = loadProfiles();
  const p = list.find((x) => x.id === id);
  if (!p) return fail('Dieses Konto ist nicht mehr gespeichert.');
  if (!profileData(p)) return fail('Für "' + p.label + '" ist kein Zugang gespeichert. Melde dich im Launcher mit diesem Konto an und speichere es neu.');
  const exe = await findExe();
  if (!exe && !noProcess) return fail('Der Epic Games Launcher wurde auf diesem PC nicht gefunden.');
  if (!exists(launcherFile())) return fail(NOT_FOUND);

  if (!(await stopLauncher())) return fail(NOT_CLOSED);

  // Erst nach dem Beenden lesen. Die aktuelle Anmeldung geht nie verloren: Sie frischt das passende
  // Konto auf (auch das Ziel selbst, wenn sein Zugang inzwischen erneuert wurde) oder wird neu gesichert.
  const cur = await readCurrent();
  let kept = null;
  if (cur.remembered) {
    const r = upsertCurrent(list, cur, '');
    if (r.created) kept = r.profile;
  }
  p.lastUsed = new Date().toISOString();
  // Zuerst die Liste sichern, erst dann die Launcher-Datei ändern
  saveProfiles(list);
  try {
    writeLogin(p.section);
  } catch (err) {
    await startLauncher(exe);
    return fail(err.userMessage || err.message);
  }
  await applyRegistry(p.accountId);
  const startErr = await startLauncher(exe);
  return startedMessage('Der Launcher startet jetzt mit "' + p.label + '".' + (kept ? ' Dein bisheriges Konto wurde als "' + kept.label + '" mitgesichert.' : ''), startErr);
}

// "Weiteres Konto hinzufügen": aktuelles Konto sichern, nur die lokale Anmeldung leeren (NICHT abmelden –
// das würde den gespeicherten Zugang bei Epic ungültig machen) und den Launcher zur Anmeldung öffnen.
async function addNew() {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  const exe = await findExe();
  if (!exe && !noProcess) return fail('Der Epic Games Launcher wurde auf diesem PC nicht gefunden.');
  if (!exists(launcherFile())) return fail(NOT_FOUND);
  if (!(await stopLauncher())) return fail(NOT_CLOSED);

  const list = loadProfiles();
  const cur = await readCurrent();
  let kept = null;
  if (cur.remembered) kept = upsertCurrent(list, cur, '').profile;
  saveProfiles(list);
  try {
    writeLogin(EMPTY_LOGIN);
  } catch (err) {
    await startLauncher(exe);
    return fail(err.userMessage || err.message);
  }
  await applyRegistry(null);
  const startErr = await startLauncher(exe);
  return startedMessage('Der Launcher zeigt gleich die Anmeldung. Melde dich mit dem nächsten Konto an (Haken bei "Angemeldet bleiben") und klick dann hier auf "Aktuelles Konto speichern".'
    + (kept ? ' Dein bisheriges Konto ist als "' + kept.label + '" gesichert.' : ''), startErr);
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
  init, getStatus, saveCurrent, switchTo, addNew, remove, rename, removeAll, closeLauncher,
  // für Tests
  _ini: { readIni, writeIni, getSection, setSection, parseKeys },
  _test: { setWriteHook: (fn) => { writeHook = fn || null; } },
};
