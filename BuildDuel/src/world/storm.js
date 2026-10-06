// =============================================================================
// Sturm-Zone (Battle Royale, Zone Wars)
// =============================================================================
// Ablauf pro Phase: erst "wait" (warten), dann "shrink" (schrumpfen). Beim Warten
// steht schon fest, wo die NÄCHSTE Zone liegt (nextCenter, nextRadius) – die
// Minimap kann sie gestrichelt zeigen. Beim Schrumpfen wandern Mitte und Radius
// gleichmäßig von der alten zur neuen Zone. Nach der letzten Phase ist der
// Radius 0: draußen ist dann jeder, bis nur noch einer übrig ist.
//
// Regeln:
//   - Die neue Zone liegt immer KOMPLETT in der alten (Zufall mit game.rng).
//   - Battle Royale: der Mittelpunkt wird bevorzugt so gewählt, dass die neue Zone
//     an Land liegt (game.map.isLand). Zone Wars (spec.moving): die Zone wandert
//     deutlich (fast bis an den erlaubten Rand).
//   - Wer draußen ist, nimmt Schaden in festen Schritten (alle
//     CONFIG.stormZone.damageInterval s den Schaden pro Sekunde der Phase).
//     Entscheidung: Wie im Original geht der Sturm-Schaden direkt aufs Leben –
//     der Schild hilft nicht (CONFIG.stormZone.ignoresShield).
//   - Wer noch im Absprung-Fahrzeug sitzt (moveState 'vehicle'), nimmt keinen Schaden.
//
// Ereignis: 'stormPhase' { phase, state: 'wait'|'shrink'|'closed', timeLeft } bei jedem Wechsel.
//
// Grafik (nur mit Bildschirm): lila, halb durchsichtige Wand (Zylinder ohne
// Deckel), von weit weg sichtbar, mit langsam wandernden Schlieren. Ist die
// Kamera draußen, wird das Bild leicht lila (Kugel um die Kamera + lila Nebel).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const _a = new THREE.Vector3();

/**
 * @param {object} game
 * @param {object} spec  z. B. CONFIG.modes.battleRoyale.storm:
 *   { initialRadius, phases: [{ wait, shrink, dps, endRadius }], moving?,
 *     center?: { x, z }, autoStart? (Standard true), isGoodZone?(x, z, r) → bool, baseY? }
 *   Ohne Phasen: "unendlich große" Zone (niemand ist draußen).
 */
