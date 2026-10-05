// Tests für die Kollisions-Welt (src/physics.js)
import { describe, it, assert } from './runner.js';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { CollisionWorld, createRayHit, slopeSurfaceY } from '../src/physics.js';
import { createRng } from '../src/util/random.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const down = v(0, -1, 0);

function fakeCharacter(x, y, z, height = CONFIG.player.hitbox.height) {
  return { position: v(x, y, z), height, radius: CONFIG.player.hitbox.radius, alive: true };
}

describe('Kollisions-Welt: Boxen und Abfragen', () => {
  it('queryBox findet berührende Boxen, jede nur einmal (auch über viele Zellen)', () => {
    const world = new CollisionWorld();
    const big = world.addBox(v(-10, 0, -10), v(10, 8, 10)); // über viele Raster-Zellen
    const small = world.addBox(v(20, 0, 20), v(21, 1, 21));
    const out = [];
    world.queryBox(v(-1, 0, -1), v(1, 1, 1), out);
    assert.deepEqual(out.map((c) => c.id), [big.id]);
    world.queryBox(v(21, 1, 21), v(22, 2, 22), out); // nur die Ecke berührt
    assert.deepEqual(out.map((c) => c.id), [small.id]);
    world.queryBox(v(-100, -5, -100), v(100, 50, 100), out);
    assert.equal(out.length, 2);
  });

  it('remove, updateCollider und ausgeschaltete Collider', () => {
    const world = new CollisionWorld();
    const box = world.addBox(v(-1, 0, -6), v(1, 3, -5));
    const origin = v(0, 1, 0);
    const dir = v(0, 0, -1);
    assert.close(world.raycast(origin, dir, 50, { skipTerrain: true }).distance, 5, 1e-9);
    box.min.z = -11;
    box.max.z = -10;
    world.updateCollider(box);
    assert.close(world.raycast(origin, dir, 50, { skipTerrain: true }).distance, 10, 1e-9, 'nach dem Verschieben');
    box.enabled = false;
    assert.equal(world.raycast(origin, dir, 50, { skipTerrain: true }), null, 'ausgeschaltet');
    box.enabled = true;
    world.remove(box);
    assert.equal(world.raycast(origin, dir, 50, { skipTerrain: true }), null, 'entfernt');
    assert.equal(world.colliders.length, 0);
  });

  it('boxBlocked: Überlappen ja, bloßes Berühren nein, ignore wirkt', () => {
    const world = new CollisionWorld();
    const wall = world.addBox(v(0, 0, 0), v(4, 4, 0.2));
    assert.ok(world.boxBlocked(v(1, 0, -0.1), v(2, 2, 0.1)));
    assert.ok(!world.boxBlocked(v(1, 0, 0.2), v(2, 2, 1)), 'berührt nur');
    assert.ok(!world.boxBlocked(v(1, 0, -0.1), v(2, 2, 0.1), (c) => c === wall));
  });

  it('surfaceHeight: höchste Fläche unter maxY (Gelände, Box, Rampe)', () => {
    const world = new CollisionWorld();
    world.addBox(v(0, 0, 0), v(4, 1, 4));
    world.addBox(v(0, 5, 0), v(4, 5.2, 4)); // Decke darüber
    world.addSlope({ minX: 10, maxX: 14, minZ: 0, maxZ: 4, baseY: 0, rise: 4, dir: 0, thickness: 0.2 });
    assert.equal(world.surfaceHeight(2, 2, 3), 1, 'Box-Oberkante, Decke liegt über maxY');
    assert.close(world.surfaceHeight(2, 2, 10), 5.2, 1e-9, 'mit großem maxY: die Decke');
    assert.close(world.surfaceHeight(11, 2, 10), 1, 1e-9, 'Rampe bei x=11');
    assert.equal(world.surfaceHeight(30, 30, 10), 0, 'nur Gelände');
  });
});

