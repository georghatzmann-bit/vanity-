// Tests für die Schulter-Kamera (src/camera.js)
import { describe, it, assert } from './runner.js';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { ThirdPersonCamera, lerpAngle } from '../src/camera.js';
import { CollisionWorld } from '../src/physics.js';
import { Character } from '../src/player.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

describe('Schulter-Kamera', () => {
  it('ohne Hindernis: 3,2 m hinter dem Drehpunkt und 0,6 m rechts', () => {
    const rig = new ThirdPersonCamera(null);
    const world = new CollisionWorld();
    const pos = v(0, 0, 0);
    const dir = v(0, 0, 0);
    const used = rig.computePose(world, 0, 0, 0, 0, 0, CONFIG.camera.distance, CONFIG.camera.height, pos, dir);
    assert.close(pos.z, CONFIG.camera.distance, 1e-9, 'hinter der Figur (+Z, weil sie nach −Z schaut)');
    assert.close(pos.x, CONFIG.camera.shoulderOffset, 1e-9, 'rechte Schulter');
    assert.close(pos.y, CONFIG.camera.height, 1e-9);
    assert.close(used, Math.hypot(CONFIG.camera.distance, CONFIG.camera.shoulderOffset), 1e-9);
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
