// Tests für die Figuren-Grafik (src/world/characterModel.js) – ohne zu malen
import { describe, it, assert } from './runner.js';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { createCharacterView } from '../src/world/characterModel.js';
import { Character } from '../src/player.js';

describe('Figuren-Grafik', () => {
  it('jedes Farbset (mit Hut) lässt sich bauen und wieder entfernen', () => {
    const scene = new THREE.Scene();
    for (const skin of CONFIG.skins.list) {
      const c = new Character(null, { skin: skin.id });
      const view = createCharacterView(c, scene);
      assert.ok(view.root.parent === scene, skin.id);
      let meshes = 0;
      view.root.traverse((o) => { if (o.isMesh) meshes++; });
      assert.ok(meshes >= 15, `${skin.id}: ${meshes} Teile`);
      view.update(0.5, 1 / 60);
      view.dispose();
      assert.ok(view.root.parent === null);
    }
    assert.equal(scene.children.length, 0);
  });

  it('steht zwischen zwei Logik-Schritten (alpha) und dreht sich mit yaw', () => {
    const c = new Character(null, {});
    const view = createCharacterView(c, new THREE.Scene());
    c.prevPosition.set(0, 0, 0);
    c.position.set(2, 0, 0);
    c.prevYaw = 0;
    c.yaw = 1;
    view.update(0.25, 1 / 60);
    assert.close(view.root.position.x, 0.5, 1e-9);
    assert.close(view.root.rotation.y, 0.25, 1e-9);
    view.update(1, 1 / 60, 2.5);
    assert.close(view.root.rotation.y, 2.5, 1e-9, 'Blick von außen vorgegeben (Spieler)');
    view.dispose();
  });

  it('Waffe an die rechte Hand hängen und wieder abnehmen', () => {
    const c = new Character(null, {});
    const view = createCharacterView(c, new THREE.Scene());
    const gun = new THREE.Object3D();
    view.attach('weapon', gun);
    assert.ok(gun.parent === view.rightHand);
    const other = new THREE.Object3D();
    view.attach('weapon', other);
    assert.ok(gun.parent === null, 'gleicher Name ersetzt');
    assert.equal(view.detach('weapon'), other);
    assert.equal(view.detach('weapon'), null);
    view.dispose();
  });

  it('besiegt: kippt um und verschwindet nach einer Weile', () => {
    const game = { time: 0 };
    const c = new Character(game, {});
    const view = createCharacterView(c, new THREE.Scene());
    c.alive = false;
    c.deathTime = 0;
    for (let i = 0; i < 30; i++) view.update(1, 1 / 60);
    assert.ok(view.root.visible);
    game.time = 3;
    view.update(1, 1 / 60);
    assert.ok(!view.root.visible);
    view.dispose();
  });
});
