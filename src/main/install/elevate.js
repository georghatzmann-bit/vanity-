'use strict';
// Elevation helpers: detect admin rights and launch the elevated worker (same exe, --worker),
// which connects back to a named-pipe server owned by the non-elevated UI process.
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { runPsJson } = require('../util/ps');
const { encodeMessage, createDecoder } = require('./protocol');
const log = require('../log');

let elevatedCache = null;

/**
 * True if this process runs with a full administrator token. Checks the token's integrity level
 * (High S-1-16-12288 / System S-1-16-16384) – SIDs are not localized; fltmc is the fallback.
 */
function isElevated() {
  if (elevatedCache !== null) return elevatedCache;
  if (process.platform !== 'win32') return (elevatedCache = false);
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  try {
    const res = spawnSync(path.join(sys32, 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 15000, encoding: 'latin1' });
    if (res.status === 0 && res.stdout) return (elevatedCache = /S-1-16-(12288|16384)\b/.test(res.stdout));
  } catch {
    /* fall through */
  }
  try {
    const res = spawnSync(path.join(sys32, 'fltmc.exe'), [], { windowsHide: true, timeout: 10000 });
    elevatedCache = res.status === 0;
  } catch {
    elevatedCache = false;
  }
  return elevatedCache;
}

/** Quotes one argument for a Windows command line (CommandLineToArgvW rules). */
function quoteArg(arg) {
  const s = String(arg);
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// Start-Process would swallow the Win32Exception (no way to tell "user clicked No"), so we call
// Process.Start with the runas verb directly. Exe and arguments arrive via environment variables.
const START_ELEVATED_PS = `
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:PHX_ELEV_FILE
  $psi.Arguments = $env:PHX_ELEV_ARGS
  $psi.WorkingDirectory = [System.IO.Path]::GetDirectoryName($env:PHX_ELEV_FILE)
  $psi.UseShellExecute = $true
  $psi.Verb = 'runas'
  $p = [System.Diagnostics.Process]::Start($psi)
  $procId = 0
  if ($null -ne $p) { $procId = $p.Id }
  Write-PhxJson @{ ok = $true; pid = $procId }
} catch {
  $e = $_.Exception
  while ($null -ne $e -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }
  $code = 0
  if ($null -ne $e) { $code = $e.NativeErrorCode }
  Write-PhxJson @{ ok = $false; code = $code; message = [string]$_.Exception.Message }
}
`;

const ERROR_CANCELLED = 1223;

/**
 * Starts the elevated worker and waits for its authenticated hello.
 * Resolves with a WorkerHandle; rejects with err.code = 'DECLINED' | 'FAILED' | 'TIMEOUT'.
 */
async function launchWorker({ timeoutMs = 120000 } = {}) {
  // Only the ASCII suffix travels on the command line; the worker rebuilds \\.\pipe\<suffix>.
  const pipeSuffix = `phoenix-${crypto.randomBytes(16).toString('hex')}`;
  const pipeName = `\\\\.\\pipe\\${pipeSuffix}`;
  const token = crypto.randomBytes(32).toString('hex');
  const server = net.createServer();

  // The connect timer is armed only after the UAC prompt was answered (see below): the prompt
  // itself may stay open for minutes.
  let timer = null;
  let failConnect = () => {};
  const connected = new Promise((resolve, reject) => {
    failConnect = reject;
    server.on('connection', (socket) => {
      let authed = false;
      const feed = createDecoder(
        (msg) => {
          if (authed) return;
          const given = Buffer.from(String(msg.token || ''));
          const want = Buffer.from(token);
          if (msg.t === 'hello' && given.length === want.length && crypto.timingSafeEqual(given, want)) {
            authed = true;
            clearTimeout(timer);
            socket.removeAllListeners('data');
            resolve({ socket, hello: msg });
          } else {
            socket.destroy();
          }
        },
        () => socket.destroy(),
      );
      socket.on('data', feed);
      socket.on('error', () => {});
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      err.code = 'FAILED';
      reject(err);
    });
  });
  connected.catch(() => {}); // early-return paths below never await it

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const workerArgs = ['--worker', '--pipe', pipeSuffix, '--token', token];
  if (!app.isPackaged) workerArgs.unshift(app.getAppPath());
  const argLine = workerArgs.map(quoteArg).join(' ');

  let started;
  try {
    // The UAC prompt can stay open for a long time – Process.Start returns once the user answered.
    started = await runPsJson(START_ELEVATED_PS, {
      env: { PHX_ELEV_FILE: process.execPath, PHX_ELEV_ARGS: argLine },
      timeoutMs: 15 * 60 * 1000,
    });
  } catch (err) {
    server.close();
    const e = new Error(`Admin-Prozess konnte nicht gestartet werden: ${err.message}`);
    e.code = 'FAILED';
    throw e;
  }
  if (!started || !started.ok) {
    server.close();
    const declined = started && Number(started.code) === ERROR_CANCELLED;
    const e = new Error(declined ? 'Die Admin-Abfrage wurde abgelehnt.' : `Admin-Prozess konnte nicht gestartet werden (${(started && started.message) || 'unbekannt'}).`);
    e.code = declined ? 'DECLINED' : 'FAILED';
    throw e;
  }
  log.info(`Worker gestartet (pid ${started.pid}), warte auf Verbindung …`);
  timer = setTimeout(() => {
    const err = new Error('Der Admin-Prozess hat sich nicht gemeldet.');
    err.code = 'TIMEOUT';
    failConnect(err);
  }, timeoutMs);
  const me = os.userInfo().username;

  let conn;
  try {
    conn = await connected;
  } catch (err) {
    server.close();
    throw err;
  } finally {
    clearTimeout(timer); // the worker may have connected before Process.Start returned
  }
  server.close(); // stop accepting further clients; the established socket stays open
  if (conn.hello.user && String(conn.hello.user).toLowerCase() !== String(me).toLowerCase()) {
    // UAC asked for another admin's password: per-user installs would land in the wrong profile.
    log.warn(`Worker läuft als ${conn.hello.user}, die Oberfläche als ${me}.`);
  }
  return createHandle(conn.socket, conn.hello);
}

/** Wraps the authenticated socket. runJob() resolves when the worker says bye or disconnects. */
function createHandle(socket, hello) {
  let onEvent = () => {};
  let finish = null;
  let closed = false;

  const feed = createDecoder(
    (msg) => {
      if (msg.t === 'event' && msg.event && typeof msg.event === 'object') onEvent(msg.event);
      else if (msg.t === 'log' && typeof msg.line === 'string') onEvent({ type: 'log', line: msg.line }); // queue.js writes it to the log file
      else if (msg.t === 'bye' && finish) finish({ disconnected: false });
    },
    (err) => log.warn('Ungültige Worker-Nachricht', err.message),
  );
  socket.on('data', feed);
  socket.on('error', (err) => log.warn('Worker-Verbindung', err.message));
  socket.on('close', () => {
    closed = true;
    if (finish) finish({ disconnected: true });
  });

  return {
    pid: hello.pid,
    elevated: !!hello.elevated,
    user: hello.user || null,
    /** Sends the job; onEvent receives install events. Resolves { disconnected }. */
    runJob(items, eventCb) {
      onEvent = eventCb;
      return new Promise((resolve) => {
        let done = false;
        finish = (res) => {
          if (done) return;
          done = true;
          resolve(res);
        };
        if (closed) return finish({ disconnected: true });
        socket.write(encodeMessage({ t: 'job', items }));
      });
    },
    cancel() {
      if (!closed) socket.write(encodeMessage({ t: 'cancel' }));
    },
    close() {
      if (!closed) socket.end();
    },
  };
}

module.exports = { isElevated, launchWorker, quoteArg };
