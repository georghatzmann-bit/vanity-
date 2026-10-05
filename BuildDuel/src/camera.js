// =============================================================================
// Kamera
// =============================================================================
// Phase 1: Kamera anlegen + Vorschau-Kamera, die sich langsam um die Mitte
//          dreht (mit der Maus ziehen = selbst drehen, Mausrad = Zoom).
// Phase 2: kommt hier die Über-die-Schulter-Kamera dazu.
// =============================================================================
import * as THREE from 'three';

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
