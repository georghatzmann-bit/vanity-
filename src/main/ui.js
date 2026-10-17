'use strict';
// UI mode: single instance, main window, IPC.
const { app, dialog } = require('electron');
const log = require('./log');
const { MOCK } = require('./env');
const { createMainWindow } = require('./window');
const { registerIpc } = require('./ipc');

let allowClose = false;

/**
 * Closing the window kills both install lanes mid-install (the worker aborts when the pipe closes),
 * so ask first while a job runs. Never blocks a Windows shutdown/logoff.
 */
function guardClose(win) {
  const backend = MOCK ? require('./mock') : require('./backend');
  let asking = false;
  win.on('session-end', () => {
    allowClose = true;
  });
  win.on('close', (e) => {
    if (allowClose || !backend.isInstallRunning()) return;
    e.preventDefault();
    if (asking) return;
    asking = true;
    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Weiter installieren', 'Trotzdem schließen'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Phoenix',
        message: 'Die Installation läuft noch.',
        detail: 'Wenn du Phoenix jetzt schließt, wird die laufende Installation abgebrochen und die restlichen Apps werden nicht installiert.',
      })
      .then(({ response }) => {
        asking = false;
        if (response !== 1 || win.isDestroyed()) return;
        log.warn('Fenster während der Installation geschlossen.');
        allowClose = true;
        win.close();
      })
      .catch((err) => {
        asking = false;
        log.warn('Schließen-Abfrage fehlgeschlagen', err.message);
      });
  });
}

function start() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId('de.phoenix.restore');

  let win = null;
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    log.init('ui');
    log.info(`Phoenix ${app.getVersion()} gestartet (mock=${MOCK}, packaged=${app.isPackaged}, argv=${JSON.stringify(process.argv.slice(1))})`);
    registerIpc(() => win);
    win = createMainWindow();
    guardClose(win);
    win.on('closed', () => {
      win = null;
    });
  });

  app.on('before-quit', () => {
    allowClose = true;
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { start };
