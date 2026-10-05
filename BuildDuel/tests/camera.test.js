// Tests für die Schulter-Kamera (src/camera.js)
import { describe, it, assert } from './runner.js';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { ThirdPersonCamera, lerpAngle, nearPlaneCornerDistance } from '../src/camera.js';
import { CollisionWorld } from '../src/physics.js';
import { Character } from '../src/player.js';
import { createRng } from '../src/util/random.js';
import { createCharacterView } from '../src/world/characterModel.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

describe('Schulter-Kamera', () => {
  it('ohne Hindernis: 3,2 m hinter dem Kopf und 0,6 m rechts', () => {
    const rig = new ThirdPersonCamera(null);
    const world = new CollisionWorld();
    const pos = v(0, 0, 0);
    const dir = v(0, 0, 0);
    const used = rig.computePose(world, 0, 0, 0, 0, 0, CONFIG.camera.distance, CONFIG.camera.height, pos, dir);
    assert.close(pos.z, CONFIG.camera.distance, 1e-9, 'hinter der Figur (+Z, weil sie nach −Z schaut)');
    assert.close(pos.x, CONFIG.camera.shoulderOffset, 1e-9, 'rechte Schulter');
    assert.close(pos.y, CONFIG.camera.height, 1e-9);
    assert.close(used, CONFIG.camera.distance, 1e-9, 'Länge nach hinten (vom Schulter-Punkt)');
    assert.close(dir.z, -1, 1e-9);
  });

  it('Wand hinter der Figur: Kamera bleibt davor (geht nicht durch die Wand)', () => {
    const rig = new ThirdPersonCamera(null);
    const world = new CollisionWorld();
    world.addBox(v(-5, 0, 1.5), v(5, 4, 1.7)); // Wand 1,5 m hinter der Figur
    const pos = v(0, 0, 0);
    rig.computePose(world, 0, 0, 0, 0, 0, CONFIG.camera.distance, CONFIG.camera.height, pos, v(0, 0, 0));
    assert.ok(pos.z < 1.5 - CONFIG.camera.collisionPadding + 1e-6, `Kamera bei z=${pos.z.toFixed(3)}`);
    assert.ok(pos.z > 0.5, 'aber so weit hinten wie möglich');
  });

  it('Ziel-Strahl ist für den gleichen Zustand immer gleich und beim Zielen gleich gerichtet', () => {
    const rig = new ThirdPersonCamera(null);
    const world = new CollisionWorld();
    const c = new Character(null, { position: { x: 3, y: 0, z: -2 }, yaw: 0.7 });
    c.pitch = 0.3;
    const o1 = v(0, 0, 0);
    const d1 = v(0, 0, 0);
    rig.computeAimRay(c, world, o1, d1);
    const o2 = v(0, 0, 0);
    const d2 = v(0, 0, 0);
    rig.computeAimRay(c, world, o2, d2);
    assert.close(o1.distanceTo(o2), 0, 1e-12);
    c.aiming = true;
    const o3 = v(0, 0, 0);
    const d3 = v(0, 0, 0);
    rig.computeAimRay(c, world, o3, d3);
    assert.close(d3.distanceTo(d1), 0, 1e-12, 'gleiche Richtung');
    const expected = new THREE.Vector3();
    c.aimDirection(expected);
    assert.close(d1.distanceTo(expected), 0, 1e-9);
  });

  it('Bild-Kamera: Zielen zoomt (Sichtfeld 70° → 55°), Zielfernrohr nutzt scopeFov', () => {
    const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 16 / 9, 0.1, 500);
    const rig = new ThirdPersonCamera(camera);
    const world = new CollisionWorld();
    const c = new Character(null, {});
    rig.update(c, 1, 0, world);
    assert.close(camera.fov, CONFIG.camera.fov, 1e-6);
    c.aiming = true;
    for (let i = 0; i < 120; i++) rig.update(c, 1, 1 / 60, world);
    assert.close(camera.fov, CONFIG.camera.aimFov, 0.05);
    assert.close(rig.distance, CONFIG.camera.aimDistance, 0.01, 'näher ran');
    c.scopeFov = CONFIG.camera.sniperFov;
    for (let i = 0; i < 120; i++) rig.update(c, 1, 1 / 60, world);
    assert.close(camera.fov, CONFIG.camera.sniperFov, 0.05);
  });

  it('Bild-Kamera: zwischen zwei Logik-Schritten weich (alpha)', () => {
    const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
    const rig = new ThirdPersonCamera(camera);
    const c = new Character(null, {});
    c.prevPosition.set(0, 0, 0);
    c.position.set(0, 0, -1);
    rig.update(c, 0.5, 1 / 60, null);
    assert.close(camera.position.z, CONFIG.camera.distance - 0.5, 1e-9);
  });

  it('Bild-Kamera: an eine Wand heran sofort, zurück langsam', () => {
    const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
    const rig = new ThirdPersonCamera(camera);
    const world = new CollisionWorld();
    const c = new Character(null, {});
    rig.update(c, 1, 1 / 60, world);
    const wall = world.addBox(v(-5, 0, 1.5), v(5, 4, 1.7));
    rig.update(c, 1, 1 / 60, world);
    assert.ok(camera.position.z < 1.5, 'sofort vor der Wand');
    world.remove(wall);
    rig.update(c, 1, 1 / 60, world);
    assert.ok(camera.position.z < 1.6, 'nicht sofort zurückspringen');
    for (let i = 0; i < 240; i++) rig.update(c, 1, 1 / 60, world);
    assert.close(camera.position.z, CONFIG.camera.distance, 0.01, 'nach einer Weile wieder ganz hinten');
  });

  it('lerpAngle nimmt den kürzeren Weg', () => {
    assert.close(Math.abs(lerpAngle(3.1, -3.1, 0.5)), Math.PI, 0.01);
    assert.close(lerpAngle(0, 1, 0.25), 0.25, 1e-9);
  });
});

