'use strict';
// Discord-Steuerung für Windows: starten, beenden, Benachrichtigungen und Töne stumm schalten.
// Es wird nichts an deinem Discord-Konto verändert und nie auf Discord-Anmeldedaten zugegriffen.
// Gesteuert wird nur über Windows selbst (Programmstart, Taskliste, Benachrichtigungs-Einstellung, Lautstärkemixer).

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

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
  // War beim letzten Mal der Ton stumm, die Stummschaltung weiter auffrischen
  const st = readMuteState();
  if (st && st.sound && isWindows()) startReapply();
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

function audioScript() {
  return path.join(resourcesDir || '', 'scripts', 'DiscordAudio.ps1');
}

async function runAudio(action) {
  const script = audioScript();
  if (!fs.existsSync(script)) return { ok: false, sessions: 0, message: 'Hilfsskript fehlt: ' + script };
  const cacheDir = path.join(dataDir || '.', 'cache');
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-CacheDir', cacheDir], 30000);
  if (res.code === 2 || /NO_SESSION/.test(res.stdout)) return { ok: true, sessions: 0 };
  if (res.code !== 0) return { ok: false, sessions: 0, message: (res.stderr || res.stdout || 'PowerShell-Fehler').trim().split(/\r?\n/)[0] };
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.split('\t').length >= 4);
  const muted = lines.filter((l) => l.split('\t')[3] === '1').length;
  return { ok: true, sessions: lines.length, muted };
}

function startReapply() {
  stopReapply();
  // Neue Audiositzungen (z. B. nach Discord-Neustart) werden sonst nicht stumm
  reapplyTimer = setInterval(async () => {
    const st = readMuteState();
    if (!st || !st.sound) return stopReapply();
    try {
      if ((await runningVariants()).length) await runAudio('mute');
    } catch (_) { /* nächster Versuch */ }
  }, 10000);
  if (reapplyTimer.unref) reapplyTimer.unref();
}

function stopReapply() {
  if (reapplyTimer) clearInterval(reapplyTimer);
  reapplyTimer = null;
}

// ---------- Öffentliche Funktionen ----------

async function getStatus() {
  if (!isWindows()) {
    return { supported: false, installed: [], running: false, runningNames: [], muted: { toasts: false, sound: false } };
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
    muted: { toasts: toastsMuted, sound: Boolean(st && st.sound), since: st ? st.at : null },
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
  const st = readMuteState();
  if (st && st.sound) setTimeout(() => runAudio('mute').catch(() => {}), 8000);
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
    const prev = readMuteState() || { toasts: null, sound: false };
    const state = { at: new Date().toISOString(), toasts: prev.toasts, sound: prev.sound };
    if (wantToasts && installed.length) {
      // Vorherigen Zustand nur beim ersten Stummschalten merken
      if (!state.toasts) {
        state.toasts = {};
        for (const v of installed) state.toasts[v.aumid] = await readToastEnabled(v.aumid);
      }
      let good = true;
      for (const v of installed) good = (await setToastEnabled(v.aumid, 0)) && good;
      messages.push(good ? 'Windows-Benachrichtigungen von Discord sind aus.' : 'Windows-Benachrichtigungen konnten nicht ganz ausgeschaltet werden.');
    }
    if (wantSound) {
      state.sound = true;
      const res = await runAudio('mute');
      if (!res.ok) messages.push('Töne: ' + res.message);
      else if (res.sessions === 0) messages.push('Discord-Töne werden stumm geschaltet, sobald Discord den ersten Ton abspielt.');
      else messages.push('Discord-Töne sind stumm.');
      startReapply();
    }
    writeMuteState(state);
    return ok(messages.join(' ') || 'Erledigt.');
  }

  // Wieder einschalten: alles genau so zurückstellen, wie es vorher war
  const st = readMuteState();
  let good = true;
  if (st && st.toasts) {
    for (const [aumid, before] of Object.entries(st.toasts)) good = (await setToastEnabled(aumid, before === 0 ? 1 : before)) && good;
  } else {
    for (const v of installed) {
      if ((await readToastEnabled(v.aumid)) === 0) good = (await setToastEnabled(v.aumid, 1)) && good;
    }
  }
  messages.push(good ? 'Windows-Benachrichtigungen von Discord sind wieder an.' : 'Windows-Benachrichtigungen konnten nicht ganz zurückgestellt werden.');
  stopReapply();
  const res = await runAudio('unmute');
  if (!res.ok) messages.push('Töne: ' + res.message);
  else messages.push('Discord-Töne sind wieder an.');
  writeMuteState(null);
  return ok(messages.join(' '));
}

// Beim Schließen des Konto-Retters: Ton wieder anschalten, damit Discord nicht dauerhaft stumm bleibt.
async function restoreSoundOnExit() {
  const st = readMuteState();
  stopReapply();
  if (!st || !st.sound || !isWindows()) return;
  try { await runAudio('unmute'); } catch (_) { /* egal */ }
  st.sound = false;
  if (st.toasts) writeMuteState(st); else writeMuteState(null);
}

module.exports = { init, getStatus, start, stop, setMuted, restoreSoundOnExit, VARIANTS };
