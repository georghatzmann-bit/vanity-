// =============================================================================
// BuildDuel – Start, Lobby und Spielschleife
// =============================================================================
// Ablauf:
//   1. Ladebildschirm mit echten Schritten (Grafik, Himmel, Lobby, Vorschau-Bilder, erstes Bild)
//   2. Lobby (Hauptmenü): eigene Figur auf dem Podest, Shop, Spind, Einstellungen,
//      Modus wählen (Standard: Kreativ), "SPIELEN"
//      – mit ?mode=… in der Adresse geht es ohne Lobby direkt ins Spiel (Tests/Entwicklung)
//   3. SPIELEN → kurze Blende → Spiel (Game) mit dem Modus → Maus wird gesperrt (Pointer Lock)
//   4. Esc gibt die Maus frei → Pause-Menü (Weiter, Einstellungen, Alles löschen, Zurück zur Lobby)
//   5. Spielschleife:
//        - Logik: immer genau 60-mal pro Sekunde (feste Spiel-Uhr, loop.js);
//          jeder Schritt holt zuerst die Eingabe ab (input.sample) und rechnet dann
//          game.fixedUpdate
//        - Bild: so oft der Browser kann (requestAnimationFrame), Figuren und Kamera
//          weich zwischen zwei Logik-Schritten (alpha)
//        - in der Lobby: nur die Lobby-Bühne (keine Spiel-Logik)
// Zustände: 'loading' → 'lobby' → 'start' → 'playing' ⇄ 'paused' → 'lobby' (ui/menuLogic.js)
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { FixedStepClock } from './loop.js';
import { createCamera } from './camera.js';
import { createEnvironment } from './world/environment.js';
import { createReferenceObjects } from './world/referenceObjects.js';
import { FpsDisplay } from './ui/fpsMeter.js';
import { loadSettings, saveSettings, resolveGraphics } from './core/settings.js';
import { loadProgress, saveProgress, createPlayRewards, equippedItems, catalog } from './core/progress.js';
import { EventBus } from './core/events.js';
import { Input } from './input.js';
import { Game } from './core/game.js';
import { DEFAULT_MODE_ID, getModeDef } from './modes/index.js';
import { createAudio } from './audio/sfx.js';
import { createLobbyScene } from './world/lobbyScene.js';
import { createCosmeticsSystem, pickaxeStyle, emoteMotion } from './world/cosmetics.js';
import { createMenus } from './ui/menus.js';
import { createSettingsWindow } from './ui/settings.js';
import { canTransition, overlayButtons } from './ui/menuLogic.js';

const settings = loadSettings();
const progress = loadProgress();
let quality = resolveGraphics(settings);
const params = new URLSearchParams(location.search);
// Modi, in denen man beim Spielen XP bekommt (pro Minute, pro 100 Bauteile)
const REWARD_MODES = new Set(['creative', 'practice']);

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

// Ladebalken (index.html) weiterschieben
function loadingStep(fraction, text) {
  window.setLoadingProgress?.(fraction, text);
}

// Kurz warten, damit der Browser den Ladebalken malen kann (auch im Hintergrund-Tab)
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 60);
  });
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

