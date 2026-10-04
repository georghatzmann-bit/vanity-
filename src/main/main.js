'use strict';
// Hauptprozess des Konto-Retters: öffnet das Fenster und erledigt alles,
// was die Oberfläche aus Sicherheitsgründen nicht selbst darf
// (Dateien speichern, Webseiten öffnen, PDFs lesen, Discord steuern).

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, safeStorage, Menu } = require('electron');

const { createStore } = require('./store');
const { isAllowedUrl } = require('./links');
const pdf = require('./pdf');
const discord = require('./discord');
const fields = require('../shared/fields');
const extract = require('../shared/extract');

const MAX_PDF_BYTES = 50 * 1024 * 1024;

const DEFAULT_STATE = {
  version: 1,
  data: fields.emptyData(),
  recovery: { current: null, done: {}, autoOpen: true, startedAt: null, notes: {} },
  pdf: { imports: [] },
  support: { lang: 'de', variant: 'first' },
  discord: { toasts: true, sound: true },
  ui: { view: 'recovery', welcomeSeen: false },
};

let mainWindow = null;
let store = null;
const pickedFiles = new Map();
let pickCounter = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start);
}

function start() {
  app.setAppUserModelId('de.kontoretter.app');
  Menu.setApplicationMenu(null);

  store = createStore({
    dir: app.getPath('userData'),
    defaults: DEFAULT_STATE,
    crypto: {
      isAvailable: () => {
        try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
      },
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buf) => safeStorage.decryptString(buf),
    },
  });

  discord.init({ dataDir: app.getPath('userData'), resourcesDir: resourcesDir() });
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Vor dem Beenden Discord-Ton wieder anschalten (falls der Konto-Retter ihn stumm geschaltet hat)
  let cleanedUp = false;
  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    cleanedUp = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, 6000));
    Promise.race([discord.restoreSoundOnExit(), timeout]).finally(() => app.quit());
  });
}

// Ordner mit den PowerShell-Hilfsskripten: im installierten Programm unter
// "resources", beim Entwickeln im Projektordner.
function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0F1115',
    title: 'Konto-Retter',
    icon: path.join(__dirname, '..', 'renderer', 'img', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Links aus der Oberfläche nie im Programmfenster öffnen, sondern geprüft im Browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (isAllowedUrl(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function ok(value) { return { ok: true, value }; }
function fail(message, code) { return { ok: false, message, code: code || null }; }

// Fehler in einem Handler sollen nie das Programm abstürzen lassen,
// sondern als verständliche Meldung in der Oberfläche landen.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[ipc ${channel}]`, err);
      return fail(err && err.userMessage ? err.userMessage : 'Da ist etwas schiefgelaufen: ' + (err && err.message ? err.message : String(err)), err && err.code);
    }
  });
}

function registerIpc() {
  handle('app:info', () => ok({
    version: app.getVersion(),
    platform: process.platform,
    dataFile: store.file,
    encrypted: store.encrypted(),
  }));

  handle('state:load', () => ok(store.load()));
  handle('state:save', async (state) => {
    if (!state || typeof state !== 'object') return fail('Ungültiger Speicherstand.');
    await store.save(state);
    return ok(true);
  });
  handle('state:reset', () => ok(store.reset()));

  handle('open-url', async (url) => {
    if (!isAllowedUrl(url)) return fail('Dieser Link ist nicht freigegeben und wurde aus Sicherheitsgründen nicht geöffnet.');
    await shell.openExternal(url);
    return ok(true);
  });

  handle('clipboard:write', (text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return ok(true);
  });

  handle('pdf:parse-bytes', async (name, bytes, password) => {
    if (!bytes || !bytes.byteLength) return fail('Die Datei ist leer.');
    if (bytes.byteLength > MAX_PDF_BYTES) return fail('Die Datei ist größer als 50 MB. Bitte eine kleinere PDF nehmen.');
    return ok(await readDocument(String(name || 'Datei.pdf'), new Uint8Array(bytes), password));
  });

  // Dateiauswahl: Die Oberfläche bekommt nur Namen und Kennungen zurück, keine Pfade.
  // Gelesen werden darf danach ausschließlich eine Datei, die der Nutzer selbst ausgewählt hat.
  handle('pdf:pick', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'PDF auswählen',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF oder Text', extensions: ['pdf', 'txt', 'eml'] }],
    });
    if (res.canceled || !res.filePaths.length) return ok([]);
    return ok(res.filePaths.map((file) => {
      const token = 'f' + (++pickCounter);
      pickedFiles.set(token, file);
      return { token, fileName: path.basename(file) };
    }));
  });

  handle('pdf:parse-picked', async (token, password) => {
    const file = pickedFiles.get(String(token));
    if (!file) return fail('Die Datei ist nicht mehr verfügbar. Bitte nochmal auswählen.');
    const stat = fs.statSync(file);
    if (stat.size > MAX_PDF_BYTES) return fail('Die Datei ist größer als 50 MB. Bitte eine kleinere PDF nehmen.');
    const result = await readDocument(path.basename(file), new Uint8Array(fs.readFileSync(file)), password);
    pickedFiles.delete(String(token));
    return ok(result);
  });

  handle('export:text', async (suggestedName, text) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Speichern unter',
      defaultPath: path.join(app.getPath('documents'), String(suggestedName || 'Konto-Retter.txt')),
      filters: [{ name: 'Textdatei', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return ok(null);
    // BOM, damit der Windows-Editor Umlaute sicher richtig anzeigt.
    fs.writeFileSync(res.filePath, '﻿' + String(text).replace(/\r?\n/g, '\r\n'), 'utf8');
    return ok(res.filePath);
  });

  handle('discord:status', async () => ok(await discord.getStatus()));
  handle('discord:start', async () => discord.start());
  handle('discord:stop', async () => discord.stop());
  handle('discord:mute', async (muted, options) => discord.setMuted(Boolean(muted), options || {}));
  handle('windows:notification-settings', async () => {
    if (process.platform !== 'win32') return fail('Nur unter Windows verfügbar.');
    await shell.openExternal('ms-settings:notifications');
    return ok(true);
  });
}

// Liest eine PDF- oder Textdatei und sucht darin nach Kontodaten.
async function readDocument(fileName, bytes, password) {
  // "%PDF-" darf laut Standard irgendwo in den ersten 1024 Bytes stehen
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  const isPdf = head.includes('%PDF-');
  let text;
  let pages = 0;
  let scanned = false;
  if (isPdf) {
    const res = await pdf.extractText(bytes, { password: password ? String(password) : undefined });
    text = res.text;
    pages = res.pages;
    scanned = res.scanned;
  } else if (/\.(txt|eml)$/i.test(fileName)) {
    text = Buffer.from(bytes).toString('utf8');
  } else {
    const err = new Error('not a pdf');
    err.userMessage = 'Das ist keine PDF-Datei. Bitte eine PDF (oder .txt) hineinziehen.';
    throw err;
  }
  const found = extract.extractFields(text);
  return { fileName, pages, scanned, chars: text.length, text, found };
}
