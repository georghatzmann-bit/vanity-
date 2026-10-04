'use strict';
// Discord-Steuerung für Windows: starten, beenden, Benachrichtigungen und Töne stumm schalten.
// Es wird nichts an deinem Discord-Konto verändert und nie auf Discord-Anmeldedaten zugegriffen.
// Gesteuert wird nur über Windows selbst (Programmstart, Taskliste, Benachrichtigungs-Einstellung, Lautstärkemixer).

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

const VARIANTS = [
  { key: 'stable', name: 'Discord', folder: 'Discord', exe: 'Discord.exe', aumid: 'com.squirrel.Discord.Discord' },
  { key: 'ptb', name: 'Discord PTB', folder: 'DiscordPTB', exe: 'DiscordPTB.exe', aumid: 'com.squirrel.DiscordPTB.DiscordPTB' },
  { key: 'canary', name: 'Discord Canary', folder: 'DiscordCanary', exe: 'DiscordCanary.exe', aumid: 'com.squirrel.DiscordCanary.DiscordCanary' },
];

const NOTIFY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\';

let dataDir = null;
let resourcesDir = null;
let reapplyTimer = null;

function isWindows() {
  return process.platform === 'win32';
}

function init(opts) {
  dataDir = opts.dataDir;
  resourcesDir = opts.resourcesDir;
  stopSoundTimer();
  // Offener Auftrag vom letzten Mal (stumm halten oder Ton wieder einschalten)?
  const st = readMuteState();
  soundMode = null;
  if (st && (st.sound === 'muted' || st.sound === true)) soundMode = 'muted';
  else if (st && st.sound === 'restore') soundMode = 'restore';
  if (soundMode && isWindows()) startSoundTimer();
}

function ok(message, extra) { return Object.assign({ ok: true, message }, extra || {}); }
function fail(message) { return { ok: false, message }; }

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeout || 15000, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
    });
  });
}

function localAppData() {
  return process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
}

function updateExe(v) {
  return path.join(localAppData(), v.folder, 'Update.exe');
}

function installedVariants() {
  if (!isWindows()) return [];
  return VARIANTS.filter((v) => {
    try { return fs.existsSync(updateExe(v)); } catch (_) { return false; }
  });
}

// Läuft das Programm? (Ausgabe von tasklist ist je nach Sprache verschieden, deshalb nur den Namen prüfen)
async function isRunning(v) {
  const res = await run('tasklist', ['/FI', 'IMAGENAME eq ' + v.exe, '/FO', 'CSV', '/NH'], 8000);
  const needle = '"' + v.exe.toLowerCase() + '"';
  return res.stdout.split(/\r?\n/).some((l) => l.trim().toLowerCase().startsWith(needle));
}

async function runningVariants() {
  const result = [];
  for (const v of VARIANTS) {
    if (await isRunning(v)) result.push(v);
  }
  return result;
}

// ---------- gespeicherter Stumm-Zustand (um alles exakt zurückstellen zu können) ----------

function muteStateFile() {
  return path.join(dataDir || '.', 'discord-stumm.json');
}