// --- 2. Start -------------------------------------------------------------------
async function start() {
  loadingStep(0.32, 'Grafik starten …');
  await nextFrame();
  const container = document.getElementById('game');
  const renderer = createRenderer(container);
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  const scene = new THREE.Scene();
  const camera = createCamera(CONFIG, quality);
  applySize(renderer, camera);

  loadingStep(0.45, 'Himmel und Licht …');
  await nextFrame();
  const environment = createEnvironment(scene, CONFIG, quality);
  if (CONFIG.debug.showReferenceObjects) createReferenceObjects(scene, CONFIG);

  const input = new Input(settings);
  input.attach(canvas);

  const ui = {
    overlay: document.getElementById('play-overlay'),
    title: document.getElementById('play-title'),
    sub: document.getElementById('play-sub'),
    button: document.getElementById('play-button'),
    info: document.querySelector('#play-overlay .play-info'),
    hint: document.getElementById('play-hint'),
    noLock: document.getElementById('play-nolock'),
    actions: document.getElementById('pause-actions'),
    settingsBtn: document.getElementById('pause-settings'),
    clearBtn: document.getElementById('pause-clear'),
    lobbyBtn: document.getElementById('pause-lobby'),
  };

  // Ton für die Menüs (dieselbe Web-Audio-Maschine wie im Spiel; Musik läuft über Spiele hinweg)
  const menuAudio = createAudio({ headless: false, settings, events: new EventBus(), camera: null, player: null, characters: [] });

  // --- Lobby-Bühne + Vorschau-Bilder ---------------------------------------------------------
  loadingStep(0.58, 'Lobby aufbauen …');
  await nextFrame();
  const lobby = createLobbyScene({ scene, camera, renderer, element: canvas });
  lobby.setSkin(equippedItems(progress).skin.id);
  lobby.setVisible(false);

  loadingStep(0.72, 'Figuren und Spitzhacken vorbereiten …');
  await nextFrame();
  // Bilder werden sofort gemalt, das Auslesen läuft im Hintergrund weiter (höchstens kurz warten –
  // fertige Bilder setzt die Lobby später selbst in Spind/Shop ein)
  const thumbsReady = lobby.prepareThumbnails([['skins', catalog('skins')], ['pickaxes', catalog('pickaxes')]])
    .catch((error) => console.error('Vorschau-Bilder konnten nicht gemalt werden:', error));
  await Promise.race([thumbsReady, new Promise((resolve) => setTimeout(resolve, 1500))]);

  const saveP = () => saveProgress(progress);
  const saveS = () => saveSettings(settings);

  // --- Spiel anlegen ----------------------------------------------------------------
  let game = null;
  let currentModeId = null;
  function startMode(id = DEFAULT_MODE_ID, options = {}) {
    if (!getModeDef(id)) {
      console.warn(`Spielmodus "${id}" gibt es nicht – starte "${DEFAULT_MODE_ID}".`);
      id = DEFAULT_MODE_ID;
    }
    if (state === 'lobby') {
      menus.hide();
      lobby.setVisible(false);
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
    const equipped = equippedItems(progress);
    game.startMode(id, { skin: equipped.skin.id, pickaxe: equipped.pickaxe.id, ...options });
    // Spind: Spitzhacken-Farben (nur ohne eigene Spitzhacken-Formen, siehe cosmetics.js) und Emote-Bewegung
    if (game.player) {
      game.player.cosmetics = { pickaxe: pickaxeStyle(equipped.pickaxe.id), emote: emoteMotion(equipped.emote.id) };
    }
    game.systems.push(createCosmeticsSystem(game));
    // XP beim Spielen (Kreativ/Übungsplatz)
    if (REWARD_MODES.has(id)) game.systems.push(createPlayRewards(game, progress, { onChange: saveP }));
    currentModeId = id;
    ui.sub.textContent = getModeDef(id).name;
    clock.reset();
    if (state === 'lobby' || state === 'loading') setState('start');
    else refreshOverlay();
    return game;
  }

  const clock = new FixedStepClock(CONFIG.loop);
  const fpsElement = document.getElementById('fps');
  const fps = fpsElement ? new FpsDisplay(fpsElement) : null;
  if (fpsElement) fpsElement.hidden = !quality.showFps;
  const focus = new THREE.Vector3();

  // --- Zustände: Lobby / Start / Spielen / Pause -------------------------------------------------
  let state = 'loading';
  let manualStep = false; // Tests: Logik nur über buildDuel.simulate()
  let forcedPlay = false; // gespielt ohne Maus-Sperre (Tests, Touch)

  function refreshOverlay() {
    const paused = state === 'paused';
    ui.title.textContent = paused ? 'Pausiert' : CONFIG.game.name;
    ui.button.textContent = paused ? 'Weiter' : 'Klicken zum Spielen';
    ui.info.hidden = paused;
    const buttons = overlayButtons(state, currentModeId);
    ui.actions.hidden = buttons.length === 0;
    ui.clearBtn.hidden = !buttons.includes('clearBuilds');
  }

  function setState(next) {
    if (next !== state && !canTransition(state, next)) {
      console.warn(`Zustand ${state} → ${next} ist nicht vorgesehen.`);
      return false;
    }
    state = next;
    const playing = next === 'playing';
    const inGame = next === 'start' || next === 'playing' || next === 'paused';
    input.playing = playing;
    ui.overlay.hidden = !inGame || playing;
    // Fadenkreuz & Co. zeigt das HUD nur mit body.playing (src/ui/hud.css)
    document.body.classList.toggle('playing', playing);
    document.body.classList.toggle('in-lobby', next === 'lobby');
    if (!playing) {
      input.releaseAll();
      input.exitPointerLock(); // Pause gibt die Maus immer frei
      if (inGame) refreshOverlay();
    } else {
      ui.hint.textContent = '';
      // Was im Pause-Bildschirm gedrückt wurde (Leertaste, C …), zählt nicht im Spiel
      input.clearEdges();
      clock.reset();
    }
    return true;
  }

  function play(options = {}) {
    if (!game) return;
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

  /** Zurück in die Lobby: Spiel aufräumen, Menü zeigen, Musik an. */
  function showLobby() {
    settingsWindow.close();
    game?.dispose();
    game = null;
    currentModeId = null;
    input.releaseAll();
    input.clearEdges();
    ui.hint.textContent = '';
    setState('lobby');
    menus.showLobby();
  }

  /** SPIELEN in der Lobby: Blende, Modus starten, Maus sperren. */
  function playFromLobby(modeId) {
    menus.fade(true);
    setTimeout(() => {
      try {
        startMode(modeId, { botDifficulty: settings.game.botDifficulty });
        // Noch im Zeitfenster des Klicks: Maus-Sperre anfragen (klappt es nicht: Hinweis im Start-Fenster)
        requestPlay();
      } catch (error) {
        fail('Der Modus konnte nicht starten', error);
      } finally {
        setTimeout(() => menus.fade(false), 120);
      }
    }, CONFIG.lobby.transition * 1000);
  }

  let lockFailures = 0; // abgelehnte Maus-Sperren seit der letzten geklappten
  let noLockMode = false; // gerade "ohne Maus-Sperre" gespielt
  input.onLockChange = (locked) => {
    if (locked) {
      if (!game || settingsWindow.isOpen) {
        input.exitPointerLock();
        return;
      }
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
    if (state === 'lobby') return;
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
  // Pause-Menü: diese Knöpfe sollen NICHT weiterspielen (stopPropagation)
  ui.settingsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    menuAudio.ui('click');
    settingsWindow.open();
  });
  ui.clearBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    menuAudio.ui('confirm');
    game?.mode?.clearAll?.();
    ui.hint.textContent = 'Alle Bauteile gelöscht.';
  });
  ui.lobbyBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    menuAudio.ui('back');
    showLobby();
  });
  // Esc pausiert. (Mit Maus-Sperre gibt der Browser die Maus bei Esc selbst frei –
  // dann kommt die Pause über onLockChange. Manche Browser melden die Taste trotzdem.)
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape' && state === 'playing') setState('paused');
  });

  // --- Einstellungen und Menüs ---------------------------------------------------------------
  const settingsWindow = createSettingsWindow({
    root: document.body,
    settings,
    audio: menuAudio,
    onSave: saveS,
    onApply(area) {
      if (area === 'controls') {
        input.applySettings(settings);
        game?.hud?.applySettings?.(settings);
      } else if (area === 'audio') {
        menuAudio.setVolumes(settings);
      } else if (area === 'graphics') {
        // sofort: Auflösung und FPS-Anzeige; Qualität/Sichtweite erst nach dem Neuladen
        const next = resolveGraphics(settings);
        quality = { ...quality, resolutionScale: next.resolutionScale, showFps: next.showFps };
        applySize(renderer, camera);
        if (state === 'lobby') lobby.placeCamera();
        if (fpsElement) fpsElement.hidden = !quality.showFps;
      }
    },
    onClose() {
      if (state === 'lobby') menus.refresh();
    },
  });

  const menus = createMenus({
    root: document.body,
    settings,
    progress,
    lobby,
    audio: menuAudio,
    onPlay: (modeId) => playFromLobby(modeId),
    openSettings: () => settingsWindow.open(),
    isSettingsOpen: () => settingsWindow.isOpen,
    settingsNavigate: (dir) => settingsWindow.navigate(dir),
    saveProgress: saveP,
    saveSettings: saveS,
  });
  menus.hide();

  // --- Fenster ------------------------------------------------------------------------
  window.addEventListener('resize', () => {
    applySize(renderer, camera);
    if (state === 'lobby') lobby.placeCamera();
  });
  // Fenster wandert auf einen Bildschirm mit anderer Windows-Skalierung (z. B.
  // Laptop 150 %, Monitor 100 %). Dann gibt es kein "resize", nur die
  // Pixeldichte ändert sich – darauf extra hören.
  function watchPixelRatio() {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', () => {
      applySize(renderer, camera);
      if (state === 'lobby') lobby.placeCamera();
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
  const lobbyFocus = new THREE.Vector3(0, 0, 0);

  function renderFrame(frameSeconds, steps, alpha) {
    const dt = Math.min(frameSeconds, CONFIG.loop.maxFrameTime);
    if (game && state !== 'lobby') {
      game.frameUpdate(dt, alpha);
      const player = game.player;
      if (player) focus.lerpVectors(player.prevPosition, player.position, alpha);
      environment.update(camera.position, focus);
    } else {
      lobby.frameUpdate(dt);
      environment.update(camera.position, lobbyFocus);
    }
    renderer.render(scene, camera);
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
      menus.frameUpdate();
      if (state === 'playing' && !manualStep && game) {
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
      } else if ((state === 'start' || state === 'paused') && !settingsWindow.isOpen && input.pollPauseButton()) {
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

  // Schnellstart aus der Adresse (?mode=practice) – sonst Lobby
  const quickMode = params.get('mode');
  if (quickMode) {
    loadingStep(0.86, 'Karte erzeugen …');
    await nextFrame();
    startMode(quickMode, {
      botDifficulty: params.get('bots') ?? settings.game.botDifficulty,
      seed: Number(params.get('seed') ?? 1),
    });
  } else {
    loadingStep(0.86, 'Lobby öffnen …');
    await nextFrame();
    setState('lobby');
    menus.showLobby();
  }

  // Für Tests und zum Nachschauen in der Browser-Konsole (F12)
  window.buildDuel = {
    CONFIG,
    settings,
    progress,
    input,
    get quality() {
      return quality;
    },
    renderer,
    scene,
    camera,
    clock,
    lobby,
    menus,
    settingsWindow,
    audio: menuAudio,
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
    /** Neues Spiel mit einem Modus starten (aus der Lobby: Lobby verschwindet). */
    startMode(id, options) {
      return startMode(id, options);
    },
    /** Zurück in die Lobby. */
    showLobby() {
      showLobby();
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
  loadingStep(0.96, 'Erstes Bild …');
  renderFrame(0, 0, 1);
  loadingStep(1, 'Fertig!');
  requestAnimationFrame(frame);
  document.body.classList.add('ready');
  console.info(
    `${CONFIG.game.name} ${CONFIG.game.version} gestartet – Three.js r${THREE.REVISION}, ` +
    `Grafik "${quality.name}", Logik ${CONFIG.loop.tickRate}/s, ${currentModeId ? `Modus "${currentModeId}"` : 'Lobby'}`,
  );
}

start().catch((error) => fail('Das Spiel konnte nicht starten', error));
