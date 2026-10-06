// Szenario-Tests: Welt (Welle 3b) – Sturm macht Schaden, Absprung mit Gleiter,
// Kiste öffnen + Waffe aufheben (E), Besiegte lassen alles fallen, ins Haus und
// die Treppe hinauf (normale Bewegung auf dem Insel-Gelände)
import { describe, it, assert } from '../runner.js';
import { CONFIG } from '../../src/config.js';
import { createTestGame, addDrivenCharacter, collect } from './helpers.js';
import { createArenaMap } from '../../src/world/mapArena.js';
import { createIslandMap } from '../../src/world/mapIsland.js';
import { createStorm } from '../../src/world/storm.js';
import { createLootSystem } from '../../src/world/loot.js';
import { createJumpVehicle } from '../../src/world/jumpVehicle.js';
import { heightAboveGround } from '../../src/world/skydive.js';

const BR = CONFIG.modes.battleRoyale;

// Läuft eine Liste von Wegpunkten ab (Blick zum nächsten Punkt, W gedrückt)
function followPath(game, c, fields, points, maxSeconds = 20, tolerance = 0.25) {
  let i = 0;
  const steps = Math.round(maxSeconds * 60);
  for (let s = 0; s < steps && i < points.length; s++) {
    const p = points[i];
    const dx = p.x - c.position.x;
    const dz = p.z - c.position.z;
    if (Math.hypot(dx, dz) < tolerance) {
      i++;
      fields.moveZ = 0;
      continue;
    }
    fields.yaw = Math.atan2(-dx, -dz);
    fields.moveZ = Math.min(1, Math.hypot(dx, dz) / 0.6 + 0.15);
    game.fixedUpdate(1 / 60);
  }
  fields.moveZ = 0;
  game.simulate(0.3);
  return i;
}

describe('Szenario: Sturm-Zone', () => {
  it('draußen: Schaden pro Sekunde aufs Leben (Schild bleibt), drinnen: nichts', () => {
    const game = createTestGame();
    game.map = createArenaMap(game, { size: 80 });
    game.storm = createStorm(game, { initialRadius: 20, center: { x: 0, z: 0 }, phases: [{ wait: 100, shrink: 10, dps: 5, endRadius: 10 }] });
    const inside = addDrivenCharacter(game, { name: 'Drinnen', position: { x: 0, y: 0, z: 0 }, shield: 50 });
    const outside = addDrivenCharacter(game, { name: 'Draußen', position: { x: 30, y: 0, z: 0 }, shield: 50 });
    const damage = collect(game, 'characterDamaged');
    game.simulate(3);
    assert.equal(inside.health, 100);
    assert.equal(outside.health, 100 - 3 * 5, 'Leben');
    assert.equal(outside.shield, 50, 'Schild hilft nicht gegen den Sturm');
    assert.ok(damage.every((d) => d.kind === 'storm' && d.character === outside));
    // läuft er hinein, hört der Schaden auf
    outside.spawnAt({ x: 5, y: 0, z: 0 });
    game.simulate(2);
    assert.equal(outside.health, 85);
    game.dispose();
  });
});

