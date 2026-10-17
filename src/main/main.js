'use strict';
// Entry point. The same executable runs in two modes:
//   Phoenix.exe              -> UI (non-elevated)
//   Phoenix.exe --worker ... -> elevated install worker (see install/worker.js)
const isWorker = process.argv.includes('--worker');

// Without these, Electron shows its English error dialog and nothing reaches the Phoenix log. A
// crashed worker exits, so the UI notices the closed pipe and marks the remaining items failed.
process.on('uncaughtException', (err) => {
  try {
    require('./log').error('Unerwarteter Fehler', err);
  } catch {
    /* logging must never throw here */
  }
  if (isWorker) {
    try {
      require('electron').app.exit(5);
    } catch {
      process.exit(5);
    }
  }
});
process.on('unhandledRejection', (err) => {
  try {
    require('./log').error('Unbehandelte Promise-Ablehnung', err);
  } catch {
    /* logging must never throw here */
  }
});

if (isWorker) {
  require('./install/worker').run();
} else {
  require('./ui').start();
}
