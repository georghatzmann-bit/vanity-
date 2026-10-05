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
// Die Kamera hängt an einem "Arm" aus zwei Teilen:
//   1. vom Kopf der Figur ("Drehpunkt", 1,6 m über den Füßen, geduckt tiefer)
//      0,6 m zur Seite → "Schulter-Punkt" rechts neben dem Kopf
//   2. vom Schulter-Punkt 3,2 m nach hinten (genau gegen die Blickrichtung).
//      Beim Zielen (rechte Maustaste) nur 1,8 m, und das Sichtfeld wird enger.
// Das Fadenkreuz (Bildmitte) zielt also immer entlang einer Linie durch den
// Schulter-Punkt. Steht hinten eine Wand, wird nur Teil 2 kürzer – die Linie
// bleibt gleich, und der Kopf der Figur rutscht nicht vor das Fadenkreuz.
//
// Wand-Schutz: Die Kamera ist eine kleine Box (CONFIG.camera.probeRadius, größer
// als die Ecken der Bild-Nahgrenze). Sie kommt nie so nah an eine Wand, dass man
// hindurchsehen könnte – auch nicht, wenn sie parallel an einer Wand entlang
// schaut oder in einer Ecke steht. Wand rechts neben dem Kopf → Teil 1 wird
// kürzer (und die eigene Figur wird ausgeblendet, wenn sie sonst das
// Fadenkreuz verdecken würde).
//
// Aufgaben:
//   fixedUpdate()   – einmal pro Logik-Schritt: Duck-Höhe und Schulter-Abstand
//                     (beides geglättet) für Bild UND Ziel-Strahl gleich.
//   computeAimRay() – Ziel-Strahl für Schüsse/Bauen: genau die Fadenkreuz-Linie.
//                     Er beginnt am Schulter-Punkt (neben dem Kopf, nie hinter
//                     einer Wand), damit nichts HINTER der Figur getroffen wird.
//   update()        – stellt die echte Kamera für das Bild ein (weich, zwischen
//                     zwei Logik-Schritten interpoliert). Zoom, Sichtfeld und das
//                     Zurückfahren nach einer Wand verschieben die Kamera nur
//                     ENTLANG der Linie – das Fadenkreuz bleibt auf dem Ziel-Strahl.
// =============================================================================

const TWO_PI = Math.PI * 2;
const SEARCH_STEPS = 12; // so oft halbieren beim Suchen der freien Kamera-Stelle

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

/**
 * Abstand von der Kamera zu den Ecken ihrer Bild-Nahgrenze ("near plane").
 * So groß muss der Wand-Abstand mindestens sein, sonst sieht man durch die Wand.
 */
