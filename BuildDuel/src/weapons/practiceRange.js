// =============================================================================
// Schieß-Stand für den Übungsplatz (Phase 5)
// =============================================================================
// - Der Spieler bekommt alle Waffen (Plätze aus CONFIG.practiceRange.loadoutSlots),
//   Munition und Heil-Items gehen nie aus.
// - "Zielpuppen": stehende Figuren ohne KI auf 5, 15, 30 und 60 m (eine mit Schild).
//   Sie haben viel Leben, sind nach kurzer Pause wieder voll und stehen wieder auf,
//   falls sie doch umfallen. Treffer zeigen Schadenszahlen (weiß/gelb/blau).
// - Ein Baum, ein Fels und ein Auto zum Sammeln mit der Spitzhacke (F).
// - Auch die anderen Übungs-Figuren stehen nach dem Besiegtwerden wieder auf.
// Alle Werte: CONFIG.practiceRange.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const R = CONFIG.practiceRange;

/**
 * @param {object} game
 * @param {object} map  Karte (mapBuilder) – Collider und Grafik hängen daran (dispose räumt ab)
 * @returns {{ equip(character), update(dt), dispose(), dummies: Character[] }}
 */
export function createPracticeRange(game, map) {
  const visual = !game.headless && typeof document !== 'undefined';
  const stand = R.stand;
  const dummies = [];
  const spawns = new Map(); // Figur → { position, yaw, health, shield }
  const respawnAt = new Map(); // Figur → Spielzeit
  const lastHit = new Map(); // Puppe → Spielzeit des letzten Treffers

  // --- Schieß-Stand -------------------------------------------------------------------------
  map.addBox({ x: stand.x - 1.2, y: 0, z: stand.z - 1.2 }, { x: stand.x + 1.2, y: 0.05, z: stand.z + 1.2 }, { color: '#F2C14E', castShadow: false });
  // Schild hoch über der Matte: von weitem gut zu sehen, beim Draufstehen über dem Bild
  map.addLabel('Schieß-Stand: hier stehen', { x: stand.x, y: 4.4, z: stand.z }, { size: 0.45 });

  // --- Zielpuppen ----------------------------------------------------------------------------
  const faceStand = -Math.PI / 2; // Blick nach +X, zum Stand (vorwärts = (−sin, 0, −cos))
  R.dummies.list.forEach((d, i) => {
    const position = { x: stand.x - d.distance, y: 0, z: stand.z + (d.side ?? 0) };
    const shield = d.shield ? R.dummies.shield : 0;
    const dummy = game.addCharacter({
      name: d.shield ? `Zielpuppe ${d.distance} m (Schild)` : `Zielpuppe ${d.distance} m`,
      isBot: true,
      brain: null,
      team: 200 + i,
      skin: { id: 'zielpuppe', name: 'Zielpuppe', ...R.dummies.skin },
      position,
      yaw: faceStand,
      health: R.dummies.health,
      shield,
    });
    dummy.isDummy = true;
    dummies.push(dummy);
    spawns.set(dummy, { position, yaw: faceStand, health: R.dummies.health, shield });
    map.addLabel(d.shield ? `${d.distance} m · Schild` : `${d.distance} m`, { x: position.x, y: 2.55, z: position.z }, { size: 0.45 });
  });

  // --- Sammel-Objekte --------------------------------------------------------------------------
  const H = R.harvest;
  const harvestData = (kind) => ({ kind, harvest: CONFIG.materials.harvestSources[kind] });
  // Baum: Stamm (Kollision) + Krone (nur Grafik)
  map.addBox({ x: H.tree.x - 0.35, y: 0, z: H.tree.z - 0.35 }, { x: H.tree.x + 0.35, y: 3.2, z: H.tree.z + 0.35 }, { color: '#8B5A2B', data: harvestData('tree') });
  // Fels (Kollision als Box, Grafik als kantiger Stein)
  const rock = map.addBox({ x: H.rock.x - 1.1, y: 0, z: H.rock.z - 0.9 }, { x: H.rock.x + 1.1, y: 1.5, z: H.rock.z + 0.9 }, { color: '#8E949C', data: harvestData('rock') });
  // Auto: Unterteil + Kabine
  map.addBox({ x: H.car.x - 2, y: 0, z: H.car.z - 0.9 }, { x: H.car.x + 2, y: 1.05, z: H.car.z + 0.9 }, { color: '#D64545', data: harvestData('car') });
  map.addBox({ x: H.car.x - 1.0, y: 1.05, z: H.car.z - 0.8 }, { x: H.car.x + 1.1, y: 1.75, z: H.car.z + 0.8 }, { color: '#E9EEF4', data: harvestData('car') });
  map.addLabel('Baum → Holz (Spitzhacke: F)', { x: H.tree.x, y: 5.3, z: H.tree.z }, { size: 0.42 });
  map.addLabel('Fels → Stein', { x: H.rock.x, y: 2.4, z: H.rock.z }, { size: 0.42 });
  map.addLabel('Auto → Metall', { x: H.car.x, y: 2.6, z: H.car.z }, { size: 0.42 });
  if (visual) decorate(map, rock, H);

  // --- Ereignisse ----------------------------------------------------------------------------------
  const offDamaged = game.events.on('characterDamaged', ({ character }) => {
    if (character.isDummy) lastHit.set(character, game.time);
  });
  const offKilled = game.events.on('characterKilled', ({ victim }) => {
    if (victim === game.player) return; // Spieler: macht der Übungsplatz selbst
    if (spawns.has(victim)) respawnAt.set(victim, game.time + R.dummies.respawnDelay);
  });

  // andere Übungs-Figuren (ohne KI) merken, damit auch sie wieder aufstehen
  for (const c of game.characters) {
    if (c === game.player || spawns.has(c)) continue;
    spawns.set(c, { position: { x: c.position.x, y: c.position.y, z: c.position.z }, yaw: c.yaw, health: c.health, shield: c.shield });
  }

  return {
    dummies,

    /** Alle Waffen und Heil-Items geben (Munition/Heilen unendlich). */
    equip(character) {
      game.weapons.giveLoadout(character, R.loadoutSlots, {
        infiniteReserve: R.infiniteReserveAmmo,
        infiniteHeals: R.infiniteHeals,
      });
    },

    update() {
      const time = game.time;
      // Puppen: nach kurzer Pause wieder voll
      for (const d of dummies) {
        if (!d.alive) continue;
        const t = lastHit.get(d);
        if (t === undefined || time - t < R.dummies.regenDelay) continue;
        const s = spawns.get(d);
        d.health = s.health;
        d.shield = s.shield;
        lastHit.delete(d);
      }
      // Umgefallene Figuren stehen wieder auf
      for (const [c, at] of respawnAt) {
        if (time < at) continue;
        respawnAt.delete(c);
        if (!game.characters.includes(c)) continue;
        const s = spawns.get(c);
        c.resetForRound({ health: s.health, shield: s.shield, position: s.position, yaw: s.yaw });
        lastHit.delete(c);
      }
    },

    dispose() {
      offDamaged();
      offKilled();
      respawnAt.clear();
      lastHit.clear();
      spawns.clear();
    },
  };
}