describe('Kollisions-Welt: Strahlen', () => {
  it('Box: Abstand, Treffpunkt und Normale', () => {
    const world = new CollisionWorld();
    const box = world.addBox(v(-2, 0, -12), v(2, 4, -10));
    const hit = world.raycast(v(0, 1, 0), v(0, 0, -1), 100);
    assert.ok(hit && hit.collider === box);
    assert.close(hit.distance, 10, 1e-9);
    assert.close(hit.point.z, -10, 1e-9);
    assert.deepEqual(hit.normal.toArray(), [0, 0, 1]);
    assert.equal(world.raycast(v(0, 1, 0), v(0, 0, -1), 9.5), null, 'maxDist zu kurz');
  });

  it('Start in einer Box zählt nicht als Treffer', () => {
    const world = new CollisionWorld();
    world.addBox(v(-1, 0, -1), v(1, 2, 1));
    assert.equal(world.raycast(v(0, 1, 0), v(0, 0, -1), 20, { skipTerrain: true }), null);
  });

  it('Rampe: Oberseite von oben, Unterseite von unten', () => {
    const world = new CollisionWorld();
    const ramp = world.addSlope({ minX: 0, maxX: 4, minZ: 0, maxZ: 4, baseY: 0, rise: 4, dir: 0, thickness: 0.2 });
    const hit = world.raycast(v(1, 10, 2), down, 50);
    assert.ok(hit && hit.collider === ramp);
    assert.close(hit.point.y, 1, 1e-9);
    assert.close(hit.normal.x, -Math.SQRT1_2, 1e-6);
    assert.close(hit.normal.y, Math.SQRT1_2, 1e-6);
    const under = world.raycast(v(3, 0.5, 2), v(0, 1, 0), 50);
    assert.ok(under && under.collider === ramp);
    assert.close(under.point.y, 3 - ramp.vThickness, 1e-9, 'Unterseite');
    assert.ok(under.normal.y < 0);
    // waagerecht durch die Seite (bei x = 2 liegt die Platte zwischen 1,72 und 2 m)
    const side = world.raycast(v(2, 1.85, -5), v(0, 0, 1), 50);
    assert.ok(side && side.collider === ramp);
    assert.close(side.point.z, 0, 1e-9);
  });

  it('Rampen in alle 4 Richtungen steigen richtig an', () => {
    const world = new CollisionWorld();
    const dirs = [[0, 3, 2, 3], [1, 2, 3, 3], [2, 1, 2, 3], [3, 2, 1, 3]];
    for (const [dir, x, z, expected] of dirs) {
      const ramp = world.addSlope({ minX: 0, maxX: 4, minZ: 0, maxZ: 4, baseY: 0, rise: 4, dir, thickness: 0.2 });
      assert.close(slopeSurfaceY(ramp, x, z), expected, 1e-9, `dir ${dir}`);
      world.remove(ramp);
    }
  });

  it('Pyramiden-Dach: Spitze in der Mitte, Seiten mit Dicke', () => {
    const world = new CollisionWorld();
    const roof = world.addSlope({ minX: 0, maxX: 4, minZ: 0, maxZ: 4, baseY: 4, rise: 1.5, dir: 'pyramid', thickness: 0.2 });
    const apex = world.raycast(v(2, 20, 2), down, 50);
    assert.close(apex.point.y, 5.5, 1e-6, 'Spitze');
    const side = world.raycast(v(3, 20, 2), down, 50);
    assert.close(side.point.y, 4.75, 1e-6, 'halbe Höhe');
    assert.ok(side.normal.x > 0.3 && side.normal.y > 0.5, 'Fläche zeigt nach +X und oben');
    const fromBelow = world.raycast(v(3, 0, 2), v(0, 1, 0), 50);
    assert.close(fromBelow.point.y, 4.75 - roof.vThickness, 1e-6, 'Unterseite');
    assert.equal(world.raycast(v(5, 20, 2), down, 50, { skipTerrain: true }), null, 'neben dem Dach');
  });

  it('flaches Gelände und hügeliges Gelände (Schritte + Halbieren)', () => {
    const world = new CollisionWorld();
    let hit = world.raycast(v(3, 5, 3), down, 50);
    assert.ok(hit.terrain);
    assert.close(hit.distance, 5, 1e-9);
    const hills = { heightAt: (x, z) => 3 + Math.sin(x * 0.7) * 2 + Math.cos(z * 0.5), maxHeight: 6 };
    world.setTerrain(hills);
    hit = world.raycast(v(1.3, 20, 2), down, 50);
    assert.close(hit.point.y, hills.heightAt(1.3, 2), 1e-3);
    const dir = v(0.8, -0.3, 0.2).normalize();
    hit = world.raycast(v(-10, 12, 0), dir, 200);
    assert.ok(hit && hit.terrain, 'schräger Strahl trifft');
    assert.close(hit.point.y, hills.heightAt(hit.point.x, hit.point.z), 0.01);
    assert.ok(hit.normal.y > 0);
  });

  it('Figuren-Kapsel: Körper, Kopf (oberste 0,3 m), geduckt kleiner', () => {
    const world = new CollisionWorld();
    const ch = fakeCharacter(0, 0, -10);
    const options = { characters: [ch], skipTerrain: true };
    let hit = world.raycast(v(0, 1, 0), v(0, 0, -1), 50, options);
    assert.ok(hit && hit.character === ch);
    assert.equal(hit.part, 'body');
    assert.close(hit.distance, 10 - CONFIG.player.hitbox.radius, 1e-6);
    hit = world.raycast(v(0, 1.65, 0), v(0, 0, -1), 50, options);
    assert.equal(hit.part, 'head');
    ch.height = CONFIG.player.hitbox.crouchHeight;
    assert.equal(world.raycast(v(0, 1.6, 0), v(0, 0, -1), 50, options), null, 'geduckt: Strahl geht drüber');
    hit = world.raycast(v(0, 1.15, 0), v(0, 0, -1), 50, options);
    assert.equal(hit.part, 'head', 'geduckt: Kopf ist tiefer');
    // von oben auf den Kopf
    hit = world.raycast(v(0, 10, -10), down, 50, options);
    assert.equal(hit.part, 'head');
    assert.close(hit.point.y, ch.height, 1e-6);
  });

  it('Strahl beginnt IN einer Figur (Figuren ineinander): Treffer bei Abstand 0', () => {
    const world = new CollisionWorld();
    const enemy = fakeCharacter(0, 0, -5);
    const shooter = fakeCharacter(0, 0, -4.6);
    const options = { characters: [enemy, shooter], ignoreCharacter: shooter, skipTerrain: true };
    let hit = world.raycast(v(0, 1.6, -4.7), v(0, 0, -1), 50, options);
    assert.ok(hit && hit.character === enemy, 'Gegner getroffen');
    assert.equal(hit.distance, 0);
    assert.equal(hit.part, 'head', 'Start auf Kopfhöhe');
    assert.close(hit.normal.z, 1, 1e-9, 'Normale gegen die Richtung');
    hit = world.raycast(v(0.1, 0.9, -5.2), v(1, 0, 0), 50, options);
    assert.ok(hit && hit.character === enemy && hit.distance === 0 && hit.part === 'body', 'Körper, andere Richtung');
    // die eigene Figur bleibt ausgenommen, auch wenn der Strahl in ihr beginnt
    hit = world.raycast(v(0, 1, -4.6), v(0, 0, 1), 50, options);
    assert.equal(hit, null, 'nur die eigene Figur → kein Treffer');
    // knapp außerhalb (über dem Kopf): normal von außen
    assert.equal(world.raycast(v(0, 1.85, -5), v(0, 0, -1), 50, options), null);
  });

  it('hügeliges Gelände: Strahl mit maxDist = Infinity endet (kein Hängenbleiben)', () => {
    const world = new CollisionWorld();
    // Insel (bis 30 m hoch), außen Meer bei -2 m
    world.setTerrain({ heightAt: (x, z) => (Math.hypot(x, z) < 200 ? 30 * Math.max(0, 1 - Math.hypot(x, z) / 200) : -2), maxHeight: 30 });
    const t0 = performance.now();
    const hit = world.raycast(v(400, 5, 0), v(1, 0, 0), Infinity);
    assert.equal(hit, null, 'waagerecht über dem Meer: nichts');
    const hill = world.raycast(v(-400, 5, 0), v(1, 0, 0), Infinity);
    assert.ok(hill && hill.terrain, 'Richtung Insel: trifft den Hang');
    assert.ok(performance.now() - t0 < 500, 'schnell fertig');
  });

  it('Figuren: ignoreCharacter, besiegte Figuren, Wand davor', () => {
    const world = new CollisionWorld();
    const me = fakeCharacter(0, 0, 0);
    const other = fakeCharacter(0, 0, -10);
    let hit = world.raycast(v(0, 1, 0), v(0, 0, -1), 50, { characters: [me, other], ignoreCharacter: me, skipTerrain: true });
    assert.equal(hit.character, other);
    other.alive = false;
    assert.equal(world.raycast(v(0, 1, 0), v(0, 0, -1), 50, { characters: [other], skipTerrain: true }), null);
    other.alive = true;
    const wall = world.addBox(v(-2, 0, -5.2), v(2, 4, -5));
    hit = world.raycast(v(0, 1, 0), v(0, 0, -1), 50, { characters: [other], skipTerrain: true });
    assert.equal(hit.collider, wall);
    assert.equal(hit.character, null);
    hit = world.raycast(v(0, 1, 0), v(0, 0, -1), 50, { characters: [other], skipTerrain: true, ignore: (c) => c === wall });
    assert.equal(hit.character, other, 'ignore() lässt die Wand weg');
  });

  it('eigenes Ergebnis-Objekt (out) wird gefüllt und zurückgegeben', () => {
    const world = new CollisionWorld();
    world.addBox(v(-1, 0, -6), v(1, 2, -5));
    const out = createRayHit();
    const hit = world.raycast(v(0, 1, 0), v(0, 0, -1), 50, null, out);
    assert.ok(hit === out);
    assert.close(out.distance, 5, 1e-9);
  });

  it('Raumgitter: 3000 Boxen – Strahlen schnell und gleich wie "alles prüfen"', () => {
    const rng = createRng(5);
    const grid = new CollisionWorld();
    const brute = new CollisionWorld({ ...CONFIG, physics: { ...CONFIG.physics, bigColliderCells: -1 } }); // alles in einer Liste
    for (let i = 0; i < 3000; i++) {
      const x = (rng() - 0.5) * 300;
      const z = (rng() - 0.5) * 300;
      const y = rng() * 40;
      const min = v(x, y, z);
      const max = v(x + 0.2 + rng() * 4, y + 0.2 + rng() * 4, z + 0.2 + rng() * 4);
      grid.addBox(min, max);
      brute.addBox(min, max);
    }
    const origins = [];
    const dirs = [];
    for (let i = 0; i < 2000; i++) {
      origins.push(v((rng() - 0.5) * 300, rng() * 40, (rng() - 0.5) * 300));
      dirs.push(v(rng() - 0.5, (rng() - 0.5) * 0.5, rng() - 0.5).normalize());
    }
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < origins.length; i++) if (grid.raycast(origins[i], dirs[i], 150)) hits++;
    const ms = performance.now() - t0;
    assert.ok(hits > 100, `zu wenige Treffer: ${hits}`);
    assert.ok(ms < 1500, `2000 Strahlen dauerten ${ms.toFixed(0)} ms`);
    for (let i = 0; i < 300; i++) {
      const a = grid.raycast(origins[i], dirs[i], 150, { skipTerrain: true });
      const b = brute.raycast(origins[i], dirs[i], 150, { skipTerrain: true });
      assert.equal(!!a, !!b, `Strahl ${i}: Treffer ja/nein`);
      if (a) assert.close(a.distance, b.distance, 1e-9, `Strahl ${i}: Abstand`);
    }
    // queryBox ist auch schnell
    const out = [];
    const t1 = performance.now();
    for (let i = 0; i < 2000; i++) grid.queryBox(origins[i], v(origins[i].x + 1, origins[i].y + 2, origins[i].z + 1), out);
    assert.ok(performance.now() - t1 < 500, 'queryBox zu langsam');
  });
});
