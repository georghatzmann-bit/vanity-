'use strict';
// Hauptprozess des Konto-Retters: öffnet das Fenster und erledigt alles,
// was die Oberfläche aus Sicherheitsgründen nicht selbst darf
// (Dateien speichern, Webseiten öffnen, PDFs lesen, Discord steuern).

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, safeStorage, Menu, screen } = require('electron');

const { createStore } = require('./store');
const { isAllowedUrl } = require('./links');
const pdf = require('./pdf');
const discord = require('./discord');
const epic = require('./epic');
const fields = require('../shared/fields');
const extract = require('../shared/extract');

const MAX_PDF_BYTES = 50 * 1024 * 1024;

const DEFAULT_STATE = {
  version: 1,
  data: fields.emptyData(),
  recovery: { current: null, done: {}, skipped: {}, autoOpen: true, startedAt: null, notes: {} },
  pdf: { imports: [] },
  support: { lang: 'de', variant: 'first', edited: {}, facts: {} },
  discord: { toasts: true, sound: true },
  // effects: null = automatisch (an, außer Windows wünscht weniger Bewegung), true/false = Wahl des Nutzers
  ui: { view: 'recovery', welcomeSeen: false, effects: null },
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
  // Gespeicherte Launcher-Zugänge werden mit Windows-Datenschutz (DPAPI) verschlüsselt abgelegt
  epic.init({
    dataDir: app.getPath('userData'),
    crypto: {
      isAvailable: () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } },
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buf) => safeStorage.decryptString(buf),
    },
  });
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
  // Auf kleinen Bildschirmen (z. B. 1366 x 768) nicht größer als der Bildschirm öffnen
  const area = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1240, area.width),
    height: Math.min(840, area.height),
    minWidth: Math.min(900, area.width),
    minHeight: Math.min(600, area.height),
    show: false,
    backgroundColor: '#07080F',
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
  // Windows fährt herunter oder meldet ab: before-quit kommt dann nicht, also hier Ton zurückgeben
  mainWindow.on('session-end', () => discord.restoreSoundOnSessionEnd());
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
    storeProblem: store.problem(),
  }));

  handle('state:load', () => ok(store.load()));
  handle('state:save', async (state) => {
    if (!state || typeof state !== 'object') return fail('Ungültiger Speicherstand.');
    await store.save(state);
    return ok(true);
  });
  handle('state:reset', () => {
    epic.removeAll(); // "Alle Daten löschen" vergisst auch die gespeicherten Launcher-Zugänge
    return ok(store.reset());
  });

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
      defaultPath: path.join(app.getPath('documents'), path.basename(String(suggestedName || 'Konto-Retter.txt')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')),
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
  handle('windows:security', async () => {
    if (process.platform !== 'win32') return fail('Nur unter Windows verfügbar.');
    await shell.openExternal('windowsdefender://threat/');
    return ok(true);
  });

  // Der Epic Games Launcher legt für jedes Konto, das sich auf diesem PC angemeldet hat,
  // eine Datei an, deren Name die Konto-ID ist (laut Epic-Hilfe).
  handle('epic:find-account-ids', async () => {
    const base = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
    const dir = path.join(base, 'EpicGamesLauncher', 'Saved', 'Data');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return ok({ found: [], dir, launcherFound: false }); }
    const found = names
      .map((n) => /^([0-9a-f]{32})\.dat$/i.exec(n))
      .filter(Boolean)
      .map((m) => {
        let modified = null;
        try { modified = fs.statSync(path.join(dir, m[0])).mtime.toISOString(); } catch (_) { /* egal */ }
        return { id: m[1].toLowerCase(), modified };
      })
      .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    return ok({ found, dir, launcherFound: true });
  });

  // Konten-Schnellwechsel (Epic Games Launcher). Die Oberfläche bekommt den Zugang selbst nie zu sehen.
  handle('epic:accounts:status', async () => ok(await epic.getStatus()));
  handle('epic:accounts:save', async (label) => epic.saveCurrent(String(label || '')));
  handle('epic:accounts:switch', async (id) => epic.switchTo(String(id || '')));
  handle('epic:accounts:remove', async (id) => epic.remove(String(id || '')));
  handle('epic:accounts:rename', async (id, label) => epic.rename(String(id || ''), String(label || '')));
  handle('epic:accounts:close-launcher', async () => epic.closeLauncher());

  handle('windows:notification-settings', async () => {
    if (process.platform !== 'win32') return fail('Nur unter Windows verfügbar.');
    await shell.openExternal('ms-settings:notifications');
    return ok(true);
  });
}

// Textdateien: UTF-8 oder UTF-16 (Windows-Editor), gespeicherte Mails oft "quoted-printable".
function decodeTextFile(buf) {
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
  else {
    text = buf.toString('utf8');
    // Kein gültiges UTF-8 (viele Ersatzzeichen)? Dann ist es vermutlich Windows-1252.
    if ((text.match(/\uFFFD/g) || []).length > 3) text = buf.toString('latin1');
  }
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(text)) {
    text = text.replace(/=\r?\n/g, '').replace(/((?:=[0-9A-F]{2})+)/gi, (m) => {
      const bytes = Buffer.from(m.split('=').filter(Boolean).map((h) => parseInt(h, 16)));
      return bytes.toString('utf8');
    });
  }
  return text;
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
    text = decodeTextFile(Buffer.from(bytes));
  } else {
    const err = new Error('not a pdf');
    err.userMessage = 'Das ist keine PDF-Datei. Bitte eine PDF (oder .txt) hineinziehen.';
    throw err;
  }
  const found = extract.extractFields(text);
  return { fileName, pages, scanned, chars: text.length, text, found };
}