describe('Szenario: Absprung mit Gleiter', () => {
  it('Ballon → Leertaste über der Insel → freier Fall → Gleiter bei 30 m → Landung ohne Fallschaden', () => {
    const game = createTestGame({ seed: 4 });
    const map = createIslandMap(game, {});
    game.map = map;
    const c = addDrivenCharacter(game, { name: 'Springer', shield: 0 });
    const vehicle = createJumpVehicle(game, { path: map.jumpPath(game.rng) });
    game.systems.push(vehicle);
    vehicle.board(c);
    assert.equal(c.moveState, 'vehicle');
    // fährt mit (auf der Plattform)
    game.simulate(1);
    assert.close(c.position.y, BR.jumpVehicleHeight, 1e-9, 'steht auf der Plattform');
    assert.ok(c.position.distanceTo(vehicle.position) < CONFIG.skydive.deckSize, 'auf dem Fahrzeug');
    // Leertaste über dem Meer: nichts passiert
    assert.ok(!vehicle.canDrop());
    c.brain.fields.jumpPressed = true;
    game.simulate(1 / 60);
    assert.equal(c.moveState, 'vehicle', 'über dem Meer noch nicht abspringen');
    let guard = 0;
    while (!vehicle.canDrop() && guard++ < 6000) game.fixedUpdate(1 / 60);
    game.simulate(2);
    c.brain.fields.jumpPressed = true;
    game.simulate(1 / 60);
    assert.equal(c.moveState, 'freefall');
    // fallen lassen und Höhe beim Öffnen merken
    const states = collect(game, 'skydive');
    const lands = collect(game, 'land');
    let glideHeight = null;
    let maxFallSpeed = 0;
    for (let i = 0; i < 60 * 60 && c.moveState !== 'ground'; i++) {
      game.fixedUpdate(1 / 60);
      maxFallSpeed = Math.max(maxFallSpeed, -c.velocity.y);
      if (c.moveState === 'glide' && glideHeight === null) glideHeight = heightAboveGround(c, game.world);
    }
    assert.ok(maxFallSpeed <= BR.freefallSpeed + 0.5 && maxFallSpeed > BR.freefallSpeed - 1, `Fall-Tempo ${maxFallSpeed.toFixed(1)}`);
    assert.ok(glideHeight !== null && glideHeight <= BR.gliderDeployHeight + 1e-6 && glideHeight > BR.gliderDeployHeight - 1.5,
      `Gleiter öffnet bei ${glideHeight?.toFixed(2)} m über dem Boden`);
    assert.deepEqual(states.map((s) => s.state), ['glide']);
    assert.equal(c.moveState, 'ground');
    assert.ok(lands.length === 1 && lands[0].fallHeight > BR.gliderDeployHeight, 'Landung gemeldet (hoher Fall)');
    assert.equal(c.health, 100, 'kein Fallschaden');
    assert.ok(Math.abs(c.position.y - game.world.surfaceHeight(c.position.x, c.position.z, c.position.y + 0.01)) < 1e-6, 'steht auf dem Boden');
    // Fahrzeug fliegt weiter; am Ende sind alle abgesprungen
    game.simulate(60);
    assert.equal(vehicle.riders.length, 0);
    vehicle.dispose();
    game.dispose();
  });

  it('wer am Ende noch drauf ist, wird über der Insel abgesetzt (Bots springen verteilt ab)', () => {
    const game = createTestGame({ seed: 9 });
    const map = createIslandMap(game, {});
    game.map = map;
    const riders = [];
    for (let i = 0; i < 4; i++) riders.push(addDrivenCharacter(game, { name: `Bot ${i}`, isBot: true }));
    const stay = addDrivenCharacter(game, { name: 'Bleibt' });
    const vehicle = createJumpVehicle(game, { path: map.jumpPath(game.rng) });
    game.systems.push(vehicle);
    for (const c of [...riders, stay]) vehicle.board(c);
    vehicle.scheduleBotDrops(game.rng);
    const drops = collect(game, 'vehicleDrop');
    game.simulate(70);
    assert.equal(drops.length, 5);
    for (const d of drops) assert.ok(map.contains(d.character.position.x, d.character.position.z), 'über der Insel abgesetzt');
    const times = drops.filter((d) => d.character.isBot).map((d) => d.character.time);
    assert.equal(drops[drops.length - 1].character, stay, 'der Spieler zuletzt (am Rand)');
    assert.ok(times.length === 4);
    vehicle.dispose();
    game.dispose();
  });
});

