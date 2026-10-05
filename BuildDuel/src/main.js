// =============================================================================
// BuildDuel – Start und Spielschleife
// =============================================================================
// Ablauf:
//   1. Einstellungen laden, Grafik (Renderer), Szene, Kamera, Himmel/Licht
//   2. Spiel (Game) mit dem Start-Modus anlegen (Übungsplatz, oder ?mode=… in der Adresse)
//   3. "Klicken zum Spielen" → Maus wird gesperrt (Pointer Lock), das Spiel läuft.
//      Esc gibt die Maus frei → "Pausiert – Klicken zum Weiterspielen".
//   4. Spielschleife:
//        - Logik: immer genau 60-mal pro Sekunde (feste Spiel-Uhr, loop.js);
//          jeder Schritt holt zuerst die Eingabe ab (input.sample) und rechnet dann
//          game.fixedUpdate
//        - Bild: so oft der Browser kann (requestAnimationFrame), Figuren und Kamera
//          weich zwischen zwei Logik-Schritten (alpha)
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { FixedStepClock } from './loop.js';
import { createCamera } from './camera.js';
import { createEnvironment } from './world/environment.js';
import { createReferenceObjects } from './world/referenceObjects.js';
import { FpsDisplay } from './ui/fpsMeter.js';
import { loadSettings, resolveGraphics } from './core/settings.js';
import { Input } from './input.js';
import { Game } from './core/game.js';
import { DEFAULT_MODE_ID, getModeDef } from './modes/index.js';

const settings = loadSettings();
const quality = resolveGraphics(settings);
const params = new URLSearchParams(location.search);

// Zeigt eine verständliche Fehlermeldung (Funktion steht in index.html).
// Bei Fehlern mit eigener Erklärung (userFacing) steht unten nur der technische Grund.
function fail(title, error) {
  console.error(title, error);
  if (typeof window.showFatalError !== 'function') return;
  if (error && error.userFacing) {
    const cause = error.cause ? String(error.cause.message || error.cause) : '';
    window.showFatalError(title, { message: error.message, stack: cause });
  } else {
    window.showFatalError(title, error);
  }
}

// --- 1. Grafik ----------------------------------------------------------------
function createRenderer(container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: quality.antialias,
      powerPreference: 'high-performance', // Laptops: lieber die starke Grafikkarte
    });
  } catch (error) {
    const err = new Error(
      'Dein Browser kann gerade keine 3D-Grafik (WebGL) anzeigen. ' +
      'Bitte Chrome, Edge oder Firefox aktualisieren und in den Browser-Einstellungen ' +
      '"Hardwarebeschleunigung verwenden" einschalten.',
    );
    err.cause = error;
    err.userFacing = true;
    throw err;
  }
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  return renderer;
}