export function nearPlaneCornerDistance(near, fovDeg, aspect) {
  const t = Math.tan((fovDeg * Math.PI) / 360);
  return near * Math.sqrt(1 + t * t * (1 + aspect * aspect));
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
    this.distance = this.cfg.distance; // gewünschte Länge nach hinten (Zielen: kürzer)
    this.pivotHeight = this.cfg.height;
    this.allowed = this.cfg.distance; // erlaubte Länge nach hinten (Wand-Schutz, geglättet)
    this.side = this.cfg.shoulderOffset; // Abstand Kopf → Schulter-Punkt im Bild
    this.yaw = 0;
    this.pitch = 0;
    this.position = new THREE.Vector3();
    this.direction = new THREE.Vector3(0, 0, -1);
    this.characterDistance = this.cfg.distance; // Abstand Kamera ↔ Kopf der Figur
    this.hideCharacter = false; // eigene Figur ausblenden (zu nah oder sie verdeckt das Fadenkreuz)
    this.snapNext = true; // erstes Bild: ohne Glättung

    // Zustand aus dem Logik-Schritt (fixedUpdate) – gleich für Bild und Ziel-Strahl
    this._tickPivot = this.cfg.height;
    this._prevTickPivot = this.cfg.height;
    this._tickSide = this.cfg.shoulderOffset;
    this._prevTickSide = this.cfg.shoulderOffset;
    this._tickSnap = true;
    this._ticked = false; // lief fixedUpdate schon? (sonst direkt aus dem Zustand der Figur)
    this._tickPos = new THREE.Vector3();
    this._renderPos = new THREE.Vector3();
    this._hasRenderPos = false;

    // Ergebnis der letzten Posen-Rechnung
    this._head = new THREE.Vector3(); // Drehpunkt (Kopf)
    this._pivot = new THREE.Vector3(); // Schulter-Punkt (Start von Teil 2)
    this._toCamera = new THREE.Vector3(); // Richtung Schulter-Punkt → Kamera (Länge 1)
    this._right = new THREE.Vector3();
    this._wantedLength = 0; // gewünschte Länge nach hinten
    this._allowedLength = 0; // erlaubte Länge nach hinten (Wand)

    this._eye = new THREE.Vector3();
    this._probeMin = new THREE.Vector3();
    this._probeMax = new THREE.Vector3();
    this._hit = createRayHit();
    this._rayOptions = { ignore: null, characters: null, skipTerrain: false };
    this._pending = { x: 0, y: 0 };
    this._look = { yaw: 0, pitch: 0 };
  }

  /** Nach einem Teleport/Rundenstart: nächstes Bild und nächster Logik-Schritt ohne Glättung. */
  snap() {
    this.snapNext = true;
    this._tickSnap = true;
  }

  // ---------------------------------------------------------------------------
  // Wand-Schutz (Hilfen)
  // ---------------------------------------------------------------------------

  /** Ist an dieser Stelle eine Box mit "Radius" m frei (keine Collider, über dem Gelände)? */
  isFree(world, x, y, z, m) {
    if (!world) return true;
    if (y - m < world.terrain.heightAt(x, z)) return false;
    this._probeMin.set(x - m, y - m, z - m);
    this._probeMax.set(x + m, y + m, z + m);
    return !world.boxBlocked(this._probeMin, this._probeMax);
  }

  // Größte freie Länge t in [0, length] auf der Linie start + dir * t (start gilt als frei)
  _freeLength(world, start, dir, length, m) {
    if (length <= 0 || this.isFree(world, start.x + dir.x * length, start.y + dir.y * length, start.z + dir.z * length, m)) {
      return Math.max(0, length);
    }
    let lo = 0;
    let hi = length;
    for (let i = 0; i < SEARCH_STEPS; i++) {
      const mid = (lo + hi) * 0.5;
      if (this.isFree(world, start.x + dir.x * mid, start.y + dir.y * mid, start.z + dir.z * mid, m)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Teil 1 des Arms: Wie weit darf der Schulter-Punkt neben dem Kopf liegen?
   * (Wand rechts → weniger als shoulderOffset.) Schreibt nichts außer Hilfs-Vektoren.
   */
  shoulderSide(world, hx, hy, hz, yaw) {
    const want = this.cfg.shoulderOffset;
    if (!world) return want;
    const m = this.cfg.probeRadius;
    const right = this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const head = this._head.set(hx, hy, hz);
    let side = want;
    const hit = world.raycast(head, right, want + m, this._rayOptions, this._hit);
    if (hit) side = Math.max(0, hit.distance - m);
    // Box-Prüfung: fängt Kanten (z. B. Mauer-Oberkante), an denen der dünne Strahl vorbeigeht
    return this._freeLength(world, head, right, side, m);
  }

  /**
   * Rechnet die Kamera-Lage (ohne Glättung) und schreibt Position und Blickrichtung.
   * @param {number|null} [side]   Abstand Kopf → Schulter-Punkt (null = selbst ausrechnen)
   * @param {number} [probe]       Wand-Abstand der Kamera (Standard: CONFIG.camera.probeRadius)
   * @returns {number} benutzte Länge nach hinten (vom Schulter-Punkt)
   */
  computePose(world, fx, fy, fz, yaw, pitch, distance, pivotHeight, outPos, outDir, side = null, probe = this.cfg.probeRadius) {
    const cp = Math.cos(pitch);
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    outDir.set(-sinYaw * cp, Math.sin(pitch), -cosYaw * cp);
    if (side === null) side = this.shoulderSide(world, fx, fy + pivotHeight, fz, yaw);
    this._head.set(fx, fy + pivotHeight, fz);
    const pivot = this._pivot.set(fx + cosYaw * side, fy + pivotHeight, fz - sinYaw * side);
    this._toCamera.set(-outDir.x, -outDir.y, -outDir.z);
    const length = Math.max(0, distance);
    let allowed = length;
    if (world) {
      // Teil 2: Strahl vom Schulter-Punkt nach hinten
      const padding = this.cfg.collisionPadding;
      const hit = world.raycast(pivot, this._toCamera, length + padding, this._rayOptions, this._hit);
      if (hit) {
        // Abstand senkrecht zur getroffenen Fläche einhalten (auch bei schrägem Strahl)
        const cos = Math.abs(this._toCamera.dot(hit.normal));
        allowed = Math.max(0, hit.distance - padding / Math.max(cos, 0.25));
      }
      // Box-Prüfung: Wand neben/über der Kamera (Strahl läuft parallel dran vorbei, Ecken)
      allowed = this._freeLength(world, pivot, this._toCamera, Math.min(length, allowed), probe);
    }
    this.side = side;
    this._wantedLength = length;
    this._allowedLength = allowed;
    const used = Math.min(length, allowed);
    outPos.copy(pivot).addScaledVector(this._toCamera, used);
    return used;
  }

  // ---------------------------------------------------------------------------
  // Logik-Schritt
  // ---------------------------------------------------------------------------

  /**
   * Einmal pro Logik-Schritt (nach der Bewegung des Spielers): Duck-Höhe und
   * Schulter-Abstand weiterrechnen. Bild und Ziel-Strahl benutzen beide diese Werte.
   */
  fixedUpdate(character, dt, world) {
    const cfg = this.cfg;
    const p = character.position;
    // weiter als 3 m in einem Schritt = Teleport (Wiederbeleben, Runden-Start) → nicht glätten
    const snap = this._tickSnap || !this._ticked || this._tickPos.distanceToSquared(p) > 9;
    this._tickSnap = false;
    this._tickPos.copy(p);
    const targetPivot = character.crouching ? cfg.crouchHeight : cfg.height;
    this._prevTickPivot = snap ? targetPivot : this._tickPivot;
    this._tickPivot = snap ? targetPivot
      : this._tickPivot + (targetPivot - this._tickPivot) * smoothFactor(cfg.crouchSmoothing, dt);
    // Schulter: an eine Wand heran sofort, wieder weg langsam (kein seitliches Springen)
    const raw = this.shoulderSide(world, p.x, p.y + this._tickPivot, p.z, character.yaw);
    this._prevTickSide = snap ? raw : this._tickSide;
    if (snap || raw < this._tickSide) this._tickSide = raw;
    else this._tickSide += (raw - this._tickSide) * smoothFactor(cfg.collisionReturnSpeed, dt);
    this._ticked = true;
  }

  // Duck-Höhe für das Bild bzw. die Logik (alpha = 1: Stand des letzten Logik-Schritts)
  _pivotHeightFor(character, alpha) {
    if (!this._ticked) return character.crouching ? this.cfg.crouchHeight : this.cfg.height;
    return this._prevTickPivot + (this._tickPivot - this._prevTickPivot) * alpha;
  }

  _sideFor(alpha) {
    if (!this._ticked) return this.cfg.shoulderOffset;
    return this._prevTickSide + (this._tickSide - this._prevTickSide) * alpha;
  }

  /**
   * Ziel-Strahl für den Logik-Schritt (Schießen, Bauen) = die Fadenkreuz-Linie.
   * Ursprung = Punkt auf der Linie, der den Augen der Figur am nächsten ist
   * (aber nie hinter dem Schulter-Punkt).
   */
  computeAimRay(character, world, outOrigin, outDir, yaw = character.yaw, pitch = character.pitch) {
    const p = character.position;
    const pivotHeight = this._pivotHeightFor(character, 1);
    let side = this._sideFor(1);
    const raw = this.shoulderSide(world, p.x, p.y + pivotHeight, p.z, yaw);
    if (raw < side) side = raw;
    const cp = Math.cos(pitch);
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    outDir.set(-sinYaw * cp, Math.sin(pitch), -cosYaw * cp);
    const sx = p.x + cosYaw * side;
    const sy = p.y + pivotHeight;
    const sz = p.z - sinYaw * side;
    character.eyePosition(this._eye);
    const t = Math.max(0, (this._eye.x - sx) * outDir.x + (this._eye.y - sy) * outDir.y + (this._eye.z - sz) * outDir.z);
    outOrigin.set(sx + outDir.x * t, sy + outDir.y * t, sz + outDir.z * t);
    return outOrigin;
  }

  // ---------------------------------------------------------------------------
  // Bild
  // ---------------------------------------------------------------------------

  // Wand-Abstand für das Bild: mindestens probeRadius, bei breiten Bildschirmen mehr
  _renderProbe() {
    const camera = this.camera;
    const base = this.cfg.probeRadius;
    if (!camera) return base;
    const needed = nearPlaneCornerDistance(camera.near, this.fov, camera.aspect || 1) + 0.02;
    return needed > base ? needed : base;
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

    // Position zwischen zwei Logik-Schritten (+ weiche Stufe)
    const a = character.prevPosition;
    const b = character.position;
    const fx = a.x + (b.x - a.x) * alpha;
    const fz = a.z + (b.z - a.z) * alpha;
    const fy = a.y + (b.y - a.y) * alpha +
      character.prevStepOffset + (character.stepOffset - character.prevStepOffset) * alpha;
    // weiter als 3 m seit dem letzten Bild = Teleport → ohne Glättung
    const teleported = this._hasRenderPos &&
      (this._renderPos.x - fx) ** 2 + (this._renderPos.y - fy) ** 2 + (this._renderPos.z - fz) ** 2 > 9;
    this._renderPos.set(fx, fy, fz);
    this._hasRenderPos = true;
    const snap = this.snapNext || teleported;
    this.snapNext = false;

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

    // Glätten (nur im Bild – verschiebt die Kamera nur entlang der Fadenkreuz-Linie):
    // Zielen-Entfernung und Sichtfeld
    const targetDistance = character.aiming ? cfg.aimDistance : cfg.distance;
    const targetFov = character.scopeFov ?? (character.aiming ? cfg.aimFov : cfg.fov);
    if (snap) {
      this.distance = targetDistance;
      this.fov = targetFov;
    } else {
      this.distance += (targetDistance - this.distance) * smoothFactor(cfg.aimZoomSpeed, dt);
      this.fov += (targetFov - this.fov) * smoothFactor(cfg.fovChangeSpeed, dt);
    }
    // Duck-Höhe und Schulter-Abstand: aus den Logik-Schritten (wie der Ziel-Strahl)
    this.pivotHeight = this._pivotHeightFor(character, alpha);
    let side = this._sideFor(alpha);
    const raw = this.shoulderSide(world, fx, fy + this.pivotHeight, fz, this.yaw);
    if (raw < side) side = raw;

    this.computePose(world, fx, fy, fz, this.yaw, this.pitch, this.distance, this.pivotHeight,
      this.position, this.direction, side, this._renderProbe());
    // Wand-Schutz hinten: an ein Hindernis heran sofort, wieder weg langsam (kein Ruckeln)
    const allowed = this._allowedLength;
    if (snap || allowed < this.allowed) this.allowed = allowed;
    else this.allowed += (allowed - this.allowed) * smoothFactor(cfg.collisionReturnSpeed, dt);
    const used = Math.min(this._wantedLength, this.allowed);
    this.position.copy(this._pivot).addScaledVector(this._toCamera, used);
    this.characterDistance = this.position.distanceTo(this._head);
    // Eigene Figur ausblenden: Kamera zu nah am Kopf, oder der Schulter-Punkt liegt
    // so dicht neben dem Kopf (Wand rechts), dass die Figur das Fadenkreuz verdecken würde
    this.hideCharacter = this.characterDistance < cfg.hideCharacterDistance || side < cfg.hideCharacterSide;

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