// --- Hilfen für die Wand-Tests ---------------------------------------------------------
const C = CONFIG.camera;

// 1x1-Box (4 x 4 m, Wände 0,2 m dick, Dach in 4 m Höhe) wie beim Box-Fight
function boxFightWorld() {
  const world = new CollisionWorld();
  world.addBox(v(-0.1, 0, -0.1), v(4.1, 4, 0.1));
  world.addBox(v(-0.1, 0, 3.9), v(4.1, 4, 4.1));
  world.addBox(v(-0.1, 0, -0.1), v(0.1, 4, 4.1));
  world.addBox(v(3.9, 0, -0.1), v(4.1, 4, 4.1));
  world.addBox(v(-0.1, 3.9, -0.1), v(4.1, 4.1, 4.1));
  return world;
}

// Liegt ein Punkt der Bild-Nahgrenze (Ecken, Kanten-Mitten, Mitte) in einer Box oder im Boden?
const _np = new THREE.Vector3();
function nearPlaneInWall(world, camera) {
  camera.updateMatrixWorld(true);
  for (const sx of [-1, 0, 1]) {
    for (const sy of [-1, 0, 1]) {
      const p = _np.set(sx, sy, -1).unproject(camera);
      if (p.y < world.terrain.heightAt(p.x, p.z) - 1e-6) return true;
      for (const c of world.colliders) {
        if (p.x > c.min.x + 1e-6 && p.x < c.max.x - 1e-6 && p.y > c.min.y + 1e-6 && p.y < c.max.y - 1e-6 &&
          p.z > c.min.z + 1e-6 && p.z < c.max.z - 1e-6) return true;
      }
    }
  }
  return false;
}

// Abstand eines Punktes von der Fadenkreuz-Linie (Kamera-Position + t * Blickrichtung)
function distanceToLine(point, origin, dir) {
  const d = point.clone().sub(origin);
  return d.sub(dir.clone().multiplyScalar(d.dot(dir))).length();
}

