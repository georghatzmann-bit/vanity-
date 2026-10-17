'use strict';
// UI mode: single instance, main window, IPC.
const { app } = require('electron');
const log = require('./log');
const { MOCK } = require('./env');
const { createMainWindow } = require('./window');
const { registerIpc } = require('./ipc');

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
    win.on('closed', () => {
      win = null;
    });
  });

  app.on('window-all-closed', () => app.quit());
}

module.exports = { start };
