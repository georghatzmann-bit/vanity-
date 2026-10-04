'use strict';
// Konten-Schnellwechsel für den Epic Games Launcher (nur Windows).
//
// Der Launcher merkt sich die Anmeldung ("Angemeldet bleiben") im Abschnitt [RememberMe] der Datei
//   %LOCALAPPDATA%\EpicGamesLauncher\Saved\Config\WindowsEditor\GameUserSettings.ini   (ab Launcher 19, Nov. 2025)
//   %LOCALAPPDATA%\EpicGamesLauncher\Saved\Config\Windows\GameUserSettings.ini         (ältere Launcher)
// und die Konto-ID unter HKCU\Software\Epic Games\Unreal Engine\Identifiers (Wert AccountId).
// Der Konto-Retter sichert beides pro Konto und spielt es beim Wechsel wieder ein – so machen es
// auch bekannte Konto-Wechsler wie der TcNo Account Switcher. Danach startet der Launcher neu.
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

let dataDir = null;
let crypto = null;        // { isAvailable, encrypt, decrypt } (Electron safeStorage) oder null
let iniOverride = null;   // für Tests: eigene GameUserSettings.ini
let exeOverride = null;   // für Tests
let noProcess = false;    // für Tests: Launcher nicht schließen/starten
let registry = null;      // { get(): Promise<string|null>, set(v): Promise<boolean> }

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
  };
}

function memoryRegistry() {
  let value = null;
  return {
    async get() { return value; },
    async set(v) { value = v; return true; },
  };
}