// Ein Logik-Schritt + ein Bild (wie im Spiel)
function tickAndRender(rig, c, world, alpha = 1) {
  rig.fixedUpdate(c, 1 / 60, world);
  rig.update(c, alpha, 1 / 60, world);
}

describe('Schulter-Kamera: nie durch Wände sehen', () => {
  it('1x1-Box: in keiner Lage ragt die Bild-Nahgrenze in eine Wand (auch 21:9 und 4:3)', () => {
    const world = boxFightWorld();
    const rng = createRng(3);
    let bad = 0;
    let n = 0;
    for (const aspect of [16 / 9, 21 / 9, 4 / 3]) {
      const camera = new THREE.PerspectiveCamera(C.fov, aspect, C.near, 500);
      for (let i = 0; i < 700; i++) {
        const rig = new ThirdPersonCamera(camera);
        const c = new Character(null, { position: { x: 0.5 + rng() * 3, y: 0.1, z: 0.5 + rng() * 3 }, yaw: rng() * Math.PI * 2 });
        c.pitch = c.prevPitch = (rng() * 2 - 1) * 1.39;
        c.aiming = rng() < 0.3;
        c.crouching = rng() < 0.3;
        tickAndRender(rig, c, world);
        n++;
        if (nearPlaneInWall(world, camera)) bad++;
      }
    }
    assert.equal(bad, 0, `${bad} von ${n} Lagen sehen durch eine Wand`);
  });

  it('Blick parallel an einer Wand entlang: Kamera hält Abstand (vorher 5 cm)', () => {
    // 4-m-Wand wie auf dem Übungsplatz; die Kamera-Linie läuft dicht neben der Wand-Fläche
    const world = new CollisionWorld();
    world.addBox(v(24, 0, 1.85), v(34, 4, 2.15));
    const camera = new THREE.PerspectiveCamera(C.fov, 16 / 9, C.near, 500);
    for (const z of [2.2, 2.3, 2.45, 2.6]) {
      for (const yaw of [Math.PI / 2, Math.PI / 2 + 0.05, -Math.PI / 2]) {
        const rig = new ThirdPersonCamera(camera);
        const c = new Character(null, { position: { x: 23.5 + (yaw < 0 ? 11 : 0), y: 0, z: z - (yaw < 0 ? 0 : 0) }, yaw });
        tickAndRender(rig, c, world);
        assert.ok(!nearPlaneInWall(world, camera), `z=${z}, yaw=${yaw.toFixed(2)}: Bild-Nahgrenze in der Wand`);
        const p = camera.position;
        const gap = Math.max(1.85 - p.z, p.z - 2.15, 24 - p.x, p.x - 34, p.y - 4);
        assert.ok(gap >= C.probeRadius - 1e-6, `z=${z}: Kamera nur ${gap.toFixed(3)} m von der Wand`);
      }
    }
  });

  it('nearPlaneCornerDistance: 16:9 passt in probeRadius, 21:9 bekommt im Bild mehr Abstand', () => {
    assert.ok(nearPlaneCornerDistance(C.near, C.fov, 16 / 9) <= C.probeRadius);
    const wide = nearPlaneCornerDistance(C.near, C.fov, 21 / 9);
    const rig = new ThirdPersonCamera(new THREE.PerspectiveCamera(C.fov, 21 / 9, C.near, 500));
    assert.ok(rig._renderProbe() > wide, 'Bild-Abstand größer als die Ecke');
  });
});