describe('Szenario: Loot', () => {
  function lootGame() {
    const game = createTestGame({ seed: 6 });
    game.map = createArenaMap(game, { size: 80 });
    game.loot = createLootSystem(game, {});
    return game;
  }

  it('E an der Kiste: sie öffnet sich, eine Waffe springt heraus, E hebt sie auf', () => {
    const game = lootGame();
    const chest = game.loot.spawnChest({ x: 0, y: 0, z: -2 }, { yaw: 0 });
    const c = addDrivenCharacter(game, { name: 'Spieler', isPlayer: true, position: { x: 0, y: 0, z: 0.5 }, yaw: 0 });
    c.brain.fields.pitch = -0.3;
    game.simulate(0.1);
    assert.equal(game.interactionPrompt?.kind, 'chest', 'Hinweis "Kiste öffnen"');
    assert.equal(game.interactionPrompt.action, 'use');
    const opened = collect(game, 'chestOpened');
    c.brain.fields.usePressed = true;
    game.simulate(1 / 60);
    c.brain.fields.usePressed = false;
    assert.equal(opened.length, 1);
    assert.ok(chest.opened && chest.collider === null);
    game.simulate(CONFIG.loot.popTime + 0.2);
    const weapon = game.loot.items.find((fi) => fi.kind === 'weapon');
    assert.ok(weapon, 'Waffe liegt am Boden');
    assert.ok(game.loot.items.some((fi) => fi.kind === 'ammo' && fi.weaponId === weapon.item.id), 'passende Munition');
    // Material wurde im Vorbeilaufen schon eingesammelt? (liegt nah) – spätestens nach dem Hinlaufen
    // zur Waffe gehen und hinschauen
    const dx = weapon.position.x - c.position.x;
    const dz = weapon.position.z - c.position.z;
    c.brain.fields.yaw = Math.atan2(-dx, -dz);
    game.simulate(0.1);
    assert.equal(game.interactionPrompt?.target, weapon, 'Hinweis zeigt die Waffe');
    const picked = collect(game, 'pickup');
    c.brain.fields.usePressed = true;
    game.simulate(1 / 60);
    c.brain.fields.usePressed = false;
    game.simulate(0.3);
    const slot = c.slots.findIndex((s) => s === weapon.item);
    assert.ok(slot >= 0, 'Waffe im Inventar');
    assert.equal(c.selectedSlot, slot, 'gleich in der Hand');
    assert.ok(picked.some((p) => p.item === weapon));
    assert.ok(weapon.removed);
    // Munition wurde danach automatisch eingesammelt (liegt in Reichweite?) oder liegt noch da
    const ammo = game.loot.items.find((fi) => fi.kind === 'ammo');
    assert.ok(!ammo || Math.hypot(ammo.position.x - c.position.x, ammo.position.z - c.position.z) > CONFIG.loot.autoPickupRadius - 1e-6 || weapon.item.reserve > 0);
    game.dispose();
  });

  it('Besiegte lassen alles fallen (Waffen, Heil-Items, Material)', () => {
    const game = lootGame();
    const victim = addDrivenCharacter(game, { name: 'Opfer', position: { x: 10, y: 0, z: 10 }, materials: { wood: 50, stone: 20, metal: 0 } });
    game.weapons.giveLoadout(victim, ['shotgun', 'ar', 'bandage'], { healCount: 2 });
    game.simulate(0.1);
    const dropped = collect(game, 'lootDropped');
    victim.applyDamage(500, { kind: 'bullet' });
    game.simulate(1 / 60);
    assert.equal(dropped.length, 1);
    const items = game.loot.items;
    assert.equal(items.length, 5);
    assert.ok(items.every((fi) => Math.hypot(fi.position.x - 10, fi.position.z - 10) <= CONFIG.loot.scatterRadius.max + 1e-6));
    assert.ok(victim.slots.every((s) => !s) && victim.materials.wood === 0);
    game.dispose();
  });
});

describe('Szenario: Haus auf der Insel', () => {
  it('durch die Tür hinein und die Treppe hinauf in den 2. Stock (normale Bewegung)', () => {
    const game = createTestGame({ seed: 1 });
    const map = createIslandMap(game, {});
    game.map = map;
    const house = map.houses.find((h) => h.floors === 2 && h.area === 'Sandkrug');
    assert.ok(house, 'Haus mit 2 Stockwerken');
    const out = house.door.outside;
    const c = addDrivenCharacter(game, { name: 'Besucher', position: { x: out.x, y: house.y, z: out.z } });
    const f = c.brain.fields;
    const T = 0.3;
    const points = [
      house.door.inside,
      house.toWorld(0.75, 2.8),
      house.toWorld(0.75, T + 0.7),
      house.toWorld(house.width - 1.1, T + 0.7),
    ];
    const reached = followPath(game, c, f, points, 25);
    assert.equal(reached, points.length, `Wegpunkte erreicht: ${reached}/${points.length} (bei ${c.position.x.toFixed(2)}, ${c.position.y.toFixed(2)}, ${c.position.z.toFixed(2)})`);
    assert.close(c.position.y, house.floorY[1], 1e-3, '2. Stock');
    const b = house.bounds;
    assert.ok(c.position.x > b.minX && c.position.x < b.maxX && c.position.z > b.minZ && c.position.z < b.maxZ, 'im Haus');
    assert.equal(c.health, 100);
    game.dispose();
  });
});
