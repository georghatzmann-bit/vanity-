// Tests für die Figuren-Grafik (src/world/characterModel.js) – ohne zu malen
import { describe, it, assert } from './runner.js';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { createCharacterView, normalizeSkin } from '../src/world/characterModel.js';
import { Character, getSkin } from '../src/player.js';
import { headCenter } from '../src/physics.js';

// Meshes der Figur selbst (ohne angehängte Waffe)
function ownMeshes(view) {
  const list = [];
  const skip = new Set();
  for (const child of view.rightHand.children) skip.add(child);
  const walk = (o) => {
    if (skip.has(o)) return;
    if (o.isMesh) list.push(o);
    for (const c of o.children) walk(c);
  };
  walk(view.root);
  return list;
}

describe('Figuren-Grafik', () => {
  it('jeder Skin lässt sich bauen und wieder entfernen: höchstens 12 Meshes, EIN gemeinsames Material', () => {
    const scene = new THREE.Scene();
    const materials = new Set();
    for (const skin of CONFIG.skins.list) {
      const c = new Character(null, { skin: skin.id });
      const view = createCharacterView(c, scene);
      assert.ok(view.root.parent === scene, skin.id);
      const meshes = ownMeshes(view);
      assert.ok(meshes.length <= 12, `${skin.id}: ${meshes.length} Zeichen-Aufrufe (höchstens 12)`);
      assert.ok(meshes.length >= 10, `${skin.id}: ${meshes.length} Teile`);
      for (const m of meshes) {
        materials.add(m.material);
        assert.ok(m.geometry.attributes.color, `${skin.id}: Farben in den Ecken`);
        assert.ok(m.geometry.attributes.position.count > 0, `${skin.id}: ${m.name} leer`);
      }
      view.update(0.5, 1 / 60);
      view.dispose();
      assert.ok(view.root.parent === null);
    }
    assert.equal(materials.size, 1, 'alle Figuren teilen ein Material');
    assert.equal(scene.children.length, 0);
  });

  it('Skins unterscheiden sich (eigene Formen je Outfit, gleiche Skins teilen Formen)', () => {
    const scene = new THREE.Scene();
    const bodies = new Set();
    for (const skin of CONFIG.skins.list) {
      const view = createCharacterView(new Character(null, { skin: skin.id }), scene);
      bodies.add(view.root.getObjectByName('Körper').geometry);
      view.dispose();
    }
    assert.equal(bodies.size, CONFIG.skins.list.length);
    const a = createCharacterView(new Character(null, { skin: 'ninja' }), scene);
    const b = createCharacterView(new Character(null, { skin: 'ninja' }), scene);
    assert.ok(a.root.getObjectByName('Kopf-Form').geometry === b.root.getObjectByName('Kopf-Form').geometry, 'geteilt');
    a.dispose();
    b.dispose();
  });

  it('alte Skin-Namen und alte Farbsets ({ body, accent, hat }) funktionieren weiter', () => {
    assert.equal(getSkin('sonne').id, CONFIG.skins.legacyIds.sonne);
    assert.equal(getSkin('gibtsnicht').id, CONFIG.skins.defaultId);
    const s = normalizeSkin({ body: '#FF0000', accent: '#00FF00', hat: 'helmet', hatColor: '#0000FF' });
    assert.equal(s.topColor, '#FF0000');
    assert.equal(s.headwear, 'armyHelmet');
    const view = createCharacterView(new Character(null, { skin: { id: 'alt', body: '#FF0000', hat: 'cap' } }), new THREE.Scene());
    assert.ok(ownMeshes(view).length <= 12);
    view.dispose();
  });

  it('Kopf-Gruppe sitzt genau in der Treffer-Kugel (stehend und geduckt), sichtbarer Kopf liegt in ihr', () => {
    const hb = CONFIG.player.hitbox;
    const p = new THREE.Vector3();
    const want = {};
    for (const skin of CONFIG.skins.list) {
      const c = new Character(null, { skin: skin.id, position: { x: 3, y: 0, z: -2 }, yaw: 0.7 });
      c.prevPosition.copy(c.position);
      c.prevYaw = c.yaw;
      const view = createCharacterView(c, new THREE.Scene());
      for (const crouch of [false, true]) {
        c.crouching = crouch;
        c.height = crouch ? hb.crouchHeight : hb.height;
        for (let i = 0; i < 40; i++) view.update(1, 1 / 60);
        view.root.updateMatrixWorld(true);
        view.head.getWorldPosition(p);
        headCenter(c, hb, c.height, want);
        const miss = Math.hypot(p.x - want.x, p.y - want.y, p.z - want.z);
        assert.ok(miss < 0.01, `${skin.id} ${crouch ? 'geduckt' : 'stehend'}: Kopf ${miss.toFixed(3)} m neben der Treffer-Kugel`);
      }
      // ohne Kopfbedeckung: jede Ecke von Kopf + Haaren in der Kugel (1,5 cm Spiel)
      if (skin.headwear === 'none' || skin.headwear === 'headband') {
        const pos = view.root.getObjectByName('Kopf-Form').geometry.attributes.position;
        let worst = 0;
        for (let i = 0; i < pos.count; i++) worst = Math.max(worst, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));
        assert.ok(worst <= hb.headRadius + 0.015, `${skin.id}: Kopf ragt ${(worst - hb.headRadius).toFixed(3)} m aus der Kugel`);
      }
      view.dispose();
    }
  });

  it('Waffe halten: beide Hände an der Waffe (rechts am Griff, links vorn am Lauf), folgt dem Blick', () => {
    const c = new Character(null, {});
    const view = createCharacterView(c, new THREE.Scene());
    const gun = new THREE.Group();
    gun.userData.foregrip = 0.34;
    view.attach('weapon', gun);
    c.mode = 'weapon';
    c.slots[c.selectedSlot] = { id: 'ar', kind: 'weapon' };
    const right = new THREE.Vector3();
    const left = new THREE.Vector3();
    const forward = new THREE.Vector3();
    for (const pitch of [-0.5, 0, 0.6]) {
      c.pitch = c.prevPitch = pitch;
      for (let i = 0; i < 40; i++) view.update(1, 1 / 60);
      view.root.updateMatrixWorld(true);
      view.rightHand.getWorldPosition(right);
      const elbowL = view.root.getObjectByName('Unterarm', true);
      // linke Hand = Ende des linken Unterarms
      let leftElbow = null;
      view.root.traverse((o) => { if (o.name === 'Unterarm' && o.parent.parent.position.x < 0) leftElbow = o.parent; });
      assert.ok(elbowL && leftElbow);
      left.set(0, -0.28, 0).applyMatrix4(leftElbow.matrixWorld);
      // Lauf-Richtung = −Y der Hand
      forward.set(0, -1, 0).transformDirection(view.rightHand.matrixWorld);
      assert.close(forward.y, Math.sin(pitch), 0.08, `Waffe zeigt mit dem Blick (Neigung ${pitch})`);
      const along = left.clone().sub(right).dot(forward);
      assert.ok(along > 0.22 && along < 0.45, `linke Hand vorn am Lauf (${along.toFixed(2)} m)`);
      assert.ok(left.distanceTo(right.clone().addScaledVector(forward, 0.34)) < 0.1, 'linke Hand am Vorderschaft');
    }
    view.dispose();
  });

  it('alle Bewegungen laufen ohne Fehler (Laufen, Rennen, Springen, Ducken, Zielen, Bauen, Hacke, Tanz, Treffer, Umfallen)', () => {
    const game = { time: 0 };
    for (const skin of CONFIG.skins.list) {
      const c = new Character(game, { skin: skin.id });
      const view = createCharacterView(c, new THREE.Scene());
      const states = [
        () => { c.velocity.set(6, 0, 0); },
        () => { c.velocity.set(7.5, 0, 0); },
        () => { c.grounded = false; },
        () => { c.grounded = true; c.crouching = true; },
        () => { c.crouching = false; c.aiming = true; c.mode = 'weapon'; c.slots[0] = { id: 'ar' }; },
        () => { c.aiming = false; c.mode = 'build'; c.triggerAction('build'); },
        () => { c.mode = 'pickaxe'; c.triggerAction('pickaxe'); },
        () => { c.emoteUntil = game.time + 2; },
        () => { c.emoteUntil = 0; c.health -= 20; },
        () => { c.alive = false; c.deathTime = game.time; },
      ];
      for (const set of states) {
        set();
        for (let i = 0; i < 10; i++) {
          game.time += 1 / 60;
          view.update(1, 1 / 60);
        }
        view.root.traverse((o) => {
          for (const v of [o.position.x, o.position.y, o.quaternion.x, o.quaternion.w]) assert.ok(Number.isFinite(v), `${skin.id}: ${o.name}`);
        });
      }
      view.dispose();
    }
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