// Schönere Grafik für Baum, Fels und Auto (die Kollision bleibt eine Box)
function decorate(map, rock, H) {
  const mat = (color, options = {}) => new THREE.MeshLambertMaterial({ color, ...options });
  const add = (geometry, material, x, y, z) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    map.addObject(m);
    return m;
  };
  // Baum-Krone: zwei Kugeln
  const leaves = mat('#3F9D45');
  add(new THREE.IcosahedronGeometry(1.7, 1), leaves, H.tree.x, 4.3, H.tree.z);
  add(new THREE.IcosahedronGeometry(1.2, 1), mat('#4DB653'), H.tree.x + 0.5, 5.1, H.tree.z - 0.3);
  // Fels: kantiger Stein statt Kiste
  if (rock.mesh) rock.mesh.visible = false;
  const stone = add(new THREE.DodecahedronGeometry(1, 0), mat('#8E949C', { flatShading: true }), H.rock.x, 0.72, H.rock.z);
  stone.scale.set(1.15, 0.8, 0.95);
  stone.rotation.set(0.2, 0.6, 0.1);
  // Auto: Räder und Scheiben
  const wheel = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 16);
  wheel.rotateX(Math.PI / 2);
  const tire = mat('#23252B');
  for (const dx of [-1.3, 1.3]) {
    for (const dz of [-0.92, 0.92]) add(wheel, tire, H.car.x + dx, 0.42, H.car.z + dz);
  }
  const glass = mat('#7CC3E8');
  const side = new THREE.BoxGeometry(1.7, 0.45, 0.04);
  add(side, glass, H.car.x + 0.05, 1.42, H.car.z - 0.81);
  add(side, glass, H.car.x + 0.05, 1.42, H.car.z + 0.81);
  const front = new THREE.BoxGeometry(0.04, 0.45, 1.4);
  add(front, glass, H.car.x - 1.01, 1.42, H.car.z);
  add(front, glass, H.car.x + 1.11, 1.42, H.car.z);
  const lamp = new THREE.BoxGeometry(0.05, 0.16, 0.36);
  for (const dz of [-0.55, 0.55]) add(lamp, mat('#FFF4B8', { emissive: '#665A20' }), H.car.x - 2.01, 0.75, H.car.z + dz);
}
