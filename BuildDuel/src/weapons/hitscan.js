// =============================================================================
// Treffer-Strahl ("Hitscan") – für Sturmgewehr, MP, Pistole, Schrotflinte, Spitzhacke
// =============================================================================
// So wird ein Schuss geprüft (wie im Plan beschrieben):
//   1. Strahl von der Kamera-Mitte (command.aimOrigin/aimDir = Fadenkreuz-Linie)
//      → was trifft das Fadenkreuz?
//   2. "Mündungs-Prüfung": Ist der Weg von der WAFFE (Augen → Mündung → Treffpunkt)
//      frei? Die Kamera sitzt rechts hinter der Figur und kann um Ecken schauen –
//      die Waffe nicht. Steht etwas im Weg, bekommt DAS den Treffer.
// Der Schütze selbst wird nie getroffen. Teammitglieder (ohne friendlyFire) werden
// durchschossen. Collider mit data.blocksBullets === false lassen Schüsse durch.
//
// Leistung: Keine neuen Objekte pro Schuss (alles wird wiederverwendet).
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRayHit } from '../physics.js';

const W = CONFIG.weapons;

/** Ein leeres Ergebnis (zum Wiederverwenden). */
export function createTraceResult() {
  return {
    hit: false, // etwas getroffen?
    point: new THREE.Vector3(), // Treffpunkt (oder Ende des Strahls)
    normal: new THREE.Vector3(),
    distance: 0, // Abstand Augen → Treffpunkt (für den Schadens-Abfall)
    character: null,
    part: null, // 'head' | 'body'
    collider: null,
    terrain: false,
    blocked: false, // true = die Mündungs-Prüfung hat ein anderes Hindernis gefunden
  };
}

// Collider, die Schüsse durchlassen (z. B. Büsche) – Standard: alles blockiert
function passesBullets(collider) {
  return collider.data?.blocksBullets === false;
}

/**
 * @param {object} game
 */
