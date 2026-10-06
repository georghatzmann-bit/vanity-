// =============================================================================
// Startpunkte suchen (für alle Karten)
// =============================================================================
// findSpawnPoints(game, count, options) würfelt Punkte, die
//   - in einem Bereich liegen (Rechteck oder Kreis),
//   - auf begehbarem Boden sind (nicht im Wasser, nicht zu steil),
//   - nicht in einem Objekt stecken (Haus, Baum, Fels … – mit etwas Luft drumherum),
//   - mindestens minDistance voneinander (und von "avoid"-Punkten) entfernt sind.
// Klappt es nicht mit dem vollen Abstand, wird der Abstand nach und nach kleiner –
// es gibt also immer genug Punkte (solange überhaupt Platz ist).
// =============================================================================
import { CONFIG } from '../config.js';
import { bodyFits } from '../player.js';

/**
 * @param {object} game
 * @param {number} count
 * @param {object} [options]
 *   rng            Zufall (Standard game.rng)
 *   bounds         { minX, maxX, minZ, maxZ }  oder
 *   center, radius Kreis (center = { x, z })
 *   minDistance    Abstand zwischen den Punkten (m)
 *   avoid          Liste von Punkten { x, z }, von denen man minDistance weg bleibt
 *   isValid(x, z, y) → bool   zusätzliche Prüfung (z. B. "nicht im Wasser")
 *   clearance      Luft um die Figur (m)
 *   maxSlopeDeg    steilere Stellen werden übersprungen
 *   tries          Versuche pro Punkt
 *   surface        'ground' (nur Gelände, Standard) | 'any' (auch auf Dächern/Kisten)
 * @returns {Array<{x, y, z}>}
 */
export function findSpawnPoints(game, count, options = {}) {
  const cfg = CONFIG.maps.spawn;
  const rng = options.rng ?? game.rng ?? Math.random;
  const world = game.world;
  const clearance = options.clearance ?? cfg.clearance;
  const tries = options.tries ?? cfg.tries;
  const maxSlope = Math.tan(((options.maxSlopeDeg ?? cfg.maxSlopeDeg) * Math.PI) / 180);
  const radius = CONFIG.player.hitbox.radius + clearance;
  const height = CONFIG.player.hitbox.height + 0.2;
  const avoid = options.avoid ?? [];
  const result = [];
  let minDistance = options.minDistance ?? 0;

  function candidate() {
    if (options.center) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * options.radius;
      return { x: options.center.x + Math.cos(a) * r, z: options.center.z + Math.sin(a) * r };
    }
    const b = options.bounds ?? { minX: -40, maxX: 40, minZ: -40, maxZ: 40 };
    return { x: b.minX + rng() * (b.maxX - b.minX), z: b.minZ + rng() * (b.maxZ - b.minZ) };
  }

  function farEnough(x, z, distance) {
    const d2 = distance * distance;
    for (const p of result) if ((p.x - x) ** 2 + (p.z - z) ** 2 < d2) return false;
    for (const p of avoid) if ((p.x - x) ** 2 + (p.z - z) ** 2 < d2) return false;
    return true;
  }

  while (result.length < count) {
    let found = null;
    for (let t = 0; t < tries && !found; t++) {
      const { x, z } = candidate();
      const point = checkSpawnPoint(world, x, z, { radius, height, maxSlope, surface: options.surface, isValid: options.isValid });
      if (point && farEnough(x, z, minDistance)) found = point;
    }
    if (found) {
      result.push(found);
    } else if (minDistance > 1) {
      minDistance *= 0.75; // zu eng: Abstand etwas kleiner machen
    } else {
      break; // gar kein Platz
    }
  }
  return result;
}

/**
 * Passt eine Figur an (x, z)? Liefert { x, y, z } (y = Boden) oder null.
 * options = { radius, height, maxSlope (tan), surface: 'ground'|'any', isValid }
 */
export function checkSpawnPoint(world, x, z, options = {}) {
  const radius = options.radius ?? CONFIG.player.hitbox.radius + CONFIG.maps.spawn.clearance;
  const height = options.height ?? CONFIG.player.hitbox.height + 0.2;
  const terrain = world.terrain;
  const ground = terrain.heightAt(x, z);
  const y = options.surface === 'any' ? world.surfaceHeight(x, z, ground + 50) : ground;
  if (!Number.isFinite(y)) return null;
  // Steigung (nur Gelände)
  if (options.maxSlope !== undefined && !terrain.isFlat) {
    const e = 0.8;
    const dx = (terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z)) / (2 * e);
    const dz = (terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e)) / (2 * e);
    if (Math.hypot(dx, dz) > options.maxSlope) return null;
  }
  if (options.isValid && !options.isValid(x, z, y)) return null;
  // Körper (mit Luft) darf nirgends drinstecken; etwas über dem Boden prüfen (Hang)
  if (!bodyFits(world, x, y + 0.05, z, radius, height)) return null;
  return { x, y, z };
}