export function createStorm(game, spec = {}) {
  const cfg = CONFIG.stormZone;
  const phases = Array.isArray(spec.phases) ? spec.phases : [];
  const rng = typeof game.rng === 'function' ? game.rng : Math.random;
  const startCenter = new THREE.Vector3();
  let startRadius = 0;
  let damageTimer = 0;
  let view = null;

  const mapCenter = spec.center ?? game.map?.center ?? { x: 0, z: 0 };
  const storm = {
    game,
    spec,
    center: new THREE.Vector3(mapCenter.x ?? 0, 0, mapCenter.z ?? 0),
    radius: phases.length ? spec.initialRadius ?? 100 : Infinity,
    nextCenter: new THREE.Vector3(mapCenter.x ?? 0, 0, mapCenter.z ?? 0),
    nextRadius: phases.length ? spec.initialRadius ?? 100 : Infinity,
    phase: 0, // Nummer der Phase (0 = erste)
    phaseCount: phases.length,
    state: phases.length ? 'wait' : 'closed', // 'wait' | 'shrink' | 'closed'
    timeLeft: phases.length ? phases[0].wait : 0, // Sekunden bis zum nächsten Wechsel
    stateDuration: phases.length ? phases[0].wait : 0, // so lange dauert der aktuelle Abschnitt
    damagePerSecond: phases.length ? phases[0].dps : 0,
    paused: spec.autoStart === false, // true = Uhr steht (z. B. bis alle gelandet sind)
    moving: !!spec.moving,

    /** Uhr starten (wenn autoStart: false). */
    start() {
      storm.paused = false;
    },

    /** Ist der Punkt in der Zone? (nur waagerecht gemessen) */
    isInside(pos) {
      if (storm.radius === Infinity) return true;
      const dx = pos.x - storm.center.x;
      const dz = pos.z - storm.center.z;
      return dx * dx + dz * dz <= storm.radius * storm.radius;
    },

    /** Abstand zum Rand: positiv = drinnen, negativ = draußen (m). */
    distanceToEdge(pos) {
      if (storm.radius === Infinity) return Infinity;
      return storm.radius - Math.hypot(pos.x - storm.center.x, pos.z - storm.center.z);
    },

    /** Ein Logik-Schritt: Uhr, Schrumpfen, Schaden. */
    update(dt) {
      if (phases.length === 0 || storm.paused) return;
      advance(dt);
      // Schaden in festen Schritten
      damageTimer += dt;
      const interval = cfg.damageInterval;
      while (damageTimer >= interval - 1e-9) {
        damageTimer -= interval;
        applyStormDamage(storm.damagePerSecond * interval);
      }
    },

    /** Grafik (jedes Bild). */
    frameUpdate(dt) {
      view?.update(dt);
    },

    dispose() {
      view?.dispose();
      view = null;
    },
  };

  // --- Zeit -------------------------------------------------------------------------------
  function emitPhase() {
    game.events?.emit('stormPhase', { phase: storm.phase, state: storm.state, timeLeft: storm.timeLeft });
  }

  function advance(dt) {
    let remaining = dt;
    for (let guard = 0; guard < 100 && remaining > 0 && storm.state !== 'closed'; guard++) {
      if (storm.timeLeft > remaining) {
        storm.timeLeft -= remaining;
        remaining = 0;
      } else {
        remaining -= storm.timeLeft;
        storm.timeLeft = 0;
        nextState();
      }
      if (storm.state === 'shrink') applyShrink();
    }
  }

  function applyShrink() {
    const duration = storm.stateDuration;
    const t = duration > 0 ? Math.min(1, Math.max(0, 1 - storm.timeLeft / duration)) : 1;
    storm.center.lerpVectors(startCenter, storm.nextCenter, t);
    storm.radius = startRadius + (storm.nextRadius - startRadius) * t;
  }

  function nextState() {
    const phase = phases[storm.phase];
    if (storm.state === 'wait') {
      storm.state = 'shrink';
      storm.timeLeft = phase.shrink;
      storm.stateDuration = phase.shrink;
      startCenter.copy(storm.center);
      startRadius = storm.radius;
      emitPhase();
      return;
    }
    // Schrumpfen fertig
    storm.center.copy(storm.nextCenter);
    storm.radius = storm.nextRadius;
    if (storm.phase + 1 >= phases.length) {
      storm.state = 'closed';
      storm.timeLeft = 0;
      storm.stateDuration = 0;
      emitPhase();
      return;
    }
    storm.phase++;
    const next = phases[storm.phase];
    storm.state = 'wait';
    storm.timeLeft = next.wait;
    storm.stateDuration = next.wait;
    storm.damagePerSecond = next.dps;
    chooseNextZone(next.endRadius);
    emitPhase();
  }

  // --- Neue Zone wählen (komplett in der alten) --------------------------------------------
  function landScore(x, z, r) {
    const check = spec.isGoodZone ?? (game.map?.isLand ? (px, pz) => game.map.isLand(px, pz) : null);
    if (!check) return 1;
    if (spec.isGoodZone) return spec.isGoodZone(x, z, r) ? 1 : 0;
    const samples = Math.max(1, cfg.landSamples);
    let good = check(x, z) ? 1 : 0;
    const ring = Math.max(0, r * 0.7);
    for (let i = 1; i < samples; i++) {
      const a = (i / (samples - 1)) * Math.PI * 2;
      if (check(x + Math.cos(a) * ring, z + Math.sin(a) * ring)) good++;
    }
    return good / samples;
  }

  function chooseNextZone(endRadius) {
    const r = Math.max(0, endRadius);
    const maxOffset = Math.max(0, storm.radius - r) * (1 - 1e-9);
    let bestX = storm.center.x;
    let bestZ = storm.center.z;
    let bestScore = -1;
    const tries = Math.max(1, cfg.centerTries);
    for (let t = 0; t < tries; t++) {
      const angle = rng() * Math.PI * 2;
      const distance = storm.moving
        ? maxOffset * (cfg.movingShiftFraction + (1 - cfg.movingShiftFraction) * rng())
        : maxOffset * Math.sqrt(rng());
      const x = storm.center.x + Math.cos(angle) * distance;
      const z = storm.center.z + Math.sin(angle) * distance;
      const score = landScore(x, z, r);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestZ = z;
      }
      if (score >= 1) break;
    }
    storm.nextCenter.set(bestX, 0, bestZ);
    storm.nextRadius = r;
  }

  // --- Schaden -----------------------------------------------------------------------------
  function applyStormDamage(amount) {
    if (!(amount > 0)) return;
    const list = game.characters ?? [];
    // Kopie: Ein Besiegter kann die Liste in einem Ereignis ändern
    const snapshot = list.slice();
    for (const c of snapshot) {
      if (!c.alive || c.moveState === 'vehicle') continue;
      if (storm.isInside(c.position)) continue;
      c.applyDamage(amount, { kind: 'storm', weaponId: 'storm', bypassShield: cfg.ignoresShield, attacker: null });
    }
  }

  // Start: erste Zone festlegen
  if (phases.length) {
    chooseNextZone(phases[0].endRadius);
    emitPhase();
    if (!game.headless && game.root && typeof document !== 'undefined') view = createStormView(game, storm);
  }
  return storm;
}