describe('Schulter-Kamera: eigene Figur und Fadenkreuz', () => {
  it('Rücken zur Wand (0,15 bis 2,5 m): Kopf bleibt neben der Fadenkreuz-Linie', () => {
    const world = new CollisionWorld();
    world.addBox(v(24, 0, 1.85), v(34, 4, 2.15));
    for (let gap = 0.15; gap <= 2.55; gap += 0.2) {
      for (const pitch of [0, 0.6, 1.2]) {
        const rig = new ThirdPersonCamera(new THREE.PerspectiveCamera(C.fov, 16 / 9, C.near, 500));
        const c = new Character(null, { position: { x: 29, y: 0, z: 2.15 + 0.4 + gap }, yaw: Math.PI });
        c.pitch = c.prevPitch = pitch;
        tickAndRender(rig, c, world);
        const head = v(29, C.height, 2.15 + 0.4 + gap);
        const d = distanceToLine(head, rig.position, rig.direction);
        assert.ok(d >= C.shoulderOffset - 1e-6 || rig.hideCharacter,
          `Abstand ${gap.toFixed(2)} m, Neigung ${pitch}: Kopf nur ${d.toFixed(2)} m neben dem Fadenkreuz`);
      }
    }
  });

  it('Figur-Modell verdeckt das Fadenkreuz nicht (Rücken zur Wand, Blick nach oben, Wand rechts)', () => {
    const scene = new THREE.Scene();
    const world = new CollisionWorld();
    world.addBox(v(24, 0, 1.85), v(34, 4, 2.15)); // hinter dem Rücken
    world.addBox(v(40, 0, 10), v(40.2, 4, 20)); // rechts daneben
    const camera = new THREE.PerspectiveCamera(C.fov, 16 / 9, C.near, 500);
    const rc = new THREE.Raycaster();
    const poses = [];
    for (let gap = 0.15; gap <= 2.6; gap += 0.4) poses.push({ x: 29, z: 2.55 + gap, yaw: Math.PI, pitch: 0 });
    for (const pitch of [0.75, 1.05, 1.35]) poses.push({ x: 0, z: 22, yaw: 0, pitch });
    for (const gap of [0, 0.1, 0.2, 0.3]) poses.push({ x: 40 - 0.4 - gap, z: 15, yaw: 0, pitch: 0 });
    for (const pose of poses) {
      const c = new Character(null, { position: { x: pose.x, y: 0, z: pose.z }, yaw: pose.yaw });
      c.pitch = c.prevPitch = pose.pitch;
      const view = createCharacterView(c, scene);
      const rig = new ThirdPersonCamera(camera);
      tickAndRender(rig, c, world);
      view.setHidden(rig.hideCharacter);
      view.update(1, 1 / 60, rig.yaw);
      camera.updateMatrixWorld(true);
      view.root.updateMatrixWorld(true);
      let hits = 0;
      for (let dx = -0.04; dx <= 0.041; dx += 0.02) {
        for (let dy = -0.04; dy <= 0.041; dy += 0.02) {
          rc.setFromCamera(new THREE.Vector2(dx, dy), camera);
          if (view.root.visible && rc.intersectObject(view.root, true).length) hits++;
        }
      }
      view.dispose();
      assert.equal(hits, 0, `Lage ${JSON.stringify(pose)}: Figur verdeckt ${hits}/25 Strahlen ums Fadenkreuz`);
    }
  });

  it('Fadenkreuz-Linie = Ziel-Strahl: auch direkt nach dem Weggehen von einer Wand und beim Ducken', () => {
    const world = new CollisionWorld();
    world.addBox(v(-10, 0, 1.0), v(10, 4, 1.2)); // Wand 1 m hinter der Figur
    const c = new Character(null, { position: { x: 0, y: 0, z: 0 }, yaw: 0.3 });
    c.pitch = c.prevPitch = 0.2;
    const rig = new ThirdPersonCamera(new THREE.PerspectiveCamera(C.fov, 16 / 9, C.near, 500));
    for (let i = 0; i < 30; i++) tickAndRender(rig, c, world);
    const o = v(0, 0, 0);
    const d = v(0, 0, 0);
    const missAt15 = () => {
      rig.computeAimRay(c, world, o, d);
      const target = rig.position.clone().addScaledVector(rig.direction, 15 + rig.characterDistance);
      return Math.max(distanceToLine(target, o, d), d.distanceTo(rig.direction));
    };
    // 3 m nach vorn in einem Tick, danach Bilder (Kamera fährt langsam zurück)
    c.prevPosition.copy(c.position);
    c.position.z = -3;
    rig.fixedUpdate(c, 1 / 60, world);
    for (let f = 0; f < 30; f++) {
      rig.update(c, 1, 1 / 60, world);
      assert.ok(missAt15() < 1e-6, `Bild ${f}: Ziel-Strahl verfehlt das Fadenkreuz um ${missAt15().toFixed(3)} m`);
    }
    // Ducken: Kamera gleitet tiefer – Ziel-Strahl gleitet im selben Tick mit
    c.crouching = true;
    c.height = CONFIG.player.hitbox.crouchHeight;
    for (let f = 0; f < 30; f++) {
      c.prevPosition.copy(c.position);
      tickAndRender(rig, c, world);
      assert.ok(missAt15() < 1e-6, `Ducken, Bild ${f}: ${missAt15().toFixed(3)} m`);
    }
    assert.close(rig.pivotHeight, C.crouchHeight, 0.01, 'Kamera ist unten angekommen');
  });

  it('Wand rechts dicht am Kopf: Schulter-Punkt bleibt vor der Wand, Figur wird ausgeblendet', () => {
    const world = new CollisionWorld();
    world.addBox(v(0.4, 0, -5), v(0.6, 4, 5)); // Wand direkt rechts (Figur schaut nach −Z, rechts = +X)
    const c = new Character(null, { position: { x: 0, y: 0, z: 0 }, yaw: 0 });
    const rig = new ThirdPersonCamera(new THREE.PerspectiveCamera(C.fov, 16 / 9, C.near, 500));
    tickAndRender(rig, c, world);
    assert.ok(rig.side <= 0.4 - C.probeRadius + 1e-6, `Schulter ${rig.side.toFixed(2)} m`);
    assert.ok(rig.position.x <= 0.4 - C.probeRadius + 1e-6, 'Kamera vor der Wand');
    assert.ok(rig.hideCharacter, 'Figur würde das Fadenkreuz verdecken → ausgeblendet');
    const o = v(0, 0, 0);
    rig.computeAimRay(c, world, o, v(0, 0, 0));
    assert.ok(o.x < 0.4, 'Ziel-Strahl beginnt nicht in/hinter der Wand');
    // Wand weg → Schulter fährt langsam (über mehrere Ticks) wieder nach außen
    world.remove(world.colliders[0]);
    tickAndRender(rig, c, world);
    assert.ok(rig.side < C.shoulderOffset - 0.05, 'nicht sofort zurück');
    for (let i = 0; i < 120; i++) tickAndRender(rig, c, world);
    assert.close(rig.side, C.shoulderOffset, 0.01);
    assert.ok(!rig.hideCharacter);
  });

  it('Teleport (> 3 m): kein langsames Nachziehen von Duck-Höhe und Wand-Abstand', () => {
    const world = new CollisionWorld();
    world.addBox(v(-10, 0, 1.0), v(10, 4, 1.2));
    const camera = new THREE.PerspectiveCamera(C.fov, 16 / 9, C.near, 500);
    const rig = new ThirdPersonCamera(camera);
    const c = new Character(null, { position: { x: 0, y: 0, z: 0 }, yaw: 0 });
    for (let i = 0; i < 10; i++) tickAndRender(rig, c, world);
    assert.ok(camera.position.z < 1.0, 'vor der Wand');
    c.spawnAt({ x: 0, y: 0, z: -30 }, 0);
    tickAndRender(rig, c, world);
    assert.close(camera.position.z, -30 + C.distance, 1e-6, 'sofort ganz hinten');
  });
});
