// =============================================================================
// Kamera
// =============================================================================
// - createCamera:      legt die Three.js-Kamera an
// - OrbitPreview:      Vorschau-Kamera, die sich langsam um einen Punkt dreht
//                      (für Menüs; Maus ziehen = drehen, Mausrad = Zoom)
// - ThirdPersonCamera: Über-die-Schulter-Kamera im Spiel
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createRayHit } from './physics.js';
import { applyMouseLook } from './playerController.js';

/**
 * Erstellt die Kamera mit den Werten aus config.js.
 * @param {object} config   CONFIG
 * @param {object} quality  Grafik-Voreinstellung (für die Sichtweite)
 */
export function createCamera(config, quality) {
  const camera = new THREE.PerspectiveCamera(
    config.camera.fov,
    window.innerWidth / Math.max(1, window.innerHeight),
    config.camera.near,
    quality.viewDistance * 1.1, // etwas weiter als der Himmel (siehe environment.js)
  );
  camera.name = 'Kamera';
  return camera;
}

/**
 * Vorschau-Kamera: kreist langsam um einen Punkt.
 * Maus ziehen (oder Finger) dreht, Mausrad zoomt. Nach 2 Sekunden ohne
 * Eingabe dreht sie sich wieder von selbst.
 */
export class OrbitPreview {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} element  Fläche, die auf die Maus hört (das Spiel-Bild)
   * @param {object} [options]
   */
  constructor(camera, element, options = {}) {
    this.camera = camera;
    this.element = element;
    this.target = options.target ?? new THREE.Vector3(0, 1, 0);
    this.distance = options.distance ?? 14;
    this.minDistance = options.minDistance ?? 4;
    this.maxDistance = options.maxDistance ?? 80;
    this.yaw = options.yaw ?? Math.PI * 0.25; // Drehung um die Hochachse (Radiant)
    this.pitch = options.pitch ?? 0.38; // Neigung nach unten (Radiant)
    this.autoRotateSpeed = options.autoRotateSpeed ?? 0.12;
    this.idleSeconds = 99; // Zeit seit der letzten Eingabe
    this._dragPointer = null;
    this._lastX = 0;
    this._lastY = 0;

    this._onDown = (e) => {
      if (e.button !== 0 || this._dragPointer !== null) return;
      this._dragPointer = e.pointerId;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      element.setPointerCapture?.(e.pointerId);
      this.idleSeconds = 0;
    };
    this._onMove = (e) => {
      if (e.pointerId !== this._dragPointer) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this.yaw -= dx * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.006, 0.05, 1.4);
      this.idleSeconds = 0;
    };
    this._onUp = (e) => {
      if (e.pointerId !== this._dragPointer) return;
      this._dragPointer = null;
      element.releasePointerCapture?.(e.pointerId);
    };
    this._onWheel = (e) => {
      e.preventDefault(); // Seite soll nicht scrollen
      const factor = Math.exp(THREE.MathUtils.clamp(e.deltaY, -200, 200) * 0.001);
      this.distance = THREE.MathUtils.clamp(this.distance * factor, this.minDistance, this.maxDistance);
      this.idleSeconds = 0;
    };

    element.addEventListener('pointerdown', this._onDown);
    element.addEventListener('pointermove', this._onMove);
    element.addEventListener('pointerup', this._onUp);
    element.addEventListener('pointercancel', this._onUp);
    element.addEventListener('wheel', this._onWheel, { passive: false });
    this.update(0);
  }

  /** Jedes Bild aufrufen. @param {number} dt  Zeit seit dem letzten Bild (s) */
  update(dt) {
    this.idleSeconds += dt;
    if (this._dragPointer === null && this.idleSeconds > 2) {
      this.yaw += this.autoRotateSpeed * dt;
    }
    const horizontal = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horizontal,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.target);
  }

  /** Maus-Abfragen wieder entfernen (wenn die Vorschau nicht mehr gebraucht wird). */
  dispose() {
    this.element.removeEventListener('pointerdown', this._onDown);
    this.element.removeEventListener('pointermove', this._onMove);
    this.element.removeEventListener('pointerup', this._onUp);
    this.element.removeEventListener('pointercancel', this._onUp);
    this.element.removeEventListener('wheel', this._onWheel);
  }
}


