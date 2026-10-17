'use strict';
// Elevated worker mode: Phoenix.exe --worker --pipe <name> --token <hex>
// Connects to the UI's pipe, receives one job, installs it sequentially, streams events, exits.
const net = require('net');
const { app } = require('electron');
const log = require('../log');
const { encodeMessage, createDecoder, sanitizeItems } = require('./protocol');
const { isElevated } = require('./elevate');
const { runItems } = require('./runItems');

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

function run() {
  app.disableHardwareAcceleration();
  log.init('worker');
  const pipe = argValue(process.argv, '--pipe');
  const token = argValue(process.argv, '--token');
  if (!pipe || !/^\\\\\.\\pipe\\phoenix-[0-9a-f-]{36}$/i.test(pipe) || !token || !/^[0-9a-f]{64}$/i.test(token)) {
    log.error('Worker: ungültige Argumente', process.argv.slice(1));
    app.exit(2);
    return;
  }

  let controller = null;
  let gotJob = false;
  const socket = net.connect(pipe);
  const send = (msg) => {
    if (!socket.destroyed) socket.write(encodeMessage(msg));
  };

  const idle = setTimeout(() => {
    if (!gotJob) {
      log.warn('Worker: kein Auftrag erhalten – beende.');
      app.exit(3);
    }
  }, 60000);

  socket.on('connect', () => {
    send({ t: 'hello', token, pid: process.pid, elevated: isElevated() });
  });

  socket.on(
    'data',
    createDecoder(
      async (msg) => {
        if (msg.t === 'cancel') {
          if (controller) controller.abort();
          return;
        }
        if (msg.t !== 'job' || gotJob) return;
        gotJob = true;
        clearTimeout(idle);
        controller = new AbortController();
        const items = sanitizeItems(msg.items);
        log.info(`Worker: Auftrag mit ${items.length} Paketen`);
        try {
          await runItems(items, {
            emit: (event) => send({ t: 'event', event }),
            log: (line) => send({ t: 'log', line }),
            signal: controller.signal,
          });
        } catch (err) {
          log.error('Worker: Auftrag fehlgeschlagen', err);
        }
        send({ t: 'bye' });
        socket.end(() => app.exit(0));
        setTimeout(() => app.exit(0), 3000);
      },
      (err) => log.warn('Worker: ungültige Nachricht', err.message),
    ),
  );

  socket.on('error', (err) => {
    log.error('Worker: Pipe-Fehler', err);
    app.exit(4);
  });
  socket.on('close', () => {
    if (controller) controller.abort();
    setTimeout(() => app.exit(0), 500);
  });
}

module.exports = { run };
