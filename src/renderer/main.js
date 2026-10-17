// Renderer bootstrap: settings, titlebar, FX, sound, toasts, modals, router, first screen.
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/utilities.css';

import { api, isBrowserMock } from './core/api.js';
import { store, EFFECT_LEVELS } from './core/store.js';
import { router } from './core/router.js';
import { fx } from './core/fx-bridge.js';
import { sound } from './core/sound.js';
import { prefersReducedMotion, onReducedMotionChange, gsap, motionOK } from './core/motion.js';
import { Titlebar } from './components/titlebar.js';
import { createToaster } from './components/toast.js';
import { createModalHost } from './components/modal.js';
import { CursorGlow } from './components/cursorGlow.js';
import { openSettings } from './components/settingsModal.js';

import boot from './screens/boot.js';
import home from './screens/home.js';
import backup from './screens/backup.js';
import restore from './screens/restore.js';
import select from './screens/select.js';
import install from './screens/install.js';
import games from './screens/games.js';
import done from './screens/done.js';

const SCREENS = { boot, home, backup, restore, select, install, games, done };
const params = new URLSearchParams(location.search);

/** ?effects=low / ?sound=0 / ?volume=0.3 – session-only overrides for dev & screenshots. */
function applyUrlOverrides() {
  const patch = {};
  const effects = params.get('effects');
  if (EFFECT_LEVELS.includes(effects)) patch.effects = effects;
  if (params.has('sound')) patch.sound = params.get('sound') !== '0';
  if (params.has('volume')) patch.volume = Number(params.get('volume'));
  if (Object.keys(patch).length) {
    store.setPersistSettings(false);
    store.patch('settings', patch);
  }
}

/** Fills the store with mock data so deep links (?screen=select) render something real. */
async function prepareDevState(screen) {
  if (['select', 'install', 'games', 'done'].includes(screen)) {
    const profile = await api.profile.load('mock');
    store.patch({
      profile,
      machine: profile.machine,
      games: profile.games,
      selection: new Set(profile.apps.map((a) => `${a.source}:${a.id}`)),
    });
  }
  if (screen === 'done') {
    const n = store.get('selection').size;
    store.set('installJob', {
      jobId: 'mock-done',
      summary: { installed: Math.max(0, n - 3), already: 2, failed: 1, skipped: 0, cancelled: 0, rebootRequired: true },
      durationMs: 412000,
    });
  }
}

/**
 * Electron GPU facts (api.app.gpu: app.getGPUFeatureStatus() + app.getGPUInfo('basic')) -> FX gpuHint.
 * A software WebGL path (SwiftShader / WARP / Basic Render) starts the FX on its lightest tier.
 */
function gpuHintFrom(g) {
  if (!g) return null;
  const status = g.featureStatus || {};
  const devices = (g.info && g.info.gpuDevice) || [];
  const dev = devices.find((d) => d && d.active) || devices[0] || null;
  const soft = (v) => typeof v === 'string' && v.includes('software');
  const software =
    soft(status.webgl2) || soft(status.gpu_compositing) || (!!dev && (dev.vendorId === 0x1414 || (dev.vendorId === 0x1ae0 && dev.deviceId === 0xc0de)));
  return { software, vendorId: dev ? dev.vendorId : undefined };
}

async function main() {
  applyUrlOverrides();
  // ?lag=0 (browser mock only): animations follow wall-clock time even at 3 fps, so screenshots
  // taken in software rendering show final states instead of half-finished tweens.
  if (isBrowserMock && params.get('lag') === '0') gsap.ticker.lagSmoothing(0);
  const root = document.documentElement;
  root.dataset.motion = prefersReducedMotion() ? 'reduced' : 'full';
  onReducedMotionChange((reduced) => (root.dataset.motion = reduced ? 'reduced' : 'full'));
  store.subscribe(
    (s) => s.settings.effects,
    (q) => {
      root.dataset.effects = q;
      fx.setQuality(q);
    },
    { immediate: true },
  );

  sound.init(store);

  const appEl = document.getElementById('app');
  const titlebarHost = document.getElementById('titlebar');
  const toast = createToaster(document.getElementById('toast-host'));
  // The titlebar stays usable while a dialog is open (window controls), only the app content is inert.
  const modal = createModalHost(document.getElementById('modal-host'), { inertTargets: [appEl] });

  const ctx = { api, store, fx, sound, toast, modal };
  let settingsHandle = null;
  const showSettings = () => {
    if (settingsHandle) return settingsHandle;
    settingsHandle = openSettings(ctx);
    settingsHandle.closed.then(() => (settingsHandle = null));
    return settingsHandle;
  };
  ctx.openSettings = showSettings;

  const titlebar = Titlebar({ api, store, sound, onSettings: showSettings });
  titlebarHost.append(titlebar);
  ctx.titlebar = titlebar;
  document.body.append(CursorGlow({ store }));

  // FX engine (lazy chunk). The intro mode for the boot screen is 'full'; later launches use the
  // short splash below. gpuHint is a promise – the bridge waits at most 300 ms for it.
  const gpuHint = typeof api.app.gpu === 'function' ? api.app.gpu().then(gpuHintFrom).catch(() => null) : null;
  fx.init(document.getElementById('fx'), {
    quality: store.get('settings').effects,
    reducedMotion: prefersReducedMotion(),
    intro: 'full',
    gpuHint,
    onError: (err) => console.warn('[fx]', err && err.message ? err.message : err),
  });

  router.init({ container: appEl, ctx });
  for (const [name, mod] of Object.entries(SCREENS)) router.register(name, mod);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      showSettings();
    }
  });
  window.addEventListener('unhandledrejection', (e) => console.error('[phoenix] unhandled', e.reason));

  let info;
  try {
    info = await api.app.info();
  } catch (err) {
    console.error('[phoenix] app.info failed', err);
    info = { version: '', firstRun: false, isPackaged: true, mock: false };
  }
  store.set('appInfo', info);
  titlebar.setVersion(info.version);
  if (info.mock) titlebar.setStatus('Testmodus', 'warn');

  const requested = params.get('screen');
  const devLinks = isBrowserMock || info.mock || !info.isPackaged;
  let start = info.firstRun ? 'boot' : 'home';
  if (requested && devLinks && router.has(requested)) {
    start = requested;
    await prepareDevState(start).catch((err) => console.warn('[phoenix] dev state', err));
  }
  if (devLinks) window.__phoenix = { store, router, fx, sound, toast, modal, api };

  // Later launches: the short intro (3.2 s) plays as a splash over the still-empty app; home enters
  // while the logo glides into the titlebar (~2 s). Skippable (click / Esc / Space / Enter); skipped
  // entirely when the engine is not live within 0.9 s, motion is reduced, or effects are off.
  // Deep links (?screen=home) and ?splash=0 skip it too (screenshots, dev).
  const splash = start === 'home' && !info.firstRun && !requested && motionOK() && params.get('splash') !== '0';
  if (splash) await fx.splash('short', { waitMs: 900 }).catch(() => null);

  await router.go(start, {}, { transition: 'fade' });

  if (devLinks && params.get('modal') === 'settings') showSettings();
}

main().catch((err) => {
  console.error('[phoenix] bootstrap failed', err);
  const app = document.getElementById('app');
  if (app) app.innerHTML = '<div style="padding:48px;color:#E8EAF0;font:15px system-ui">PHOENIX konnte nicht starten. Bitte die App neu öffnen.</div>';
});
