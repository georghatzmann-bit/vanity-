'use strict';
// Elevation helpers: detect admin rights and launch the elevated worker (same exe, --worker),
// which connects back to a named-pipe server owned by the non-elevated UI process.
const crypto = require('crypto');
const net = require('net');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { runPsJson } = require('../util/ps');
const { encodeMessage, createDecoder } = require('./protocol');
const log = require('../log');

let elevatedCache = null;

/** True if this process runs with a full administrator token. */
function isElevated() {
  if (elevatedCache !== null) return elevatedCache;
  if (process.platform !== 'win32') return (elevatedCache = false);
  try {
    // fltmc only succeeds with an elevated token.
    const res = spawnSync('fltmc', [], { windowsHide: true, timeout: 10000 });
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

const START_ELEVATED_PS = `
$exe = $args[0]; $argLine = $args[1]
try {
  $p = Start-Process -FilePath $exe -ArgumentList $argLine -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop
  Write-PhxJson @{ ok = $true; pid = $p.Id }
} catch {
  $code = 0
  $inner = $_.Exception
  while ($inner) { if ($inner -is [System.ComponentModel.Win32Exception]) { $code = $inner.NativeErrorCode; break }; $inner = $inner.InnerException }
  Write-PhxJson @{ ok = $false; code = $code; message = [string]$_.Exception.Message }
}
`;

const ERROR_CANCELLED = 1223;

/**
 * Starts the elevated worker and waits for its authenticated hello.
 * Resolves with a WorkerHandle; rejects with err.code = 'DECLINED' | 'FAILED' | 'TIMEOUT'.
 */
async function launchWorker({ timeoutMs = 120000 } = {}) {
  const pipeName = `\\\\.\\pipe\\phoenix-${crypto.randomUUID()}`;
  const token = crypto.randomBytes(32).toString('hex');
  const server = net.createServer();

  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('Der Admin-Prozess hat sich nicht gemeldet.');
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);
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

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const workerArgs = ['--worker', '--pipe', pipeName, '--token', token];
  if (!app.isPackaged) workerArgs.unshift(app.getAppPath());
  const argLine = workerArgs.map(quoteArg).join(' ');

  let started;
  try {
    started = await runPsJson(START_ELEVATED_PS, { args: [process.execPath, argLine], timeoutMs: 10 * 60 * 1000 });
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

  let conn;
  try {
    conn = await connected;
  } catch (err) {
    server.close();
    throw err;
  }
  server.close(); // stop accepting further clients; the established socket stays open
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
      else if (msg.t === 'log' && typeof msg.line === 'string') log.info(`[worker] ${msg.line}`);
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
