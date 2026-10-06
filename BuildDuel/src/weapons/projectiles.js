// =============================================================================
// Geschosse mit Flugzeit: Scharfschützen-Kugel und Granate
// =============================================================================
// spawn(spec)   – neues Geschoss. spec = { type: 'bullet' | 'grenade', owner, weaponId,
//                 rarity, position, velocity, gravity, lifetime, visualFrom? }
// update(dt)    – pro Logik-Schritt: fliegen (mit Schwerkraft) und prüfen, ob die
//                 Strecke dieses Schritts etwas trifft (Strahl über die ganze Strecke →
//                 nichts "tunnelt" durch dünne Wände, auch bei 300 m/s).
// clear()       – alle weg (Rundenwechsel)
// frameUpdate(alpha) – Grafik weich zwischen zwei Logik-Schritten (nur mit Bildschirm)
//
// Kugel: Treffer an einer Figur = Waffen-Schaden (Kopf ×2,5), an Bauteilen structureDamage.
// Granate: explodiert beim Aufprall oder nach fuseTime. Radius 4 m: Figuren nehmen Schaden
//          von voll (Mitte) bis edgeDamageFactor (Rand) – AUCH hinter Wänden
//          (damageThroughWalls). Bauteile im Radius nehmen structureDamage.
//          Ereignis 'explosion' { position, radius, owner, weaponId }.
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { weaponDamage, explosionDamage, rarityMultiplier } from '../core/damage.js';
import { createRayHit } from '../physics.js';
import { createCombat, isDamageable, isPiece } from './combat.js';

const W = CONFIG.weapons;
const V = CONFIG.weaponVisuals;
const VISUAL_BLEND = 0.12; // so lange (s) gleitet die Grafik von der Mündung auf die echte Flugbahn

function passesBullets(collider) {
  return collider.data?.blocksBullets === false;
}

/**
 * @param {object} game
 */
