// Tests für die Figur (src/player.js): Schaden, Heilen, Auswahl, Befehl
import { describe, it, assert } from './runner.js';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { Character, createCommand, resetCommand } from '../src/player.js';
import { EventBus } from '../src/core/events.js';

function fakeGame() {
  const events = new EventBus();
  const log = [];
  for (const name of ['characterDamaged', 'characterKilled', 'shieldBroken', 'heal', 'weaponSwitched']) {
    events.on(name, (p) => log.push([name, p]));
  }
  return { time: 0, tick: 0, events, log, building: { canEdit: () => false, closeEdit() {} } };
}

describe('Figur: Schaden und Heilen', () => {
  it('Schild nimmt Schaden zuerst, dann Leben; Ereignisse kommen', () => {
    const game = fakeGame();
    const c = new Character(game, { health: 100, shield: 50 });
    const r = c.applyDamage(70, { kind: 'bullet', weaponId: 'ar' });
    assert.deepEqual([r.shieldDamage, r.healthDamage, r.killed], [50, 20, false]);
    assert.equal(c.shield, 0);
    assert.equal(c.health, 80);
    const names = game.log.map(([n]) => n);
    assert.deepEqual(names, ['characterDamaged', 'shieldBroken']);
    const dmg = game.log[0][1];
    assert.equal(dmg.amount, 70);
    assert.equal(dmg.weaponId, 'ar');
    assert.equal(c.stats.damageTaken, 70);
  });

  it('besiegt: characterKilled mit Täter, Statistik zählt', () => {
    const game = fakeGame();
    const victim = new Character(game, { health: 30, shield: 0 });
    const killer = new Character(game, {});
    const r = victim.applyDamage(50, { attacker: killer, weaponId: 'shotgun' });
    assert.ok(r.killed && !victim.alive);
    assert.equal(victim.health, 0);
    assert.equal(r.healthDamage, 30, 'nur so viel Schaden wie Leben da war');
    const killed = game.log.find(([n]) => n === 'characterKilled')[1];
    assert.equal(killed.victim, victim);
    assert.equal(killed.killer, killer);
    assert.equal(killer.stats.kills, 1);
    assert.equal(killer.stats.damageDealt, 30);
    assert.equal(victim.applyDamage(10).healthDamage, 0, 'Besiegte nehmen keinen Schaden mehr');
  });

  it('unverwundbar: kein Schaden bis invulnerableUntil (außer ignoreInvulnerable)', () => {
    const game = fakeGame();
    const c = new Character(game, { shield: 0 });
    c.invulnerableUntil = 2;
    assert.equal(c.applyDamage(40).healthDamage, 0);
    assert.equal(c.health, 100);
    assert.equal(c.applyDamage(40, { ignoreInvulnerable: true }).healthDamage, 40);
    game.time = 2.5;
    assert.equal(c.applyDamage(10).healthDamage, 10);
  });

  it('bypassShield: Schaden direkt auf das Leben', () => {
    const c = new Character(fakeGame(), { shield: 100 });
    c.applyDamage(30, { bypassShield: true });
    assert.equal(c.shield, 100);
    assert.equal(c.health, 70);
  });

  it('heal: höchstens bis maxTo und bis zum Maximum', () => {
    const game = fakeGame();
    const c = new Character(game, { health: 60, shield: 0 });
    assert.equal(c.heal('health', 15, 75), 15);
    assert.equal(c.heal('health', 15, 75), 0, 'Verband: nicht über 75');
    assert.equal(c.heal('health', 100), 25);
    assert.equal(c.health, CONFIG.player.maxHealth);
    assert.equal(c.heal('shield', 25, 50), 25);
    assert.equal(c.heal('shield', 500), CONFIG.player.maxShield - 25);
    assert.ok(game.log.some(([n, p]) => n === 'heal' && p.kind === 'shield'));
  });
});

describe('Figur: Richtungen und Augen', () => {
  it('yaw 0 schaut nach −Z, yaw 90° nach −X (ARCHITECTURE.md)', () => {
    const c = new Character(null, {});
    const out = new THREE.Vector3();
    c.forward(out);
    assert.close(out.z, -1, 1e-9);
    c.yaw = Math.PI / 2;
    c.forward(out);
    assert.close(out.x, -1, 1e-9);
    c.yaw = 0;
    c.pitch = Math.PI / 4;
    c.aimDirection(out);
    assert.close(out.y, Math.SQRT1_2, 1e-9);
    assert.close(out.length(), 1, 1e-9);
  });

  it('Augenhöhe: stehend und geduckt', () => {
    const c = new Character(null, { position: { x: 1, y: 2, z: 3 } });
    const eye = new THREE.Vector3();
    c.eyePosition(eye);
    assert.close(eye.y, 2 + CONFIG.player.eyeHeight, 1e-9);
    c.crouching = true;
    c.eyePosition(eye);
    assert.close(eye.y, 2 + CONFIG.player.crouchEyeHeight, 1e-9);
  });

  it('resetForRound: Leben, Schild, Position, Zustand zurück', () => {
    const game = fakeGame();
    const c = new Character(game, { health: 100, shield: 100 });
    c.applyDamage(500);
    c.crouching = true;
    c.slots[1] = { id: 'ar', kind: 'weapon', ammo: 3 };
    c.resetForRound({ health: 100, shield: 50, position: { x: 5, y: 0, z: 5 }, yaw: 1, materials: { wood: 200 } });
    assert.ok(c.alive);
    assert.equal(c.health, 100);
    assert.equal(c.shield, 50);
    assert.ok(!c.crouching);
    assert.equal(c.height, CONFIG.player.hitbox.height);
    assert.deepEqual(c.position.toArray(), [5, 0, 5]);
    assert.deepEqual(c.prevPosition.toArray(), [5, 0, 5], 'kein Rutschen in der Grafik');
    assert.equal(c.slots[1].ammo, CONFIG.weapons.ar.magazine, 'Magazin voll');
    assert.equal(c.materials.wood, 200);
    assert.equal(c.materials.stone, 0);
  });
});

