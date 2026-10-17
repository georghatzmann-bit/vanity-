'use strict';
// Main window factory + navigation hardening.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');
const { openExternalSafe } = require('./util/shell');
const log = require('./log');

function createMainWindow() {
  const iconPng = path.join(__dirname, '..', '..', 'build', 'icon.png');
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    center: true,
    frame: false,
    show: false,
    title: 'Phoenix',
    backgroundColor: '#05060A',
    icon: process.platform !== 'win32' && fs.existsSync(iconPng) ? iconPng : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.PHOENIX_DEVTOOLS === '1',
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl && !app.isPackaged) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  }

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url).catch((err) => log.warn('blocked window.open', url, err.message));
    return { action: 'deny' };
  });
  win.webContents.on('render-process-gone', (_e, details) => log.error('renderer gone', details));

  return win;
}

module.exports = { createMainWindow };
