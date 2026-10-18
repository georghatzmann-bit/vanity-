'use strict';
// HELIX – Hauptprozess: Fenster, Module, Verbindung zur Oberfläche.

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, shell, screen, session, Tray, Menu, nativeImage, Notification } = require('electron');
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
  let showWindowRef = () => {};
  const emit = (name, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('helix:event', name, payload);
    // Cloud-Warnung auch dann zeigen, wenn HELIX im Hintergrund ist (Infobereich, minimiert, anderes Fenster vorn)
    if (name === 'drift' && (!win || !win.isVisible() || win.isMinimized() || !win.isFocused())) notifyDrift(payload);
  };

  function notifyDrift(d) {
    try {
      const files = (d?.changed || []).map((c) => c.label || c.rel).slice(0, 2).join(', ');
      if (Notification.isSupported()) {
        const n = new Notification({
          title: 'HELIX: Einstellungen wurden verändert',
          body: `Fortnite hat nach dem Anwenden von „${d?.profileName || 'Profil'}“ etwas geändert${files ? `: ${files}` : ''}. Klicke hier für Details.`,
          icon: path.join(__dirname, '..', 'renderer', 'assets', 'img', 'icon.png'),
        });
        n.on('click', () => showWindowRef());
        n.show();
      }
      if (win && !win.isDestroyed() && win.isVisible()) win.flashFrame(true);
    } catch (e) { log('error', 'notify', e.message); }
  }

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

  // ---------- Infobereich: HELIX läuft auf Wunsch weiter (Spielzeit, Cloud-Wächter) ----------
  const testMode = !!(process.env.HELIX_NO_INTRO || process.env.HELIX_SMOKE_SHOT);
  let tray = null;
  let quitting = false;

  function showWindow() {
    if (!win) { createWindow(); return; }
    win.flashFrame(false);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  showWindowRef = () => showWindow();

  function ensureTray() {
    if (tray) return tray;
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'assets', 'img', 'icon.png')).resize({ width: 32, height: 32 });
    tray = new Tray(img);
    tray.setToolTip('HELIX – läuft im Hintergrund');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'HELIX öffnen', click: showWindow },
      { type: 'separator' },
      { label: 'HELIX beenden', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
    return tray;
  }

  async function closeToTrayWanted() {
    if (testMode) return false;
    const s = await core.readState('app', {}).catch(() => ({}));
    return s.closeToTray !== false;
  }

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
    let trayDecided = false;
    win.on('close', (e) => {
      if (quitting || trayDecided) return;
      e.preventDefault();
      closeToTrayWanted().then(async (toTray) => {
        if (!win) return;
        if (!toTray) {
          // Infobereich wurde ausgeschaltet: Symbol entfernen, damit HELIX wirklich beendet wird
          if (tray) { tray.destroy(); tray = null; }
          trayDecided = true;
          win.close();
          return;
        }
        win.hide();
        ensureTray();
        const st = await core.readState('app', {}).catch(() => ({}));
        if (!st.trayHintShown && process.platform === 'win32') {
          tray.displayBalloon({
            title: 'HELIX läuft weiter',
            content: 'HELIX zählt deine Spielzeit und passt auf deine Einstellungen auf. Beenden: Rechtsklick auf das HELIX-Symbol unten rechts.',
            iconType: 'info',
          });
          await core.writeState('app', { ...st, trayHintShown: true }).catch(() => {});
        }
      });
    });
    // Windows wird heruntergefahren / abgemeldet: nie aufhalten
    win.on('session-end', () => { quitting = true; });
    win.on('closed', () => { win = null; });
    // HELIX_NO_INTRO=1 (automatische Tests): ohne Intro-Clip starten
    const query = process.env.HELIX_NO_INTRO ? { nointro: '1' } : undefined;
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), query ? { query } : undefined);

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

  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    const allowed = ['pointerLock', 'fullscreen', 'clipboard-sanitized-write'];
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.includes(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
    log('info', `HELIX ${app.getVersion()} gestartet`);
    await router.initAll();
    createWindow();
  });

  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  app.on('before-quit', () => { quitting = true; router.disposeAll(); });
}
