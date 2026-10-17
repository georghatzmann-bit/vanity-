'use strict';
// All ipcMain registrations (contract: docs/ARCHITECTURE.md §4).
const fs = require('fs');
const path = require('path');
const { app, ipcMain, clipboard, shell } = require('electron');
const log = require('./log');
const { MOCK } = require('./env');
const { openExternalSafe } = require('./util/shell');

const markerFile = () => path.join(app.getPath('userData'), 'installed-version');

function readMarker() {
  try {
    return fs.readFileSync(markerFile(), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Strips technical prefixes so the renderer can show the message directly. */
function userMessage(err) {
  const msg = (err && err.message) || String(err || 'Unbekannter Fehler');
  return msg.replace(/^Error:\s*/, '');
}

function registerIpc(getWin) {
  const backend = MOCK ? require('./mock') : require('./backend');

  const send = (channel, payload) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const trustedSender = (event) => {
    const url = (event.senderFrame && event.senderFrame.url) || '';
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    return url.startsWith('file://') || (!!devUrl && !app.isPackaged && url.startsWith(devUrl));
  };

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedSender(event)) throw new Error('Nicht erlaubt.');
      try {
        return await fn(...args);
      } catch (err) {
        // invalid user input (wrong code, foreign file) is expected – no stack trace needed
        if (channel === 'profile:decode' || channel === 'profile:load' || channel === 'profile:open') log.warn(`${channel}: ${userMessage(err)}`);
        else log.error(`${channel} fehlgeschlagen:`, err);
        throw new Error(userMessage(err));
      }
    });
  };

  const requireString = (value, name, max = 4096) => {
    if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Ungültiger Wert: ${name}`);
    return value;
  };

  // --- app / window -------------------------------------------------------
  handle('app:info', () => {
    const marker = readMarker();
    return { version: app.getVersion(), firstRun: marker !== app.getVersion(), isPackaged: app.isPackaged, mock: MOCK };
  });
  handle('app:markInstalled', () => {
    fs.mkdirSync(path.dirname(markerFile()), { recursive: true });
    fs.writeFileSync(markerFile(), app.getVersion(), 'utf8');
    return true;
  });
  handle('win:minimize', () => getWin()?.minimize());
  handle('win:toggleMaximize', () => {
    const win = getWin();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  handle('win:close', () => getWin()?.close());

  // --- system / winget ----------------------------------------------------
  handle('system:info', () => backend.getMachineInfo());
  handle('winget:status', () => backend.getWingetStatus());
  handle('winget:ensure', () => backend.ensureWinget((p) => send('winget:ensure-progress', p)));

  // --- scan / catalog -----------------------------------------------------
  handle('scan:run', () => backend.runScan((p) => send('scan:progress', p)));
  handle('catalog:get', () => backend.getCatalog());

  // --- profiles -----------------------------------------------------------
  handle('profile:save', (profile, dir) => backend.saveProfile(profile, dir, getWin()));
  handle('profile:saveToDrive', (profile, root) => backend.saveToDrive(profile, requireString(root, 'Laufwerk', 260)));
  handle('profile:open', () => backend.openProfileDialog(getWin()));
  handle('profile:find', () => backend.findProfiles());
  handle('profile:load', (file) => backend.loadProfile(requireString(file, 'Pfad', 1024)));
  handle('profile:encode', (profile) => backend.encodeProfile(profile));
  handle('profile:decode', (text) => backend.decodeProfile(requireString(text, 'Code', 200000)));

  // --- drives / setup -----------------------------------------------------
  handle('drives:list', () => backend.listDrives());
  handle('setup:find', () => backend.findSetupExe());

  // --- install ------------------------------------------------------------
  handle('install:start', (items) => {
    if (!Array.isArray(items) || items.length === 0) throw new Error('Keine Apps ausgewählt.');
    return backend.startInstall(items, (event) => send('install:event', event));
  });
  handle('install:cancel', () => backend.cancelInstall());

  // --- games --------------------------------------------------------------
  handle('games:launchers', () => backend.detectLaunchers());
  handle('games:install', (game, mode) => backend.installGame(game, mode));

  // --- misc ---------------------------------------------------------------
  handle('shell:open', (url) => openExternalSafe(url));
  handle('shell:showItem', (file) => {
    const p = requireString(file, 'Pfad', 1024);
    if (!path.isAbsolute(p)) throw new Error('Ungültiger Pfad.');
    shell.showItemInFolder(p);
    return true;
  });
  handle('clipboard:write', (text) => {
    clipboard.writeText(requireString(text, 'Text', 500000));
    return true;
  });
  handle('log:export', () => log.exportLog());
}

module.exports = { registerIpc };