export function createProjectileSystem(game) {
  const visual = !game.headless && !!game.root && typeof document !== 'undefined';
  const combat = createCombat(game);
  const active = []; // fliegende Geschosse
  const pool = []; // freie (zum Wiederverwenden)
  const hit = createRayHit();
  const step = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const targets = [];
  const rayOptions = { ignore: passesBullets, characters: targets, ignoreCharacter: null, skipTerrain: false };
  const queryMin = new THREE.Vector3();
  const queryMax = new THREE.Vector3();
  const queryOut = [];
  const refsDone = new Set();
  const charsSnapshot = []; // Kopie von game.characters für explode() (Empfänger dürfen die Liste ändern)
  let epoch = 0; // Nummer des laufenden update()
  let updating = false;
  const explosionEvent = { position: new THREE.Vector3(), radius: 0, owner: null, weaponId: null };
  const impactEvent = { shooter: null, weaponId: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), kind: 'static' };

  // --- Grafik (nur mit Bildschirm) ---------------------------------------------------
  let group = null;
  let bulletGeometry = null;
  let grenadeGeometry = null;
  let bulletMaterial = null;
  let grenadeMaterial = null;
  if (visual) {
    group = new THREE.Group();
    group.name = 'Geschosse';
    game.root.add(group);
    // Leuchtstreifen: Box von z = 0 bis z = 1 (wird auf die Länge gestreckt)
    bulletGeometry = new THREE.BoxGeometry(1, 1, 1);
    bulletGeometry.translate(0, 0, 0.5);
    grenadeGeometry = new THREE.SphereGeometry(V.grenadeRadius, 12, 8);
    bulletMaterial = new THREE.MeshBasicMaterial({ color: V.bulletColor, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    grenadeMaterial = new THREE.MeshLambertMaterial({ color: V.grenadeColor });
  }

  function newProjectile() {
    return {
      type: 'bullet',
      owner: null,
      weaponId: null,
      rarity: null,
      position: new THREE.Vector3(),
      prevPosition: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      gravity: 0,
      age: 0,
      lifetime: 1,
      traveled: 0,
      visualOffset: new THREE.Vector3(),
      visualStart: new THREE.Vector3(), // hier beginnt das Bild (Mündung) – der Streifen reicht nie weiter zurück
      mesh: null,
      alive: false,
      epoch: -1, // in welchem update() erzeugt (dort noch nicht bewegen)
    };
  }

  function meshFor(p) {
    if (!visual) return null;
    const wantBullet = p.type === 'bullet';
    if (p.mesh && (p.mesh.userData.bullet === wantBullet)) return p.mesh;
    if (p.mesh) {
      group.remove(p.mesh);
      p.mesh = null;
    }
    const mesh = new THREE.Mesh(wantBullet ? bulletGeometry : grenadeGeometry, wantBullet ? bulletMaterial : grenadeMaterial);
    mesh.userData.bullet = wantBullet;
    mesh.castShadow = !wantBullet;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  }

  // Geschoss zurück in den Vorrat. Sicher, auch wenn ein Ereignis-Empfänger die Liste
  // inzwischen geändert hat (clear(), endMode() …): schon freigegeben → nichts tun.
  function release(p, hint = -1) {
    if (!p.alive) return;
    p.alive = false;
    if (p.mesh) p.mesh.visible = false;
    const index = hint >= 0 && active[hint] === p ? hint : active.indexOf(p);
    if (index >= 0) {
      active[index] = active[active.length - 1];
      active.pop();
    }
    pool.push(p);
  }

  function fillTargets(owner) {
    targets.length = 0;
    const list = game.characters;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c === owner || !c.alive) continue;
      if (!W.friendlyFire && owner && c.team === owner.team) continue;
      targets.push(c);
    }
  }

  function emitImpact(p, point, normal, kind) {
    impactEvent.shooter = p.owner;
    impactEvent.weaponId = p.weaponId;
    impactEvent.point.copy(point);
    impactEvent.normal.copy(normal);
    impactEvent.kind = kind;
    game.events.emit('impact', impactEvent);
  }

  // Kugel trifft etwas
  function bulletHit(p, h, distanceInStep) {
    const def = W[p.weaponId] ?? W.sniper;
    const owner = p.owner;
    const rarity = game.useRarity ? p.rarity : null;
    if (h.character) {
      const head = h.part === 'head';
      const amount = weaponDamage(def, { distance: p.traveled + distanceInStep, head, rarity });
      const done = combat.damageCharacter(owner, h.character, amount, head, h.point, p.weaponId, 'bullet');
      if (done > 0 && owner) {
        owner.stats.shotsHit++;
        if (head) owner.stats.headshots++;
      }
      emitImpact(p, h.point, h.normal, 'character');
    } else if (h.collider && isDamageable(h.collider)) {
      const amount = isPiece(h.collider) ? def.structureDamage : weaponDamage(def, { distance: p.traveled + distanceInStep, rarity });
      combat.damageObject(owner, h.collider, amount, h.point, p.weaponId, 'bullet');
      emitImpact(p, h.point, h.normal, isPiece(h.collider) ? 'piece' : 'object');
    } else {
      emitImpact(p, h.point, h.normal, h.terrain ? 'terrain' : 'static');
    }
  }

  // Abstand eines Punkts zur Treffer-Kapsel einer Figur (0 = innen)
  function distanceToCharacter(c, point, closest) {
    const r = c.radius;
    const y0 = c.position.y + r;
    const y1 = c.position.y + Math.max(r, c.height - r);
    const cy = Math.min(y1, Math.max(y0, point.y));
    closest.set(c.position.x, cy, c.position.z);
    const d = point.distanceTo(closest) - r;
    // Punkt auf der Oberfläche (für die Schadenszahl)
    if (d > 0) closest.lerp(point, r / (d + r));
    return Math.max(0, d);
  }

  function explode(p, position) {
    const def = W[p.weaponId] ?? W.grenadeLauncher;
    const owner = p.owner;
    const radius = def.explosionRadius;
    const rarity = game.useRarity ? rarityMultiplier(p.rarity) : 1;
    let hitSomeone = false;
    // Figuren im Radius (durch Wände hindurch, wenn damageThroughWalls). Über eine KOPIE der
    // Liste: entfernt ein Empfänger von 'characterKilled' eine Figur, wird keine übersprungen.
    const list = charsSnapshot;
    list.length = 0;
    for (let i = 0; i < game.characters.length; i++) list.push(game.characters[i]);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.alive) continue;
      if (list.length !== game.characters.length || game.characters[i] !== c) {
        if (!game.characters.includes(c)) continue; // inzwischen aus dem Spiel genommen
      }
      if (c === owner && !W.selfDamage) continue;
      if (c !== owner && owner && !W.friendlyFire && c.team === owner.team) continue;
      const d = distanceToCharacter(c, position, tmp);
      if (d > radius) continue;
      if (!def.damageThroughWalls) {
        dir.subVectors(tmp, position);
        const len = dir.length();
        if (len > 0.05) {
          dir.multiplyScalar(1 / len);
          rayOptions.characters = null;
          const blocked = game.world.raycast(position, dir, len - 0.05, rayOptions, hit);
          rayOptions.characters = targets;
          if (blocked) continue;
        }
      }
      const amount = explosionDamage(def, d) * rarity;
      const done = combat.damageCharacter(owner, c, amount, false, tmp, p.weaponId, 'explosion');
      if (done > 0 && c !== owner) hitSomeone = true;
    }
    list.length = 0;
    if (hitSomeone && owner) owner.stats.shotsHit++;
    // Bauteile im Radius
    queryMin.set(position.x - radius, position.y - radius, position.z - radius);
    queryMax.set(position.x + radius, position.y + radius, position.z + radius);
    game.world.queryBox(queryMin, queryMax, queryOut);
    refsDone.clear();
    // Kopie der Liste: Zerstörte Bauteile verändern die Welt während der Schleife
    const n = queryOut.length;
    for (let i = 0; i < n; i++) {
      const c = queryOut[i];
      if (!c || !isPiece(c) || !isDamageable(c)) continue;
      const ref = c.data.ref;
      if (refsDone.has(ref)) continue;
      // nächster Punkt der Box zum Mittelpunkt
      tmp.set(
        Math.min(c.max.x, Math.max(c.min.x, position.x)),
        Math.min(c.max.y, Math.max(c.min.y, position.y)),
        Math.min(c.max.z, Math.max(c.min.z, position.z)),
      );
      if (tmp.distanceTo(position) > radius) continue;
      refsDone.add(ref);
      combat.damageObject(owner, c, def.structureDamage, tmp, p.weaponId, 'explosion');
    }
    refsDone.clear();
    queryOut.length = 0;
    explosionEvent.position.copy(position);
    explosionEvent.radius = radius;
    explosionEvent.owner = owner;
    explosionEvent.weaponId = p.weaponId;
    game.events.emit('explosion', explosionEvent);
  }

  function updateAll(dt) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (i >= active.length) continue; // Liste wurde von einem Empfänger verkürzt
      const p = active[i];
      if (!p.alive || p.epoch === epoch) continue; // gerade erst (in diesem Schritt) erzeugt
      p.prevPosition.copy(p.position);
      p.age += dt;
      // Strecke dieses Schritts (genaue Wurf-Formel)
      step.copy(p.velocity).multiplyScalar(dt);
      step.y -= 0.5 * p.gravity * dt * dt;
      p.velocity.y -= p.gravity * dt;
      const len = step.length();
      let done = false;
      if (len > 1e-9) {
        dir.copy(step).multiplyScalar(1 / len);
        fillTargets(p.owner);
        rayOptions.ignoreCharacter = p.owner;
        const h = game.world.raycast(p.position, dir, len, rayOptions, hit);
        if (h) {
          if (p.type === 'grenade') {
            // ein kleines Stück vor der Fläche explodieren
            p.position.copy(h.point).addScaledVector(dir, -0.05);
            explode(p, p.position);
          } else {
            p.position.copy(h.point);
            bulletHit(p, h, h.distance);
          }
          done = true;
        }
      }
      if (!done) {
        p.position.add(step);
        p.traveled += len;
        if (p.age >= p.lifetime) {
          if (p.type === 'grenade') explode(p, p.position);
          done = true;
        } else if (p.position.y < CONFIG.world.killPlaneY) {
          done = true;
        }
      }
      if (done) release(p, i);
    }
  }

  const system = {
    game,
    active,

    /**
     * Neues Geschoss.
     * spec = { type: 'bullet' | 'grenade', owner, weaponId, rarity, position, velocity,
     *          gravity, lifetime, visualFrom? (Mündung im Bild) }
     */
    spawn(spec) {
      const p = pool.pop() ?? newProjectile();
      p.type = spec.type === 'grenade' ? 'grenade' : 'bullet';
      p.owner = spec.owner ?? null;
      p.weaponId = spec.weaponId ?? (p.type === 'grenade' ? 'grenadeLauncher' : 'sniper');
      p.rarity = spec.rarity ?? null;
      p.position.copy(spec.position);
      p.prevPosition.copy(spec.position);
      p.velocity.copy(spec.velocity);
      p.gravity = spec.gravity ?? 0;
      p.age = 0;
      p.lifetime = spec.lifetime ?? 3;
      p.traveled = 0;
      if (spec.visualFrom) p.visualOffset.subVectors(spec.visualFrom, spec.position);
      else p.visualOffset.set(0, 0, 0);
      p.visualStart.copy(spec.visualFrom ?? spec.position);
      p.alive = true;
      p.epoch = updating ? epoch : -1;
      p.mesh = meshFor(p);
      if (p.mesh) p.mesh.visible = false; // erst im nächsten Bild an der richtigen Stelle zeigen
      active.push(p);
      return p;
    },

    /**
     * Pro Logik-Schritt: fliegen und Treffer prüfen. Treffer senden Ereignisse – deren
     * Empfänger dürfen alles (clear(), spawn(), game.endMode() …): danach wird nur noch
     * weitergemacht, was noch wirklich fliegt.
     */
    update(dt) {
      epoch++;
      updating = true;
      try {
        updateAll(dt);
      } finally {
        updating = false;
      }
    },

    /** Grafik: Geschosse weich zwischen zwei Logik-Schritten zeichnen. */
    frameUpdate(alpha = 1) {
      if (!visual) return;
      for (let i = 0; i < active.length; i++) {
        const p = active[i];
        const mesh = p.mesh;
        if (!mesh) continue;
        tmp.lerpVectors(p.prevPosition, p.position, alpha);
        // am Anfang von der Mündung (Bild) auf die echte Bahn gleiten
        const blend = Math.max(0, 1 - p.age / VISUAL_BLEND);
        if (blend > 0) tmp.addScaledVector(p.visualOffset, blend);
        mesh.position.copy(tmp);
        if (p.type === 'bullet') {
          dir.copy(p.velocity).normalize();
          // Streifen zeigt nach hinten (gegen die Flugrichtung)
          mesh.quaternion.setFromUnitVectors(Z_AXIS, step.copy(dir).negate());
          // nie hinter den Start (Mündung bzw. ein Stück vor der Kamera) zurück
          const length = Math.min(V.bulletLength, p.traveled + 0.3, tmp.distanceTo(p.visualStart));
          if (length < 0.05) {
            mesh.visible = false;
            continue;
          }
          mesh.scale.set(0.05, 0.05, length);
        } else {
          mesh.scale.set(1, 1, 1);
        }
        mesh.visible = true;
      }
    },

    /** Alle Geschosse entfernen (z. B. neue Runde). */
    clear() {
      for (let i = active.length - 1; i >= 0; i--) release(active[i], i);
    },

    dispose() {
      system.clear();
      if (group) {
        group.parent?.remove(group);
        bulletGeometry.dispose();
        grenadeGeometry.dispose();
        bulletMaterial.dispose();
        grenadeMaterial.dispose();
        group = null;
      }
      pool.length = 0;
    },
  };
  return system;
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