async function readRegistryAccountId() {
  if (!registry) return null;
  try {
    const v = await registry.get();
    return v && RE_ACCOUNT_ID.test(v) ? v.toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// Ersatz, falls die Registry leer ist: der Launcher legt pro angemeldetem Konto
// Saved\Data\<Konto-ID>.dat an (manchmal mit "OC_" davor); die neueste Datei gehört zum letzten Konto.
function newestDataAccountId() {
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

async function currentAccountId() {
  return (await readRegistryAccountId()) || (iniOverride ? null : newestDataAccountId());
}

// ---------- Einstellungsdateien des Launchers ----------

// Alle GameUserSettings.ini unter Saved\Config\<Ordner>\. Reihenfolge: WindowsEditor (aktueller Launcher),
// Windows (älterer Launcher), dann alle anderen.
function loginFiles() {
  if (iniOverride) return exists(iniOverride) ? [iniOverride] : [];
  const base = path.join(savedDir(), 'Config');
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { return []; }
  const rank = (d) => (d === 'WindowsEditor' ? 0 : d === 'Windows' ? 1 : 2);
  dirs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return dirs.map((d) => path.join(base, d, SETTINGS_NAME)).filter(exists);
}

// Wo der Launcher die Datei anlegen würde (nur für Meldungen und die Diagnose)
function expectedFile() {
  if (iniOverride) return iniOverride;
  const editor = path.join(savedDir(), 'Config', 'WindowsEditor', SETTINGS_NAME);
  return exists(path.dirname(editor)) ? editor : path.join(savedDir(), 'Config', 'Windows', SETTINGS_NAME);
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

// Schreibt denselben [RememberMe]-Abschnitt in alle Einstellungsdateien des Launchers.
// Welche Datei ein Launcher liest, hängt von seiner Version ab – in die andere zu schreiben schadet nicht.
function writeLoginSection(body) {
  const files = loginFiles();
  if (!files.length) return false;
  for (const file of files) {
    const ini = readIni(file);
    if (ini) writeIni(file, ini, setSection(ini.text, SECTION, body));
  }
  return true;
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
  const files = loginFiles();
  const reads = files.map(readLoginFile).filter(Boolean);
  // Mit Anmeldung: die zuletzt geschriebene Datei gewinnt. Sonst die erste mit Abschnitt, sonst die erste.
  const withLogin = reads.filter((r) => r.remembered).sort((a, b) => b.mtime - a.mtime);
  const pick = withLogin[0] || reads.find((r) => r.sectionFound) || reads[0] || null;
  const accountId = await currentAccountId();
  if (!pick) {
    return { found: false, file: expectedFile(), sectionFound: false, enable: '', dataLength: 0, remembered: false, email: '', data: '', section: '', accountId, files: reads };
  }
  return {
    found: true,
    file: pick.file,
    sectionFound: pick.sectionFound,
    enable: pick.enable,
    dataLength: pick.data.length,
    remembered: pick.remembered,
    email: pick.email,
    data: pick.data,
    section: pick.section,
    accountId,
    files: reads,
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
  const file = profilesFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(w), 'utf8');
  fs.renameSync(tmp, file);
}

function profileData(p) {
  return parseKeys(p.section).Data || '';
}

// Welches gespeicherte Konto ist gerade angemeldet?
// 1. exakt derselbe Zugang, 2. dieselbe Konto-ID (Epic hat den Zugang erneuert), 3. dieselbe E-Mail-Adresse.
function matchProfile(list, cur) {
  if (!cur || !cur.remembered) return null;
  return list.find((p) => cur.data && profileData(p) === cur.data)
    || (cur.accountId ? list.find((p) => p.accountId && p.accountId === cur.accountId) : null)
    || (cur.email ? list.find((p) => p.email && p.email.toLowerCase() === cur.email.toLowerCase()) : null)
    || null;
}

function shortId(id) {
  return id ? id.slice(0, 8) : '';
}

// Nur das, was die Oberfläche sehen darf (nie den Zugang selbst)
function publicView(p, current) {
  return {
    id: p.id,
    label: p.label,
    email: p.email || '',
    accountIdShort: shortId(p.accountId),
    savedAt: p.savedAt || null,
    lastUsed: p.lastUsed || null,
    isCurrent: Boolean(current && current.id === p.id),
  };
}

function newId() {
  return nodeCrypto.randomBytes(8).toString('hex');
}

function defaultLabel(cur, list) {
  if (cur.email) return cur.email;
  if (cur.accountId) return 'Epic-Konto ' + shortId(cur.accountId);
  return 'Epic-Konto ' + (list.length + 1);
}

// Aktuelle Anmeldung in die Liste übernehmen: vorhandenes Konto auffrischen oder neu anlegen.
// Gibt { profile, created } zurück. Ändert nur die Liste im Speicher.
function upsertCurrent(list, cur, label) {
  const now = new Date().toISOString();
  const existing = matchProfile(list, cur);
  if (existing) {
    existing.section = cur.section;
    if (cur.email) existing.email = cur.email;
    if (cur.accountId) existing.accountId = cur.accountId;
    existing.savedAt = now;
    if (label) existing.label = label.slice(0, 60);
    return { profile: existing, created: false };
  }
  const p = {
    id: newId(),
    label: (label || defaultLabel(cur, list)).slice(0, 60),
    email: cur.email || '',
    accountId: cur.accountId || '',
    savedAt: now,
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
    await sleep(250);
    if (!(await isRunning())) return true;
  }
  return !(await isRunning());
}

// Erst höflich (Fenster schließen, damit der Launcher seine Einstellungen schreibt),
// dann hart, falls er sich nur in den Infobereich zurückzieht. Danach die Hilfsprogramme.
async function stopLauncher() {
  if (noProcess) return true;
  if (await isRunning()) {
    await run('taskkill', ['/IM', LAUNCHER_EXE]);
    if (!(await waitGone(6000))) {
      await run('taskkill', ['/IM', LAUNCHER_EXE, '/T', '/F']);
      if (!(await waitGone(10000))) return false;
    }
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

function startLauncher(exe) {
  if (noProcess || !exe) return;
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
  child.unref();
}

// ---------- Öffentliche Funktionen ----------

async function getStatus() {
  const sup = supported();
  let cur = { found: false, file: '', sectionFound: false, enable: '', dataLength: 0, remembered: false, email: '', accountId: null, files: [] };
  let problem = null;
  let accounts = [];
  let exe = null;
  if (sup) {
    try { cur = await readCurrent(); } catch (err) { problem = 'Die Launcher-Einstellungen konnten nicht gelesen werden: ' + err.message; }
    try { accounts = loadProfiles(); } catch (err) { problem = err.message; }
    exe = await findExe();
  }
  const running = sup ? await isRunning() : false;
  const current = matchProfile(accounts, cur);
  return {
    supported: sup,
    launcherInstalled: Boolean(exe) || cur.found,
    running,
    settingsFound: cur.found,
    remembered: Boolean(cur.remembered),
    currentEmail: cur.email || '',
    currentAccountIdShort: shortId(cur.accountId),
    encrypted: encrypted(),
    problem,
    accounts: accounts.map((p) => publicView(p, current)),
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
      launcherExe: exe || '',
      launcherVersion: sup && !noProcess ? launcherVersion() : '',
      configFiles: (cur.files || []).map((f) => ({
        file: f.file,
        hasSection: f.sectionFound,
        dataLength: f.data ? f.data.length : 0,
        modified: f.mtime ? new Date(f.mtime).toISOString() : null,
      })),
    },
  };
}

// Launcher sauber beenden (für "Konto speichern", wenn er die Anmeldung noch nicht geschrieben hat)
async function closeLauncher() {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  if (!(await isRunning())) return ok('Der Launcher war schon beendet.');
  const closed = await stopLauncher();
  if (!closed) return fail('Der Launcher ließ sich nicht beenden. Bitte beende ihn von Hand: unten rechts im Infobereich Rechtsklick auf das Epic-Symbol, dann "Beenden".');
  return ok('Der Launcher wurde beendet.');
}

const NOT_FOUND = 'Die Einstellungen des Epic Games Launchers wurden nicht gefunden. Ist der Launcher installiert und wurde er schon einmal gestartet?';
const NOT_CLOSED = 'Der Launcher ließ sich nicht schließen. Bitte schließ ihn von Hand (unten rechts im Infobereich: Rechtsklick auf das Epic-Symbol, "Beenden") und versuch es nochmal.';

async function saveCurrent(label) {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  const cur = await readCurrent();
  if (!cur.found) return fail(NOT_FOUND);
  if (!cur.remembered) {
    const running = await isRunning();
    return Object.assign(fail(running
      ? 'Der Launcher läuft, aber in seiner Einstellungsdatei steht noch keine Anmeldung. Er schreibt sie oft erst beim Beenden.'
      : 'In der Einstellungsdatei des Launchers steht keine Anmeldung. Starte den Launcher, melde dich an und setz den Haken bei "Angemeldet bleiben". Beende ihn dann über das Symbol unten rechts (Rechtsklick, "Beenden") und speichere hier erneut.'),
    { code: 'not-remembered', running });
  }
  const list = loadProfiles();
  const { profile, created } = upsertCurrent(list, cur, String(label || '').trim());
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
  if (!loginFiles().length) return fail(NOT_FOUND);

  if (!(await stopLauncher())) return fail(NOT_CLOSED);

  // Erst nach dem Schließen lesen: Der Launcher schreibt beim Beenden seinen aktuellen (evtl. erneuerten) Zugang.
  // Das bisher angemeldete Konto wird so aufgefrischt bzw. mitgesichert und geht nie verloren.
  const cur = await readCurrent();
  let kept = null;
  if (cur.remembered) {
    const before = matchProfile(list, cur);
    if (before !== p) {
      const r = upsertCurrent(list, cur, '');
      if (r.created) kept = r.profile;
    }
  }

  writeLoginSection(p.section);
  if (p.accountId && registry) {
    try { await registry.set(p.accountId); } catch (_) { /* nur Hilfe für den Launcher */ }
  }
  p.lastUsed = new Date().toISOString();
  saveProfiles(list);
  startLauncher(exe);
  return ok('Der Launcher startet jetzt mit "' + p.label + '".' + (kept ? ' Dein bisheriges Konto wurde als "' + kept.label + '" mitgesichert.' : ''), { id: p.id });
}

// "Weiteres Konto hinzufügen": aktuelles Konto sichern, nur die lokale Anmeldung leeren (NICHT abmelden –
// das würde den gespeicherten Zugang bei Epic ungültig machen) und den Launcher zur Anmeldung öffnen.
async function addNew() {
  if (!supported()) return fail('Nur unter Windows verfügbar.');
  const exe = await findExe();
  if (!exe && !noProcess) return fail('Der Epic Games Launcher wurde auf diesem PC nicht gefunden.');
  if (!loginFiles().length) return fail(NOT_FOUND);
  if (!(await stopLauncher())) return fail(NOT_CLOSED);

  const list = loadProfiles();
  const cur = await readCurrent();
  let kept = null;
  if (cur.remembered) {
    const r = upsertCurrent(list, cur, '');
    kept = r.profile;
    saveProfiles(list);
  }
  writeLoginSection('Enable=True\nData=');
  startLauncher(exe);
  return ok('Der Launcher zeigt gleich die Anmeldung. Melde dich mit dem nächsten Konto an (Haken bei "Angemeldet bleiben") und klick dann hier auf "Aktuelles Konto speichern".'
    + (kept ? ' Dein bisheriges Konto ist als "' + kept.label + '" gesichert.' : ''));
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
};