// =============================================================================
// Grafik
// =============================================================================
function createStormView(game, storm) {
  const cfg = CONFIG.stormZone;
  const color = new THREE.Color(CONFIG.visuals.colors.storm);
  const baseOpacity = CONFIG.visuals.stormOpacity;

  const texture = createStormTexture();
  texture.repeat.set(Math.max(4, Math.round(cfg.wallSegments / 12)), 1);
  const geometry = new THREE.CylinderGeometry(1, 1, 1, cfg.wallSegments, 1, true);
  geometry.translate(0, 0.5, 0);
  const material = new THREE.MeshBasicMaterial({
    color,
    map: texture,
    transparent: true,
    opacity: baseOpacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false, // von weit weg sichtbar
  });
  const wall = new THREE.Mesh(geometry, material);
  wall.name = 'Sturm-Wand';
  wall.renderOrder = 5;
  wall.frustumCulled = false;
  game.root.add(wall);

  // Lila Färbung, wenn die Kamera draußen ist: kleine Kugel um die Kamera (zuletzt gemalt)
  const tintMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: cfg.outsideTint,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const tint = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), tintMaterial);
  tint.name = 'Sturm-Färbung';
  tint.renderOrder = 999;
  tint.frustumCulled = false;
  tint.visible = false;
  game.root.add(tint);

  const fog = game.scene?.fog ?? null;
  const fogOriginal = fog ? fog.color.clone() : null;
  const fogStorm = fog ? fog.color.clone().lerp(color, cfg.outsideFogMix) : null;
  let time = 0;
  let outside = false;

  return {
    update(dt) {
      time += dt;
      const r = storm.radius;
      // Vor dem ersten Schrumpfen deckt die Zone alles ab – dann keine Wand (wie im Original)
      const started = storm.phase > 0 || storm.state !== 'wait';
      const show = started && Number.isFinite(r) && r > 0.3;
      wall.visible = show;
      if (show) {
        wall.position.set(storm.center.x, storm.spec.baseY ?? -30, storm.center.z);
        wall.scale.set(r, cfg.wallHeight, r);
        texture.offset.x = (texture.offset.x + cfg.stripeSpeed * dt) % 1;
        material.opacity = baseOpacity * (1 + cfg.pulseAmount * Math.sin(time * cfg.pulseSpeed));
      }
      const camera = game.camera;
      // Färbung nur, wenn der Spieler draußen wirklich Schaden nehmen kann (nicht im Absprung-Fahrzeug)
      const player = game.player;
      const affected = !player || (player.alive && player.moveState !== 'vehicle');
      const nowOutside = !!camera && affected && Number.isFinite(r) && !storm.isInside(camera.getWorldPosition(_a));
      if (camera) {
        tint.position.copy(_a);
        tint.visible = nowOutside;
      }
      if (fog && nowOutside !== outside) fog.color.copy(nowOutside ? fogStorm : fogOriginal);
      outside = nowOutside;
    },
    dispose() {
      wall.parent?.remove(wall);
      tint.parent?.remove(tint);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      tint.geometry.dispose();
      tintMaterial.dispose();
      if (fog && fogOriginal) fog.color.copy(fogOriginal);
    },
  };
}

// Schlieren-Bild: senkrechte, weiche Streifen; nach oben durchsichtiger
function createStormTexture() {
  const w = 128;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = 1 - y / (h - 1); // 0 unten, 1 oben
    const fade = Math.max(0, 1 - Math.pow(v, 2.2)) * (0.55 + 0.45 * Math.min(1, (1 - v) * 4));
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // nahtlose Streifen (ganze Wellen über die Breite)
      const streak = 0.5 + 0.3 * Math.sin(u * Math.PI * 2 * 2 + v * 3.5) + 0.2 * Math.sin(u * Math.PI * 2 * 5 - v * 6);
      const a = Math.max(0, Math.min(1, (0.72 + 0.28 * streak) * fade));
      const light = 200 + Math.round(55 * streak);
      const i = (y * w + x) * 4;
      image.data[i] = light;
      image.data[i + 1] = light;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}
