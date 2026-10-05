// =============================================================================
// BuildDuel – Start und Spielschleife
// =============================================================================
// Ablauf:
//   1. Grafik (Renderer), Szene und Kamera anlegen
//   2. Welt bauen (Phase 1: Himmel, Licht, Boden, Maßstab-Objekte)
//   3. Spielschleife starten:
//        - Logik: immer genau 60-mal pro Sekunde (feste Spiel-Uhr, loop.js)
//        - Bild:  so oft der Browser kann (requestAnimationFrame)
// =============================================================================
import * as THREE from 'three';
import { CONFIG, getQualityPreset } from './config.js';
import { FixedStepClock } from './loop.js';
import { createCamera, OrbitPreview } from './camera.js';
import { createEnvironment } from './world/environment.js';
import { createArena } from './world/mapArena.js';
import { createReferenceObjects } from './world/referenceObjects.js';
import { FpsDisplay } from './ui/fpsMeter.js';

const quality = getQualityPreset();

// Zeigt eine verständliche Fehlermeldung (Funktion steht in index.html).
function fail(title, error) {
  console.error(title, error);
  if (typeof window.showFatalError === 'function') {
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

// --- 2. Welt ------------------------------------------------------------------
function start() {
  const container = document.getElementById('game');
  const renderer = createRenderer(container);
  const scene = new THREE.Scene();
  const camera = createCamera(CONFIG, quality);
  applySize(renderer, camera);

  const environment = createEnvironment(scene, CONFIG, quality);
  createArena(scene, renderer, CONFIG);
  if (CONFIG.debug.showReferenceObjects) createReferenceObjects(scene, CONFIG);

  // Vorschau-Kamera startet auf der Sonnenseite (dann ist die Figur hell)
  const half = CONFIG.world.gridCellSize / 2;
  const sunDir = CONFIG.visuals.sunDirection;
  const preview = new OrbitPreview(camera, renderer.domElement, {
    target: new THREE.Vector3(half, 1.2, half),
    yaw: Math.atan2(sunDir.x, sunDir.z) + 0.6,
    autoRotateSpeed: CONFIG.debug.previewOrbitSpeed,
  });

  const clock = new FixedStepClock(CONFIG.loop);
  const fpsElement = document.getElementById('fps');
  const fps = CONFIG.graphics.showFps && fpsElement ? new FpsDisplay(fpsElement) : null;
  const focus = new THREE.Vector3(0, 0, 0); // Phase 1: Schatten rund um die Mitte

  // Fenstergröße ändert sich (oder Fenster wandert auf einen anderen Bildschirm)
  window.addEventListener('resize', () => applySize(renderer, camera));

  // Grafikkarte hat den Zustand verloren (selten, z. B. Treiber-Neustart)
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    fail('Die Grafik wurde zurückgesetzt', new Error('Bitte die Seite neu laden (Taste F5).'));
  });

  // Für Tests und zum Nachschauen in der Browser-Konsole (F12)
  const game = { CONFIG, quality, renderer, scene, camera, clock, ticks: 0, frames: 0 };
  window.buildDuel = game;

  // --- Logik-Schritt (immer 1/60 s) ---------------------------------------------
  // Phase 1 hat noch keine Spiel-Logik. Ab Phase 2 bewegt sich hier der Spieler.
  function fixedUpdate(/* stepSeconds */) {
    game.ticks++;
  }

  // --- Bild malen -----------------------------------------------------------------
  function render(frameSeconds /* , alpha */) {
    preview.update(frameSeconds);
    environment.update(camera.position, focus);
    renderer.render(scene, camera);
    game.frames++;
  }

  // --- 3. Spielschleife -----------------------------------------------------------
  let lastTime = null;
  function frame(now) {
    requestAnimationFrame(frame);
    const frameSeconds = lastTime === null ? 0 : (now - lastTime) / 1000;
    lastTime = now;

    const { steps, alpha } = clock.advance(frameSeconds);
    for (let i = 0; i < steps; i++) fixedUpdate(clock.step);
    render(Math.min(frameSeconds, CONFIG.loop.maxFrameTime), alpha);
    fps?.update(frameSeconds, steps);
  }

  // Tab im Hintergrund: Der Browser pausiert requestAnimationFrame. Beim
  // Zurückkommen nicht die ganze verpasste Zeit nachholen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastTime = null;
      clock.reset();
    }
  });

  // Erstes Bild sofort malen, dann Ladebildschirm ausblenden
  render(0, 0);
  requestAnimationFrame(frame);
  document.body.classList.add('ready');
  console.info(
    `${CONFIG.game.name} ${CONFIG.game.version} gestartet – Three.js r${THREE.REVISION}, ` +
    `Grafik "${CONFIG.graphics.quality}", Logik ${CONFIG.loop.tickRate}/s`,
  );
}

try {
  start();
} catch (error) {
  fail('Das Spiel konnte nicht starten', error);
}