// =============================================================================
// Über-die-Schulter-Kamera ("Third Person")
// =============================================================================
// Die Kamera dreht sich um einen Punkt im Kopf der Figur ("Drehpunkt",
// 1,6 m über den Füßen, geduckt tiefer). Sie steht 3,2 m dahinter und 0,6 m
// nach rechts versetzt. Beim Zielen (rechte Maustaste) fährt sie auf 1,8 m
// heran und das Sichtfeld wird enger (70° → 55°).
//
// Wand-Schutz: Ein Strahl vom Kopf zur Wunsch-Position der Kamera. Trifft er
// eine Wand, steht die Kamera kurz davor – sie geht nie durch Wände.
//
// Zwei Aufgaben:
//   computeAimRay() – Ziel-Strahl für Schüsse/Bauen. Rechnet NUR mit dem Zustand
//                     der Figur (ohne Glättung) → gleiches Ergebnis bei jeder
//                     Bildrate. Der Strahl beginnt auf Höhe der Figur (nicht an
//                     der Kamera), damit nichts HINTER der Figur getroffen wird.
//   update()        – stellt die echte Kamera für das Bild ein (weich, zwischen
//                     zwei Logik-Schritten interpoliert).
// Das Fadenkreuz ist immer die Bildmitte.
// =============================================================================

const TWO_PI = Math.PI * 2;

/** Winkel weich von a nach b (immer der kürzere Weg herum). */
export function lerpAngle(a, b, t) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

// Glättung unabhängig von der Bildrate: Anteil, der in dt Sekunden geschafft wird
function smoothFactor(rate, dt) {
  return 1 - Math.exp(-rate * Math.max(0, dt));
}

export class ThirdPersonCamera {
  /**
   * @param {THREE.PerspectiveCamera|null} camera  null = nur rechnen (ohne Bild, z. B. in Tests)
   * @param {object} [config]  CONFIG
   */
  constructor(camera = null, config = CONFIG) {
    this.camera = camera;
    this.cfg = config.camera;
    // gemalter Zustand (geglättet)
    this.fov = this.cfg.fov;
    this.distance = this.cfg.distance;
    this.pivotHeight = this.cfg.height;
    this.allowed = this.cfg.distance; // erlaubte Entfernung vom Drehpunkt (Wand-Schutz, geglättet)
    this.yaw = 0;
    this.pitch = 0;
    this.position = new THREE.Vector3();
    this.direction = new THREE.Vector3(0, 0, -1);
    this.characterDistance = this.cfg.distance; // Abstand Kamera ↔ Drehpunkt (zum Ausblenden der Figur)
    this.snapNext = true; // erstes Bild: ohne Glättung

    // Ergebnis der letzten Posen-Rechnung
    this._pivot = new THREE.Vector3();
    this._toCamera = new THREE.Vector3(); // Richtung Drehpunkt → Kamera (Länge 1)
    this._wantedLength = 0; // gewünschte Entfernung
    this._allowedLength = 0; // erlaubte Entfernung (Wand)

    this._fwd = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._hit = createRayHit();
    this._rayOptions = { ignore: null, characters: null, skipTerrain: false };
    this._pending = { x: 0, y: 0 };
    this._look = { yaw: 0, pitch: 0 };
  }

  /** Nach einem Teleport/Rundenstart: nächstes Bild ohne Glättung. */
  snap() {
    this.snapNext = true;
  }

  /**
   * Rechnet die Kamera-Lage (ohne Glättung) und schreibt Position und Blickrichtung.
   * @returns {number} benutzte Entfernung vom Drehpunkt
   */
  computePose(world, fx, fy, fz, yaw, pitch, distance, pivotHeight, outPos, outDir) {
    const cp = Math.cos(pitch);
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    outDir.set(-sinYaw * cp, Math.sin(pitch), -cosYaw * cp);
    const pivot = this._pivot.set(fx, fy + pivotHeight, fz);
    // Wunsch-Position: hinter dem Drehpunkt (gegen die Blickrichtung) + zur rechten Schulter
    const shoulder = this.cfg.shoulderOffset;
    const wx = -outDir.x * distance + cosYaw * shoulder;
    const wy = -outDir.y * distance;
    const wz = -outDir.z * distance - sinYaw * shoulder;
    const length = Math.hypot(wx, wy, wz) || 1e-6;
    this._toCamera.set(wx / length, wy / length, wz / length);
    this._wantedLength = length;
    let allowed = length;
    if (world) {
      const padding = this.cfg.collisionPadding;
      const hit = world.raycast(pivot, this._toCamera, length + padding, this._rayOptions, this._hit);
      if (hit) allowed = Math.max(0, hit.distance - padding);
    }
    this._allowedLength = allowed;
    const used = Math.min(length, allowed);
    outPos.copy(pivot).addScaledVector(this._toCamera, used);
    return used;
  }

