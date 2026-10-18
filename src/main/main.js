'use strict';
// HELIX – Hauptprozess: Fenster, Module, Verbindung zur Oberfläche.

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, shell, screen, session } = require('electron');
const { Router } = require('./router');
const { CoreService } = require('./core/service');
const { SessionTracker } = require('./core/sessions');
const exec = require('./sys/exec');
const processes = require('./sys/processes');
const registry = require('./sys/registry');

app.setName('HELIX');
if (process.platform === 'win32') app.setAppUserModelId('de.helix.tuning');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  const dataDir = process.env.HELIX_DATA_DIR || app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'helix.log');

  function log(level, ...parts) {
    try {
      const st = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
      if (st && st.size > 2 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.alt`);
      fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${parts.join(' ')}\n`);
    } catch { /* Protokoll ist nicht kritisch */ }
  }

  let win = null;
  const emit = (name, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('helix:event', name, payload);
  };

  const core = new CoreService({ dataDir, env: process.env, emit });
  const sessions = new SessionTracker(core);
  const ctx = {
    dataDir,
    env: process.env,
    core,
    sessions,
    emit,
    log,
    exec,
    processes,
    registry,
    electron: { app, dialog, shell, screen, getWindow: () => win },
    toolDir: (id) => path.join(dataDir, 'tools', id),
    onRendererReady: null,
  };

  const router = new Router(ctx);
  for (const m of require('./modules/core')) router.register(m);
  router.register(require('./modules/app'));
  const toolsDir = path.join(__dirname, 'modules', 'tools');
  if (fs.existsSync(toolsDir)) {
    for (const file of fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js')).sort()) {
      try {
        const mod = require(path.join(toolsDir, file));
        for (const m of Array.isArray(mod) ? mod : [mod]) router.register(m);
      } catch (e) {
        log('error', `Tool ${file} konnte nicht geladen werden:`, e.stack || e);
      }
    }
  }

  ipcMain.handle('helix:call', (event, channel, args) => {
    if (!win || event.sender !== win.webContents) return { ok: false, error: { code: 'DENIED', message: 'Nicht erlaubt.' } };
    return router.call(channel, args);
  });

  process.on('uncaughtException', (e) => log('fatal', e.stack || e));
  process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', e && e.stack ? e.stack : e));

  function createWindow() {
    const display = screen.getPrimaryDisplay().workAreaSize;
    win = new BrowserWindow({
      width: Math.min(1440, Math.max(1100, display.width - 80)),
      height: Math.min(900, Math.max(720, display.height - 60)),
      minWidth: 1100,
      minHeight: 720,
      show: false,
      backgroundColor: '#05060a',
      title: 'HELIX',
      icon: path.join(__dirname, '..', 'renderer', 'assets', 'img', 'icon.png'),
      titleBarStyle: 'hidden',
      titleBarOverlay: process.platform === 'win32' ? { color: '#05060a', symbolColor: '#c9cdd8', height: 40 } : false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: true,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { win = null; });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // Nur fürs automatische Testen: Bildschirmfoto speichern und beenden
    const shot = process.env.HELIX_SMOKE_SHOT;
    if (shot) {
      ctx.onRendererReady = () => {
        setTimeout(async () => {
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(shot, img.toPNG());
            log('info', 'smoke screenshot', shot);
          } catch (e) { log('error', 'smoke', e.stack || e); }
          app.quit();
        }, Number(process.env.HELIX_SMOKE_DELAY || 4000));
      };
    }
  }

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['pointerLock', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
    });
    log('info', `HELIX ${app.getVersion()} gestartet`);
    await router.initAll();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { router.disposeAll(); });
}