function applySize(renderer, camera) {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio) * quality.resolutionScale;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// Tasten-Namen für die Hilfe (deutsch)
const KEY_NAMES = {
  Space: 'Leertaste', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Strg', ControlRight: 'Strg',
  Mouse0: 'Linksklick', Mouse1: 'Mausrad-Klick', Mouse2: 'Rechtsklick',
  WheelUp: 'Mausrad hoch', WheelDown: 'Mausrad runter', Escape: 'Esc', Tab: 'Tab',
};
function keyName(code) {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// --- 2. Start -------------------------------------------------------------------
function start() {
  const container = document.getElementById('game');
  const renderer = createRenderer(container);
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  const scene = new THREE.Scene();
  const camera = createCamera(CONFIG, quality);
  applySize(renderer, camera);
  const environment = createEnvironment(scene, CONFIG, quality);
  if (CONFIG.debug.showReferenceObjects) createReferenceObjects(scene, CONFIG);

  const input = new Input(settings);
  input.attach(canvas);

  const ui = {
    overlay: document.getElementById('play-overlay'),
    title: document.getElementById('play-title'),
    sub: document.getElementById('play-sub'),
    button: document.getElementById('play-button'),
    hint: document.getElementById('play-hint'),
    noLock: document.getElementById('play-nolock'),
    crosshair: document.getElementById('crosshair'),
    help: document.getElementById('help'),
  };

  // --- Spiel anlegen ----------------------------------------------------------------
  let game = null;
  let currentModeId = null;
  function startMode(id = DEFAULT_MODE_ID, options = {}) {
    if (!getModeDef(id)) {
      console.warn(`Spielmodus "${id}" gibt es nicht – starte "${DEFAULT_MODE_ID}".`);
      id = DEFAULT_MODE_ID;
    }
    game?.dispose();
    input.releaseAll();
    input.clearEdges();
    game = new Game({
      scene,
      camera,
      renderer,
      settings,
      headless: false,
      seed: options.seed ?? Number(params.get('seed') ?? 1),
      input,
      uiRoot: document.getElementById('ui'),
    });
    game.startMode(id, options);
    currentModeId = id;
    ui.sub.textContent = getModeDef(id).name;
    clock.reset();
    return game;
  }

  const clock = new FixedStepClock(CONFIG.loop);
  const fpsElement = document.getElementById('fps');
  const fps = quality.showFps && fpsElement ? new FpsDisplay(fpsElement) : null;
  const focus = new THREE.Vector3();

  // --- Spielen / Pause ------------------------------------------------------------------
  // state: 'start' (noch nicht geklickt) | 'playing' | 'paused'
  let state = 'start';
  let manualStep = false; // Tests: Logik nur über buildDuel.simulate()
  let forcedPlay = false; // gespielt ohne Maus-Sperre (Tests, Touch)

  function setState(next) {
    state = next;
    const playing = next === 'playing';
    input.playing = playing;
    ui.overlay.hidden = playing;
    ui.crosshair.hidden = !playing;
    document.body.classList.toggle('playing', playing);
    if (!playing) {
      input.releaseAll();
      input.exitPointerLock(); // Pause gibt die Maus immer frei
      ui.title.textContent = next === 'paused' ? 'Pausiert' : CONFIG.game.name;
      ui.button.textContent = next === 'paused' ? 'Klicken zum Weiterspielen' : 'Klicken zum Spielen';
    } else {
      ui.hint.textContent = '';
      // Was im Pause-Bildschirm gedrückt wurde (Leertaste, C …), zählt nicht im Spiel
      input.clearEdges();
      clock.reset();
    }
  }

  function play(options = {}) {
    forcedPlay = !!options.withoutLock && !input.locked;
    setState('playing');
  }

  function requestPlay() {
    ui.hint.textContent = '';
    // Ohne Maus-Sperre (z. B. Tablet): einfach losspielen
    if (!canvas.requestPointerLock) {
      play({ withoutLock: true });
      return;
    }
    input.requestPointerLock();
  }

  let lockFailures = 0; // abgelehnte Maus-Sperren seit der letzten geklappten
  let noLockMode = false; // gerade "ohne Maus-Sperre" gespielt
  input.onLockChange = (locked) => {
    if (locked) {
      forcedPlay = false;
      lockFailures = 0;
      ui.noLock.hidden = true;
      if (noLockMode) {
        noLockMode = false;
        input.allowMouseWithoutLock = false;
        input.lookWithoutLock = false;
      }
      setState('playing');
    } else if (state === 'playing' && !forcedPlay) {
      setState('paused');
    }
  };
  // Maus-Sperre abgelehnt: Beim ersten Mal ist es meist nur zu früh (Chrome erlaubt
  // nach Esc erst nach ca. 1 Sekunde eine neue Sperre). Klappt es öfter nicht
  // (Browser-Regel, eingebettete Seite …), gibt es einen Weg ohne Sperre.
  input.onLockError = () => {
    lockFailures++;
    if (lockFailures < 2) {
      ui.hint.textContent = 'Die Maus konnte nicht gesperrt werden. Kurz warten und nochmal klicken.';
    } else {
      ui.hint.textContent = 'Klappt es weiterhin nicht? Seite mit F5 neu laden. Hilft das nicht: ' +
        'Chrome oder Edge benutzen – oder unten ohne Maus-Sperre spielen.';
      ui.noLock.hidden = false;
    }
  };
  ui.overlay.addEventListener('click', (event) => {
    event.preventDefault();
    requestPlay();
  });
  // Notlösung: ohne Maus-Sperre spielen (der Mauszeiger bleibt sichtbar)
  ui.noLock.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation(); // nicht noch einmal die Sperre anfordern
    noLockMode = true;
    input.allowMouseWithoutLock = true;
    input.lookWithoutLock = true;
    play({ withoutLock: true });
  });
  // Esc pausiert. (Mit Maus-Sperre gibt der Browser die Maus bei Esc selbst frei –
  // dann kommt die Pause über onLockChange. Manche Browser melden die Taste trotzdem.)
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape' && state === 'playing') setState('paused');
  });

  // Hilfe unten links (vorläufig, bis es das HUD und das Einstellungs-Menü gibt)
  function renderHelp() {
    const kb = settings.controls.keyboard;
    // Tasten-Namen ohne Doppelte (linke und rechte Shift-Taste heißen beide "Shift")
    const names = (codes) => [...new Set(codes.map(keyName))].join(' / ');
    const keys = (action) => names(kb[action] ?? []);
    const crouchKey = settings.controls.crouchOnCtrl ? names(CONFIG.controls.crouchCtrlKeys) : keys('crouch');
    const rows = [
      ['Laufen', [keys('moveForward'), keys('moveLeft'), keys('moveBack'), keys('moveRight')].join(' ')],
      ['Umschauen', 'Maus'],
      ['Springen', keys('jump')],
      ['Ducken', `${crouchKey} (${settings.controls.crouchToggle ? 'umschalten' : 'halten'})`],
    ];
    if (settings.controls.crouchOnCtrl) rows.push(['Sprinten', names(CONFIG.controls.sprintKeysWhenCrouchOnCtrl)]);
    rows.push(['Zielen', keys('secondary')], ['Tanzen', keys('emote')], ['Pause', 'Esc']);
    ui.help.innerHTML = '<div class="help-title">Steuerung</div>' +
      rows.map(([what, key]) => `<div class="help-row"><span>${what}</span><b>${escapeHtml(key)}</b></div>`).join('') +
      '<div class="help-status" data-status></div>' +
      '<div class="help-hint">Übungsplatz: Kisten, Rampen, Turm (Fallschaden), niedrige Decke.</div>';
    ui.status = ui.help.querySelector('[data-status]');
    ui.help.hidden = false;
  }
  renderHelp();

  // Leben/Schild (vorläufig – das richtige HUD kommt in Phase 6)
  let lastStatus = '';
  function updateStatus() {
    const p = game?.player;
    const text = p ? (p.alive ? `Leben ${Math.ceil(p.health)} · Schild ${Math.ceil(p.shield)}` : 'Besiegt – gleich geht\u2019s weiter') : '';
    if (text !== lastStatus) {
      lastStatus = text;
      ui.status.textContent = text;
    }
  }

  // --- Fenster ------------------------------------------------------------------------
  window.addEventListener('resize', () => applySize(renderer, camera));
  // Fenster wandert auf einen Bildschirm mit anderer Windows-Skalierung (z. B.
  // Laptop 150 %, Monitor 100 %). Dann gibt es kein "resize", nur die
  // Pixeldichte ändert sich – darauf extra hören.
  function watchPixelRatio() {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', () => {
      applySize(renderer, camera);
      watchPixelRatio();
    }, { once: true });
  }
  watchPixelRatio();

  // Grafikkarte hat den Zustand verloren (selten, z. B. Treiber-Neustart)
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    fail('Die Grafik wurde zurückgesetzt', Object.assign(new Error('Bitte die Seite neu laden (Taste F5).'), { userFacing: true }));
  });

  // --- 3. Spielschleife -------------------------------------------------------------------
  let frames = 0;
  let lastTime = null;
  let frameErrorShown = false;

  function renderFrame(frameSeconds, steps, alpha) {
    const dt = Math.min(frameSeconds, CONFIG.loop.maxFrameTime);
    game.frameUpdate(dt, alpha);
    const player = game.player;
    if (player) {
      focus.lerpVectors(player.prevPosition, player.position, alpha);
    }
    environment.update(camera.position, focus);
    renderer.render(scene, camera);
    updateStatus();
    frames++;
    fps?.update(frameSeconds, steps);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const frameSeconds = lastTime === null ? 0 : (now - lastTime) / 1000;
    lastTime = now;
    try {
      let steps = 0;
      let alpha = 1;
      if (state === 'playing' && !manualStep) {
        const result = clock.advance(frameSeconds);
        steps = result.steps;
        alpha = result.alpha;
        for (let i = 0; i < steps; i++) {
          game.fixedUpdate(clock.step);
          // Pause-Taste (Controller "Start", ohne Maus-Sperre auch Esc)
          if (game.lastSample?.pressed.pause) {
            setState('paused');
            break;
          }
        }
      } else if (state !== 'playing' && input.pollPauseButton()) {
        // Controller "Start" im Start-/Pause-Bildschirm: weiterspielen (ohne Maus-Sperre –
        // ein Controller-Knopf darf die Maus nicht sperren)
        play({ withoutLock: true });
      }
      renderFrame(frameSeconds, steps, alpha);
    } catch (error) {
      // Nicht still weitermachen: Der erste Fehler kommt in die Fehler-Anzeige.
      if (!frameErrorShown) {
        frameErrorShown = true;
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  // Tab im Hintergrund: Der Browser pausiert requestAnimationFrame. Beim
  // Zurückkommen nicht die ganze verpasste Zeit nachholen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastTime = null;
      clock.reset();
    }
  });

  // Start-Modus aus der Adresse (?mode=practice) oder Übungsplatz
  startMode(params.get('mode') ?? DEFAULT_MODE_ID, {
    botDifficulty: params.get('bots') ?? settings.game.botDifficulty,
    seed: Number(params.get('seed') ?? 1),
  });
  setState('start');

  // Für Tests und zum Nachschauen in der Browser-Konsole (F12)
  window.buildDuel = {
    CONFIG,
    settings,
    input,
    quality,
    renderer,
    scene,
    camera,
    clock,
    get game() {
      return game;
    },
    get state() {
      return state;
    },
    get modeId() {
      return currentModeId;
    },
    get frames() {
      return frames;
    },
    get ticks() {
      return game ? game.tick : 0;
    },
    /** Neues Spiel mit einem Modus starten. */
    startMode(id, options) {
      return startMode(id, options);
    },
    /** Logik direkt rechnen (ohne Bild), z. B. buildDuel.simulate(1) = 1 Sekunde. */
    simulate(seconds) {
      return game.simulate(seconds);
    },
    /** Spielen ohne Maus-Sperre (für Tests). */
    play() {
      play({ withoutLock: true });
    },
    pause() {
      setState('paused');
    },
    /** true = die Spielschleife rechnet keine Logik mehr (nur noch Bilder), Tests rechnen selbst. */
    manualStep(on = true) {
      manualStep = !!on;
      clock.reset();
    },
  };

  // Erstes Bild sofort malen, dann Ladebildschirm ausblenden
  renderFrame(0, 0, 1);
  requestAnimationFrame(frame);
  document.body.classList.add('ready');
  console.info(
    `${CONFIG.game.name} ${CONFIG.game.version} gestartet – Three.js r${THREE.REVISION}, ` +
    `Grafik "${quality.name}", Logik ${CONFIG.loop.tickRate}/s, Modus "${currentModeId}"`,
  );
}

try {
  start();
} catch (error) {
  fail('Das Spiel konnte nicht starten', error);
}