  /**
   * Ziel-Strahl für den Logik-Schritt (Schießen, Bauen).
   * Ursprung = Punkt auf dem Kamera-Strahl, der den Augen der Figur am nächsten ist.
   */
  computeAimRay(character, world, outOrigin, outDir, yaw = character.yaw, pitch = character.pitch) {
    const cfg = this.cfg;
    const distance = character.aiming ? cfg.aimDistance : cfg.distance;
    const pivotHeight = character.crouching ? cfg.crouchHeight : cfg.height;
    const p = character.position;
    this.computePose(world, p.x, p.y, p.z, yaw, pitch, distance, pivotHeight, this._camPos, outDir);
    character.eyePosition(this._eye);
    const t = Math.max(0,
      (this._eye.x - this._camPos.x) * outDir.x +
      (this._eye.y - this._camPos.y) * outDir.y +
      (this._eye.z - this._camPos.z) * outDir.z);
    outOrigin.copy(this._camPos).addScaledVector(outDir, t);
    return outOrigin;
  }

  /**
   * Kamera für das Bild einstellen.
   * @param {Character} character
   * @param {number} alpha   0..1 zwischen letztem und aktuellem Logik-Schritt
   * @param {number} dt      Zeit seit dem letzten Bild (s)
   * @param {CollisionWorld} world
   * @param {Input} [input]      für noch nicht verrechnete Maus-Bewegung (sofortige Reaktion)
   * @param {object} [settings]
   */
  update(character, alpha, dt, world, input = null, settings = null) {
    if (!character) return;
    const cfg = this.cfg;
    const snap = this.snapNext;
    this.snapNext = false;

    // Position zwischen zwei Logik-Schritten (+ weiche Stufe)
    const a = character.prevPosition;
    const b = character.position;
    const fx = a.x + (b.x - a.x) * alpha;
    const fz = a.z + (b.z - a.z) * alpha;
    const fy = a.y + (b.y - a.y) * alpha +
      character.prevStepOffset + (character.stepOffset - character.prevStepOffset) * alpha;

    // Blick: Maus sofort (letzter Logik-Stand + noch nicht verrechnete Bewegung),
    // Controller-Stick weich zwischen zwei Logik-Schritten
    if (input && settings && character.alive && input.device !== 'gamepad') {
      input.peekLook(this._pending);
      applyMouseLook(character, settings, this._pending.x, this._pending.y, character.yaw, character.pitch, this._look);
      this.yaw = this._look.yaw;
      this.pitch = this._look.pitch;
    } else {
      this.yaw = lerpAngle(character.prevYaw, character.yaw, alpha);
      this.pitch = character.prevPitch + (character.pitch - character.prevPitch) * alpha;
    }

    // Glätten: Zielen-Entfernung, Sichtfeld, Duck-Höhe
    const targetDistance = character.aiming ? cfg.aimDistance : cfg.distance;
    const targetFov = character.scopeFov ?? (character.aiming ? cfg.aimFov : cfg.fov);
    const targetPivot = character.crouching ? cfg.crouchHeight : cfg.height;
    if (snap) {
      this.distance = targetDistance;
      this.fov = targetFov;
      this.pivotHeight = targetPivot;
    } else {
      this.distance += (targetDistance - this.distance) * smoothFactor(cfg.aimZoomSpeed, dt);
      this.fov += (targetFov - this.fov) * smoothFactor(cfg.fovChangeSpeed, dt);
      this.pivotHeight += (targetPivot - this.pivotHeight) * smoothFactor(cfg.crouchSmoothing, dt);
    }

    this.computePose(world, fx, fy, fz, this.yaw, this.pitch, this.distance, this.pivotHeight, this.position, this.direction);
    // Wand-Schutz: an ein Hindernis heran sofort, wieder weg langsam (kein Ruckeln)
    const allowed = this._allowedLength;
    if (snap || allowed < this.allowed) this.allowed = allowed;
    else this.allowed += (allowed - this.allowed) * smoothFactor(cfg.collisionReturnSpeed, dt);
    const used = Math.min(this._wantedLength, this.allowed);
    this.position.copy(this._pivot).addScaledVector(this._toCamera, used);
    this.characterDistance = used;

    const camera = this.camera;
    if (!camera) return;
    camera.position.copy(this.position);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }
}