export function createHitscan(game) {
  const eye = new THREE.Vector3();
  const muzzle = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const end = new THREE.Vector3();
  const camHit = createRayHit();
  const blockHit = createRayHit();
  const targets = [];
  const options = { ignore: passesBullets, characters: targets, ignoreCharacter: null, skipTerrain: false };

  function copyRay(out, hit, eyePos) {
    out.hit = true;
    out.point.copy(hit.point);
    out.normal.copy(hit.normal);
    out.character = hit.character;
    out.part = hit.part;
    out.collider = hit.collider;
    out.terrain = !!hit.terrain;
    out.distance = eyePos.distanceTo(hit.point);
    return out;
  }

  const api = {
    /**
     * Figuren, die dieser Schütze treffen kann (ohne sich selbst, ohne Team bei friendlyFire = false).
     * Liefert ein wiederverwendetes Array.
     */
    targetsFor(shooter) {
      targets.length = 0;
      const list = game.characters;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c === shooter || !c.alive) continue;
        if (!W.friendlyFire && shooter && c.team === shooter.team) continue;
        targets.push(c);
      }
      return targets;
    },

    /** Mündung: Augen + ein Stück nach rechts, vorn, unten (CONFIG.weapons.muzzleOffset). */
    muzzlePosition(shooter, out) {
      shooter.eyePosition(out);
      const m = W.muzzleOffset;
      const sin = Math.sin(shooter.yaw);
      const cos = Math.cos(shooter.yaw);
      // rechts = (cos, 0, −sin), vorwärts = (−sin, 0, −cos)
      out.x += cos * m.right - sin * m.forward;
      out.z += -sin * m.right - cos * m.forward;
      out.y -= m.down;
      return out;
    },

    /**
     * Nur der Kamera-Strahl: Wohin zeigt das Fadenkreuz? (für Geschosse)
     * Schreibt den Punkt in out und liefert true, wenn etwas getroffen wurde.
     */
    aimPoint(shooter, origin, direction, maxRange, out) {
      options.ignoreCharacter = shooter;
      api.targetsFor(shooter);
      const hit = game.world.raycast(origin, direction, maxRange, options, camHit);
      if (hit) out.copy(hit.point);
      else out.copy(origin).addScaledVector(direction, maxRange);
      return !!hit;
    },

    /**
     * Ein Schuss-Strahl mit Mündungs-Prüfung.
     * @param {Character} shooter
     * @param {THREE.Vector3} origin     Start (Kamera-Mitte bzw. Augen bei Bots)
     * @param {THREE.Vector3} direction  Richtung (Länge 1), schon mit Streuung
     * @param {number} maxRange          m
     * @param {object} out               createTraceResult()
     * @returns {object} out (out.hit = false → nichts getroffen, out.point = Ende des Strahls)
     */
    trace(shooter, origin, direction, maxRange, out) {
      const world = game.world;
      options.ignoreCharacter = shooter;
      api.targetsFor(shooter);
      out.hit = false;
      out.blocked = false;
      out.character = null;
      out.part = null;
      out.collider = null;
      out.terrain = false;

      // 1. Was trifft das Fadenkreuz?
      const cam = world.raycast(origin, direction, maxRange, options, camHit);
      if (cam) end.copy(cam.point);
      else end.copy(origin).addScaledVector(direction, maxRange);

      // 2. Mündungs-Prüfung: Augen → Mündung → Treffpunkt
      shooter.eyePosition(eye);
      if (W.muzzleCheck !== false) {
        api.muzzlePosition(shooter, muzzle);
        dir.subVectors(muzzle, eye);
        const toMuzzle = dir.length();
        if (toMuzzle > 1e-6) {
          dir.multiplyScalar(1 / toMuzzle);
          const b1 = world.raycast(eye, dir, toMuzzle, options, blockHit);
          if (b1) {
            out.blocked = true;
            return copyRay(out, b1, eye);
          }
        }
        dir.subVectors(end, muzzle);
        const len = dir.length();
        if (len > 0.05) {
          dir.multiplyScalar(1 / len);
          const b2 = world.raycast(muzzle, dir, len - 0.02, options, blockHit);
          // Dieselbe Figur aus etwas anderem Winkel getroffen → der Kamera-Treffer zählt (Kopf/Körper)
          if (b2 && !(cam && cam.character && b2.character === cam.character)) {
            out.blocked = true;
            return copyRay(out, b2, eye);
          }
        }
      }
      if (cam) return copyRay(out, cam, eye);
      out.point.copy(end);
      out.normal.set(0, 0, 0);
      out.distance = eye.distanceTo(end);
      return out;
    },
  };
  return api;
}

/**
 * Richtung mit Streuung: zufällig in einem Kegel mit dem GANZEN Öffnungswinkel coneDeg
 * (Abweichung also höchstens coneDeg / 2). Gleichmäßig über die Kreisfläche verteilt.
 * @param {THREE.Vector3} direction  Länge 1
 * @param {number} coneDeg
 * @param {() => number} rng  Zufall 0..1
 * @param {THREE.Vector3} out
 */
export function spreadDirection(direction, coneDeg, rng, out) {
  if (!(coneDeg > 0)) return out.copy(direction);
  const half = (coneDeg * Math.PI) / 360;
  const r = half * Math.sqrt(rng());
  const t = rng() * Math.PI * 2;
  // zwei Richtungen senkrecht zum Strahl
  const dx = direction.x;
  const dy = direction.y;
  const dz = direction.z;
  let ux;
  let uy;
  let uz;
  if (Math.abs(dy) < 0.99) {
    // u = dir × oben, normiert
    ux = -dz;
    uy = 0;
    uz = dx;
  } else {
    // u = dir × (1, 0, 0)
    ux = 0;
    uy = dz;
    uz = -dy;
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // v = u × dir
  const vx = uy * dz - uz * dy;
  const vy = uz * dx - ux * dz;
  const vz = ux * dy - uy * dx;
  const s = Math.sin(r);
  const c = Math.cos(r);
  const a = Math.cos(t) * s;
  const b = Math.sin(t) * s;
  out.set(dx * c + ux * a + vx * b, dy * c + uy * a + vy * b, dz * c + uz * a + vz * b);
  return out.normalize();
}