function readMuteState() {
  try {
    return JSON.parse(fs.readFileSync(muteStateFile(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeMuteState(state) {
  try {
    if (state) {
      fs.mkdirSync(path.dirname(muteStateFile()), { recursive: true });
      fs.writeFileSync(muteStateFile(), JSON.stringify(state, null, 2), 'utf8');
    } else {
      fs.unlinkSync(muteStateFile());
    }
  } catch (_) { /* nicht schlimm */ }
}

// ---------- Windows-Benachrichtigungen (Registry, nur aktueller Benutzer) ----------

async function readToastEnabled(aumid) {
  const res = await run('reg', ['query', NOTIFY_KEY + aumid, '/v', 'Enabled'], 8000);
  if (res.code !== 0) return null; // Wert fehlt = Standard (an)
  const m = /Enabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(res.stdout);
  return m ? parseInt(m[1], 16) : null;
}

async function setToastEnabled(aumid, value) {
  if (value === null || value === undefined) {
    const res = await run('reg', ['delete', NOTIFY_KEY + aumid, '/v', 'Enabled', '/f'], 8000);
    return res.code === 0 || /unable to find|nicht finden|wurde nicht gefunden/i.test(res.stderr + res.stdout);
  }
  const res = await run('reg', ['add', NOTIFY_KEY + aumid, '/v', 'Enabled', '/t', 'REG_DWORD', '/d', String(value), '/f'], 8000);
  return res.code === 0;
}

// ---------- Discord-Töne (Lautstärkemixer über PowerShell) ----------
//
// Zustand der Töne (im Speicher und in discord-stumm.json):
//   'muted'   = Discord soll stumm sein (wird alle 10 s neu angewendet, z. B. nach Discord-Neustart)
//   'restore' = Ton soll wieder an, ist aber noch nicht bestätigt (z. B. weil Discord gerade nicht lief)
//   null      = nichts zu tun
// Windows merkt sich die Stummschaltung pro Programm. Deshalb wird "restore" erst gelöscht,
// wenn das Wiedereinschalten wirklich bei Discord angekommen ist.

let soundMode = null;
let audioQueue = Promise.resolve();

function audioScript() {
  return path.join(resourcesDir || '', 'scripts', 'DiscordAudio.ps1');
}

function audioArgs(action) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', audioScript(), '-Action', action, '-CacheDir', path.join(dataDir || '.', 'cache')];
}

function parseAudio(code, stdout, stderr) {
  if (code === 2 || /NO_SESSION/.test(stdout)) return { ok: true, sessions: 0 };
  if (code !== 0) return { ok: false, sessions: 0, message: (stderr || stdout || 'PowerShell-Fehler').trim().split(/\r?\n/)[0] };
  const lines = stdout.split(/\r?\n/).filter((l) => l.split('\t').length >= 4);
  return { ok: true, sessions: lines.length, muted: lines.filter((l) => l.split('\t')[3] === '1').length };
}

// Alle Ton-Aktionen laufen nacheinander, damit ein altes "stumm" nie ein neueres "an" überholt.
function runAudio(action) {
  const job = audioQueue.then(async () => {
    if (!fs.existsSync(audioScript())) return { ok: false, sessions: 0, message: 'Hilfsskript fehlt: ' + audioScript() };
    const res = await run('powershell.exe', audioArgs(action), 30000);
    return parseAudio(res.code, res.stdout, res.stderr);
  });
  audioQueue = job.catch(() => {});
  return job;
}

function saveSoundMode(mode) {
  soundMode = mode;
  const st = readMuteState() || {};
  if (mode) st.sound = mode; else delete st.sound;
  if (mode === 'muted') st.at = st.at || new Date().toISOString();
  writeMuteState(st.sound || st.toasts ? st : null);
  if (mode) startSoundTimer(); else stopSoundTimer();
}

// Versucht, den Ton wieder einzuschalten. Gelöscht wird der Auftrag nur bei Erfolg.
async function tryRestoreSound() {
  const res = await runAudio('unmute');
  if (soundMode !== 'restore') return res; // inzwischen wieder stumm geschaltet
  if (res.ok && res.sessions > 0) saveSoundMode(null);
  return res;
}

function startSoundTimer() {
  if (reapplyTimer) return;
  reapplyTimer = setInterval(async () => {
    if (!soundMode) return stopSoundTimer();
    try {
      if (!(await runningVariants()).length) return;
      if (soundMode === 'muted') await runAudio('mute');
      else if (soundMode === 'restore') await tryRestoreSound();
    } catch (_) { /* nächster Versuch */ }
  }, 10000);
  if (reapplyTimer.unref) reapplyTimer.unref();
}

function stopSoundTimer() {
  if (reapplyTimer) clearInterval(reapplyTimer);
  reapplyTimer = null;
}

// Merker in der Registry, damit die Deinstallation die Discord-Popups wieder einschalten kann
async function setToastMarker(on) {
  if (on) await run('reg', ['add', 'HKCU\\Software\\Konto-Retter', '/v', 'DiscordToastsMuted', '/t', 'REG_DWORD', '/d', '1', '/f'], 8000);
  else await run('reg', ['delete', 'HKCU\\Software\\Konto-Retter', '/v', 'DiscordToastsMuted', '/f'], 8000);
}

// ---------- Öffentliche Funktionen ----------

async function getStatus() {
  if (!isWindows()) {
    return { supported: false, installed: [], running: false, runningNames: [], muted: { toasts: false, sound: false, restorePending: false } };
  }
  const installed = installedVariants();
  const running = await runningVariants();
  const st = readMuteState();
  let toastsMuted = false;
  if (installed.length) {
    const values = await Promise.all(installed.map((v) => readToastEnabled(v.aumid)));
    toastsMuted = values.every((x) => x === 0);
  }
  return {
    supported: true,
    installed: installed.map((v) => v.name),
    running: running.length > 0,
    runningNames: running.map((v) => v.name),
    muted: { toasts: toastsMuted, sound: soundMode === 'muted', restorePending: soundMode === 'restore', since: st ? st.at : null },
  };
}

async function start() {
  if (!isWindows()) return fail('Die Discord-Steuerung funktioniert nur unter Windows.');
  const installed = installedVariants();
  if (!installed.length) return fail('Discord wurde auf diesem PC nicht gefunden. Ist es installiert?');
  const v = installed[0];
  try {
    const child = spawn(updateExe(v), ['--processStart', v.exe], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    return fail('Discord konnte nicht gestartet werden: ' + err.message);
  }
  // Stumm- oder Wieder-an-Auftrag erledigt der 10-Sekunden-Takt, sobald Discord läuft
  return ok(v.name + ' wird gestartet. Das kann ein paar Sekunden dauern.');
}

async function stop() {
  if (!isWindows()) return fail('Die Discord-Steuerung funktioniert nur unter Windows.');
  let running = await runningVariants();
  if (!running.length) return ok('Discord läuft gerade nicht.');
  // Erst höflich bitten (Discord geht dabei oft nur in den Infobereich) ...
  for (const v of running) await run('taskkill', ['/IM', v.exe], 8000);
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 500));
    running = await runningVariants();
    if (!running.length) return ok('Discord wurde beendet.');
  }
  // ... dann sicher beenden (wie "Task beenden" im Task-Manager)
  for (const v of running) await run('taskkill', ['/F', '/T', '/IM', v.exe], 10000);
  await new Promise((r) => setTimeout(r, 700));
  running = await runningVariants();
  if (running.length) return fail('Discord ließ sich nicht beenden. Versuch es im Task-Manager (Strg + Umschalt + Esc).');
  return ok('Discord wurde beendet.');
}

async function setMuted(muted, options) {
  if (!isWindows()) return fail('Die Discord-Steuerung funktioniert nur unter Windows.');
  const wantToasts = options.toasts !== false;
  const wantSound = options.sound !== false;
  const installed = installedVariants();
  const messages = [];

  if (muted) {
    if (wantSound) saveSoundMode('muted'); // sofort, damit kein älteres "an" dazwischenfunkt
    if (wantToasts && installed.length) {
      const st = readMuteState() || {};
      // Vorherigen Zustand nur beim ersten Stummschalten merken
      if (!st.toasts) {
        st.toasts = {};
        for (const v of installed) st.toasts[v.aumid] = await readToastEnabled(v.aumid);
        st.at = st.at || new Date().toISOString();
        writeMuteState(st);
      }
      let good = true;
      for (const v of installed) good = (await setToastEnabled(v.aumid, 0)) && good;
      await setToastMarker(true);
      messages.push(good ? 'Windows-Benachrichtigungen von Discord sind aus.' : 'Windows-Benachrichtigungen konnten nicht ganz ausgeschaltet werden.');
    }
    if (wantSound) {
      const res = await runAudio('mute');
      if (!res.ok) messages.push('Töne: ' + res.message);
      else if (res.sessions === 0) messages.push('Discord-Töne werden stumm geschaltet, sobald Discord den ersten Ton abspielt.');
      else messages.push('Discord-Töne sind stumm.');
    }
    return ok(messages.join(' ') || 'Erledigt.');
  }

  // Wieder einschalten: alles genau so zurückstellen, wie es vorher war
  const hadSound = soundMode === 'muted' || soundMode === 'restore';
  if (hadSound) saveSoundMode('restore');
  const st = readMuteState();
  let good = true;
  if (st && st.toasts) {
    for (const [aumid, before] of Object.entries(st.toasts)) good = (await setToastEnabled(aumid, before === 0 ? 1 : before)) && good;
  } else {
    for (const v of installed) {
      if ((await readToastEnabled(v.aumid)) === 0) good = (await setToastEnabled(v.aumid, 1)) && good;
    }
  }
  await setToastMarker(false);
  const after = readMuteState();
  if (after) { delete after.toasts; writeMuteState(after.sound ? after : null); }
  messages.push(good ? 'Windows-Benachrichtigungen von Discord sind wieder an.' : 'Windows-Benachrichtigungen konnten nicht ganz zurückgestellt werden.');

  const res = hadSound ? await tryRestoreSound() : await runAudio('unmute');
  if (!res.ok) messages.push('Töne: ' + res.message + ' Es wird automatisch weiter versucht.');
  else if (soundMode === 'restore') messages.push('Discord läuft gerade nicht oder spielt nichts ab. Der Ton wird automatisch wieder eingeschaltet, sobald Discord läuft.');
  else messages.push('Discord-Töne sind wieder an.');
  return ok(messages.join(' '));
}

// Beim Schließen des Konto-Retters: Ton wieder anschalten, damit Discord nicht dauerhaft stumm bleibt.
// Klappt das nicht (Discord läuft nicht), bleibt der Auftrag gespeichert und wird beim nächsten Start erledigt.
async function restoreSoundOnExit() {
  stopSoundTimer();
  if (!isWindows() || !soundMode) return;
  saveSoundMode('restore');
  stopSoundTimer();
  try { await tryRestoreSound(); } catch (_) { /* nächster Start */ }
  stopSoundTimer();
}

// Windows wird heruntergefahren: Es bleiben nur wenige Sekunden, deshalb synchron.
function restoreSoundOnSessionEnd() {
  if (!isWindows() || !soundMode) return;
  saveSoundMode('restore');
  stopSoundTimer();
  try {
    const out = execFileSync('powershell.exe', audioArgs('unmute'), { windowsHide: true, timeout: 4000, encoding: 'utf8' });
    if (parseAudio(0, String(out || ''), '').sessions > 0) saveSoundMode(null);
  } catch (_) { /* bleibt "restore", wird beim nächsten Start erledigt */ }
  stopSoundTimer();
}

module.exports = { init, getStatus, start, stop, setMuted, restoreSoundOnExit, restoreSoundOnSessionEnd, VARIANTS };