describe('Figur: Auswahl (Bauen, Waffe, Edit)', () => {
  function select(c, fields) {
    const cmd = resetCommand(createCommand());
    Object.assign(cmd, fields);
    c.applySelection(cmd);
  }

  it('Bau-Taste → sofort Baumodus mit diesem Bauteil; Waffen-Taste verlässt ihn', () => {
    const c = new Character(fakeGame(), {});
    select(c, { selectBuild: 'ramp' });
    assert.equal(c.mode, 'build');
    assert.equal(c.buildPiece, 'ramp');
    select(c, { selectBuild: 'wall' });
    assert.equal(c.buildPiece, 'wall');
    select(c, { selectSlot: 2 });
    assert.equal(c.mode, 'weapon');
    select(c, { selectBuild: 'floor' });
    select(c, { selectPickaxe: true });
    assert.equal(c.mode, 'pickaxe');
  });

  it('Waffen-Platz mit Gegenstand wird gewählt (weaponSwitched)', () => {
    const game = fakeGame();
    const c = new Character(game, {});
    c.slots[2] = { id: 'sniper', kind: 'weapon' };
    select(c, { selectSlot: 3 });
    assert.equal(c.selectedSlot, 2);
    assert.ok(game.log.some(([n, p]) => n === 'weaponSwitched' && p.slot === 2));
    select(c, { selectSlot: 5 }); // leer
    assert.equal(c.selectedSlot, 2, 'leerer Platz ändert die Auswahl nicht');
  });

  it('G: Edit nur, wenn das Bau-System es erlaubt; Waffe wählen schließt Edit', () => {
    const game = fakeGame();
    const c = new Character(game, {});
    select(c, { selectBuild: 'wall' });
    select(c, { editPressed: true });
    assert.equal(c.mode, 'build', 'Attrappe sagt: nicht editierbar');
    let closed = 0;
    game.building = { canEdit: () => true, closeEdit: () => closed++ };
    game.tick = 7;
    select(c, { editPressed: true });
    assert.equal(c.mode, 'edit');
    assert.equal(c.modeBeforeEdit, 'build');
    assert.equal(c.editOpenedTick, 7);
    select(c, { editPressed: true });
    assert.equal(c.mode, 'edit', 'zweites G bestätigt – das macht das Bau-System');
    select(c, { selectSlot: 1 });
    assert.equal(closed, 1);
    assert.equal(c.mode, 'weapon');
  });

  it('Controller: toggleBuild an/aus kehrt zum letzten Kampf-Modus zurück', () => {
    const c = new Character(fakeGame(), {});
    select(c, { selectPickaxe: true });
    select(c, { toggleBuild: true });
    assert.equal(c.mode, 'build');
    select(c, { toggleBuild: true });
    assert.equal(c.mode, 'pickaxe');
  });

  it('Mausrad: im Baumodus Bauteile durchschalten, Q wechselt das Material', () => {
    const c = new Character(fakeGame(), {});
    select(c, { selectBuild: 'wall' });
    select(c, { nextItem: true });
    assert.equal(c.buildPiece, 'floor');
    select(c, { prevItem: true });
    select(c, { prevItem: true });
    assert.equal(c.buildPiece, 'roof');
    select(c, { switchMaterial: true });
    assert.equal(c.currentMaterial, 'stone');
    select(c, { switchMaterial: true });
    select(c, { switchMaterial: true });
    assert.equal(c.currentMaterial, 'wood');
  });

  it('Mausrad außerhalb des Baumodus: Spitzhacke und belegte Plätze', () => {
    const c = new Character(fakeGame(), {});
    c.slots[0] = { id: 'shotgun', kind: 'weapon' };
    c.slots[3] = { id: 'smg', kind: 'weapon' };
    c.mode = 'weapon';
    c.selectedSlot = 0;
    select(c, { nextItem: true });
    assert.equal(c.selectedSlot, 3);
    select(c, { nextItem: true });
    assert.equal(c.mode, 'pickaxe');
  });

  it('Zielen nur mit Waffe in der Hand; Tanz nur am Boden', () => {
    const game = fakeGame();
    const c = new Character(game, {});
    select(c, { secondary: true });
    assert.ok(c.aiming);
    select(c, { selectBuild: 'wall', secondary: true });
    assert.ok(!c.aiming, 'im Baumodus kein Zielen');
    select(c, { emotePressed: true });
    assert.close(c.emoteUntil, CONFIG.player.emoteDuration, 1e-9);
  });

  it('createCommand hat alle Felder aus ARCHITECTURE.md', () => {
    const cmd = createCommand();
    const fields = ['moveX', 'moveZ', 'yaw', 'pitch', 'jump', 'jumpPressed', 'crouch', 'sprint', 'primary', 'primaryPressed',
      'primaryReleased', 'secondary', 'secondaryPressed', 'selectSlot', 'selectPickaxe', 'selectBuild', 'toggleBuild',
      'reloadOrRotate', 'editPressed', 'editReleased', 'usePressed', 'emotePressed', 'switchMaterial', 'nextItem', 'prevItem',
      'aimOrigin', 'aimDir'];
    for (const f of fields) assert.ok(f in cmd, f);
    assert.ok(cmd.aimDir.isVector3);
  });
});
