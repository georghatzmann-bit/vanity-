// Tests für die Welt (Welle 3b): Sturm-Zone, Loot-Regeln, Gelände, Karten, Startpunkte
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/util/random.js';
import { Game } from '../src/core/game.js';
import { createStorm } from '../src/world/storm.js';
import { createLootSystem, weightedPick } from '../src/world/loot.js';
import { createHeightfield, sampleHeights, createNoise, limitSlopes } from '../src/world/terrain.js';
import { createIslandMap } from '../src/world/mapIsland.js';
import { createArenaMap } from '../src/world/mapArena.js';
import { createZoneWarsMap } from '../src/world/mapZoneWars.js';
import { findSpawnPoints } from '../src/world/spawnPoints.js';
import { bodyFits } from '../src/player.js';

const BR = CONFIG.modes.battleRoyale;
const ZW = CONFIG.modes.zoneWars;

// Spiel-Ersatz für den Sturm (nur das, was er braucht)
function stormGame(seed, extra = {}) {
  const events = [];
  return {
    rng: createRng(seed),
    time: 0,
    characters: [],
    events: { emit: (name, e) => events.push([name, e]), on() {} },
    eventsLog: events,
    ...extra,
  };
}

// Sturm bis zum Ende laufen lassen; prüft bei jedem Phasen-Start "neue Zone in der alten"
function runStorm(spec, seed, check) {
  const game = stormGame(seed);
  const storm = createStorm(game, spec);
  let phase = -1;
  for (let guard = 0; guard < 5000 && storm.state !== 'closed'; guard++) {
    if (storm.state === 'wait' && storm.phase !== phase) {
      phase = storm.phase;
      check(storm);
    }
    storm.update(0.5);
  }
  return storm;
}

describe('Sturm-Zone', () => {
  it('neue Zone liegt immer komplett in der alten (200 Startwerte, Battle Royale)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      runStorm(BR.storm, seed, (s) => {
        const d = Math.hypot(s.nextCenter.x - s.center.x, s.nextCenter.z - s.center.z);
        assert.ok(d + s.nextRadius <= s.radius + 1e-6, `Startwert ${seed}, Phase ${s.phase + 1}: ${d.toFixed(2)} + ${s.nextRadius} > ${s.radius}`);
      });
    }
  });

  it('wandernde Zone (Zone Wars) liegt auch immer in der alten und wandert deutlich', () => {
    let moved = 0;
    for (let seed = 1; seed <= 200; seed++) {
      runStorm(ZW.storm, seed, (s) => {
        const d = Math.hypot(s.nextCenter.x - s.center.x, s.nextCenter.z - s.center.z);
        assert.ok(d + s.nextRadius <= s.radius + 1e-6, `Startwert ${seed}`);
        const allowed = s.radius - s.nextRadius;
        if (allowed > 0 && d >= allowed * CONFIG.stormZone.movingShiftFraction - 1e-6) moved++;
      });
    }
    assert.ok(moved >= 200 * ZW.storm.phases.length * 0.95, `deutlich gewandert: ${moved}`);
  });

  it('Schrumpfen: Radius und Mitte wandern gleichmäßig (Hälfte der Zeit = Hälfte des Wegs)', () => {
    const game = stormGame(7);
    const storm = createStorm(game, BR.storm);
    const p = BR.storm.phases[0];
    const c0 = storm.center.clone();
    const target = storm.nextCenter.clone();
    storm.update(p.wait);
    assert.equal(storm.state, 'shrink');
    storm.update(p.shrink / 2);
    assert.close(storm.radius, (BR.storm.initialRadius + p.endRadius) / 2, 1e-6, 'Radius');
    assert.close(storm.center.x, (c0.x + target.x) / 2, 1e-6, 'Mitte x');
    assert.close(storm.center.z, (c0.z + target.z) / 2, 1e-6, 'Mitte z');
    storm.update(p.shrink / 2);
    assert.equal(storm.state, 'wait');
    assert.equal(storm.phase, 1);
    assert.close(storm.radius, p.endRadius, 1e-9);
  });

  it('Schaden pro Sekunde je Phase wie in config.js, letzte Zone hat Radius 0', () => {
    const game = stormGame(3);
    const storm = createStorm(game, BR.storm);
    const seen = [];
    for (let guard = 0; guard < 2000 && storm.state !== 'closed'; guard++) {
      if (seen[storm.phase] === undefined) seen[storm.phase] = storm.damagePerSecond;
      storm.update(1);
    }
    assert.deepEqual(seen, BR.storm.phases.map((p) => p.dps));
    assert.equal(storm.radius, 0);
    assert.equal(storm.state, 'closed');
    assert.ok(!storm.isInside(storm.center) || storm.radius === 0, 'Radius 0');
  });

  it('isInside / distanceToEdge', () => {
    const storm = createStorm(stormGame(1), { initialRadius: 50, phases: [{ wait: 10, shrink: 10, dps: 1, endRadius: 20 }], center: { x: 10, z: 0 } });
    assert.ok(storm.isInside({ x: 10, y: 0, z: 49 }));
    assert.ok(!storm.isInside({ x: 10, y: 0, z: 51 }));
    assert.close(storm.distanceToEdge({ x: 10, z: 30 }), 20, 1e-9);
    assert.close(storm.distanceToEdge({ x: 70, z: 0 }), -10, 1e-9);
    // Höhe zählt nicht
    assert.ok(storm.isInside({ x: 10, y: 500, z: 0 }));
  });

  it('meldet jeden Wechsel (stormPhase), große Zeitschritte überspringen nichts', () => {
    const game = stormGame(2);
    const storm = createStorm(game, ZW.storm);
    storm.update(1000);
    const states = game.eventsLog.filter(([n]) => n === 'stormPhase').map(([, e]) => `${e.phase}:${e.state}`);
    const expected = ['0:wait'];
    ZW.storm.phases.forEach((p, i) => {
      expected.push(`${i}:shrink`);
      expected.push(i + 1 < ZW.storm.phases.length ? `${i + 1}:wait` : `${i}:closed`);
    });
    assert.deepEqual(states, expected);
  });

  it('Schaden in festen Schritten: draußen dps × Sekunden aufs Leben (Schild hilft nicht), drinnen nichts', () => {
    const hits = [];
    const mk = (x) => ({ alive: true, moveState: 'ground', position: { x, y: 0, z: 0 }, applyDamage(a, info) { hits.push([x, a, info.kind, info.bypassShield]); } });
    const game = stormGame(1, { characters: [mk(0), mk(100)] });
    const storm = createStorm(game, { initialRadius: 50, phases: [{ wait: 100, shrink: 10, dps: 4, endRadius: 10 }], center: { x: 0, z: 0 } });
    for (let i = 0; i < 180; i++) storm.update(1 / 60);
    assert.deepEqual(hits, [[100, 4, 'storm', true], [100, 4, 'storm', true], [100, 4, 'storm', true]]);
  });

  it('autoStart: false → Uhr steht bis start()', () => {
    const storm = createStorm(stormGame(1), { ...BR.storm, autoStart: false });
    storm.update(100);
    assert.equal(storm.timeLeft, BR.storm.phases[0].wait);
    storm.start();
    storm.update(10);
    assert.close(storm.timeLeft, BR.storm.phases[0].wait - 10, 1e-9);
  });

  it('bevorzugt Land (map.isLand)', () => {
    const map = { center: { x: 0, z: 0 }, isLand: (x) => x > 0 };
    let land = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const storm = createStorm(stormGame(seed, { map }), BR.storm);
      if (storm.nextCenter.x > 0) land++;
    }
    assert.ok(land >= 38, `an Land: ${land} von 40`);
  });
});

describe('Loot-Regeln', () => {
  const game = new Game({ headless: true, seed: 5 });
  const loot = createLootSystem(game, {});

  it('Seltenheit verteilt sich wie die Gewichte (20 000 Würfe)', () => {
    const rng = createRng(99);
    const counts = {};
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const r = weightedPick(BR.rarityWeights, rng);
      counts[r] = (counts[r] ?? 0) + 1;
    }
    const total = Object.values(BR.rarityWeights).reduce((a, b) => a + b, 0);
    for (const [id, w] of Object.entries(BR.rarityWeights)) {
      const expected = w / total;
      const got = (counts[id] ?? 0) / n;
      assert.ok(Math.abs(got - expected) < 0.015, `${id}: ${got.toFixed(3)} statt ${expected.toFixed(3)}`);
    }
  });

  it('Kiste: 1 Waffe + Munition dafür + Material (+ Heil-Item mit Wahrscheinlichkeit)', () => {
    const rng = createRng(4);
    let heals = 0;
    for (let i = 0; i < 400; i++) {
      const c = loot.chestContents(rng);
      const weapons = c.filter((d) => d.kind === 'weapon');
      assert.equal(weapons.length, 1);
      const ammo = c.find((d) => d.kind === 'ammo');
      assert.equal(ammo.weaponId, weapons[0].id, 'passende Munition');
      assert.equal(ammo.amount, Math.round(CONFIG.weapons[ammo.weaponId].magazine * BR.chest.ammoMagazines));
      const mat = c.find((d) => d.kind === 'material');
      assert.ok(CONFIG.materials.order.includes(mat.material) && mat.amount === BR.chest.materialAmount);
      assert.ok(CONFIG.rarities[weapons[0].rarity], 'Seltenheit');
      if (c.some((d) => d.kind === 'heal')) heals++;
    }
    assert.ok(Math.abs(heals / 400 - BR.chest.healItemChance) < 0.08, `Heil-Items: ${heals}/400`);
  });

  it('Aufheben: Waffe auf ihren Platz, voll → Tausch mit dem gewählten Platz (alter fällt hin)', () => {
    const c = game.addCharacter({ name: 'Sammler', position: { x: 0, y: 0, z: 0 } });
    const fi = (id, rarity = 'rare') => loot.spawnFloorItem({ kind: 'weapon', id, rarity, position: { x: 1, y: 0, z: 0 } });
    assert.ok(loot.pickUp(c, fi('shotgun')));
    assert.equal(c.slots[0].id, 'shotgun');
    loot.pickUp(c, fi('sniper'));
    assert.equal(c.slots[2].id, 'sniper');
    loot.pickUp(c, fi('ar'));
    loot.pickUp(c, fi('smg'));
    // zweite Schrotflinte: Platz 1 belegt → nächster freier (Platz 5 nur, wenn sonst nichts frei)
    loot.pickUp(c, fi('shotgun', 'epic'));
    assert.equal(c.slots[4].id, 'shotgun', 'letzter freier Platz');
    assert.ok(c.slots.every(Boolean), 'alles voll');
    c.selectedSlot = 1; // Sturmgewehr in der Hand
    const legendary = fi('pistol', 'legendary');
    const before = loot.items.length;
    assert.equal(loot.slotFor(c, legendary).swap, true);
    assert.ok(loot.pickUp(c, legendary));
    assert.equal(c.slots[1].id, 'pistol');
    assert.equal(c.slots[1].rarity, 'legendary');
    const dropped = loot.items.filter((x) => x.kind === 'weapon' && x.item.id === 'ar');
    assert.equal(dropped.length, 1, 'altes Sturmgewehr liegt am Boden');
    assert.equal(loot.items.length, before, 'eins aufgehoben, eins hingelegt');
    game.removeCharacter(c);
  });

  it('Heil-Items stapeln, Munition geht in die Reserve, Material bis 999', () => {
    const c = game.addCharacter({ name: 'Heiler', position: { x: 0, y: 0, z: 0 } });
    loot.pickUp(c, loot.spawnFloorItem({ kind: 'heal', id: 'bandage', count: 5, position: { x: 0, y: 0, z: 0 } }));
    loot.pickUp(c, loot.spawnFloorItem({ kind: 'heal', id: 'bandage', count: 4, position: { x: 0, y: 0, z: 0 } }));
    assert.equal(c.slots[CONFIG.weapons.healSlot - 1].count, 9);
    const ammo = loot.spawnFloorItem({ kind: 'ammo', weaponId: 'ar', amount: 45, position: { x: 0, y: 0, z: 0 } });
    assert.equal(loot.collect(c, ammo), 0, 'ohne Sturmgewehr bleibt die Munition liegen');
    loot.pickUp(c, loot.spawnFloorItem({ kind: 'weapon', id: 'ar', position: { x: 0, y: 0, z: 0 } }));
    assert.equal(loot.collect(c, ammo), 45);
    assert.equal(c.slots[1].reserve, 45);
    c.materials.wood = 990;
    const wood = loot.spawnFloorItem({ kind: 'material', material: 'wood', amount: 30, position: { x: 0, y: 0, z: 0 } });
    assert.equal(loot.collect(c, wood), 9);
    assert.equal(c.materials.wood, 999);
    assert.equal(wood.amount, 21, 'Rest bleibt liegen');
    game.removeCharacter(c);
  });

  it('dropAll: alles fällt verstreut hin, Inventar und Material leer', () => {
    const c = game.addCharacter({ name: 'Opfer', position: { x: 5, y: 0, z: 5 }, materials: { wood: 120, stone: 0, metal: 40 } });
    game.weapons.giveLoadout(c, ['shotgun', 'ar', 'bandage'], { healCount: 3 });
    const items = loot.dropAll(c);
    assert.equal(items.length, 5, '3 Gegenstände + 2 Material-Stapel');
    assert.ok(c.slots.every((s) => s === null));
    assert.equal(c.materials.wood, 0);
    for (const fi of items) {
      const d = Math.hypot(fi.position.x - 5, fi.position.z - 5);
      assert.ok(d >= CONFIG.loot.scatterRadius.min - 1e-6 && d <= CONFIG.loot.scatterRadius.max + 1e-6, `verstreut: ${d.toFixed(2)}`);
      assert.equal(fi.fromMap, false);
    }
    assert.equal(items.find((x) => x.kind === 'material' && x.material === 'wood').amount, 120);
    game.removeCharacter(c);
  });

  it('fallen gelassene Gegenstände verschwinden nach der Zeit, Karten-Loot nicht', () => {
    const g = new Game({ headless: true, seed: 2 });
    const l = createLootSystem(g, {});
    const a = l.spawnFloorItem({ kind: 'material', material: 'stone', amount: 5, position: { x: 50, y: 0, z: 50 } });
    const b = l.spawnFloorItem({ kind: 'material', material: 'stone', amount: 5, position: { x: 60, y: 0, z: 60 }, fromMap: true });
    g.time = CONFIG.loot.droppedDespawnTime + 1;
    l.update(1 / 60);
    assert.ok(a.removed && !b.removed);
    l.dispose();
    g.dispose();
  });

  it('findNearestLoot (für Bots) mit Filter', () => {
    const g = new Game({ headless: true, seed: 2 });
    const l = createLootSystem(g, {});
    l.spawnChest({ x: 10, y: 0, z: 0 });
    l.spawnFloorItem({ kind: 'weapon', id: 'ar', rarity: 'common', position: { x: 3, y: 0, z: 0 } });
    l.spawnFloorItem({ kind: 'weapon', id: 'sniper', rarity: 'epic', position: { x: 6, y: 0, z: 0 } });
    const origin = { x: 0, y: 0, z: 0 };
    assert.equal(l.findNearestLoot(origin).item.id, 'ar');
    assert.ok(l.chests.includes(l.findNearestLoot(origin, { kinds: ['chest'] })));
    assert.equal(l.findNearestLoot(origin, { rarityAtLeast: 'rare', kinds: ['weapon'] }).item.id, 'sniper');
    assert.equal(l.findNearestLoot(origin, { maxDistance: 2 }), null);
    l.dispose();
    g.dispose();
  });

  it('E-Hinweis (game.interactionPrompt): Aufheben → Tauschen wenn voll, immer dasselbe Objekt, sonst null', () => {
    const g = new Game({ headless: true, seed: 3 });
    const l = createLootSystem(g, {});
    g.loot = l;
    const p = g.addCharacter({ name: 'Spieler', isPlayer: true, position: { x: 0, y: 0, z: 0 }, yaw: 0 });
    p.pitch = -0.4;
    const fi = l.spawnFloorItem({ kind: 'weapon', id: 'ar', rarity: 'epic', position: { x: 0, y: 0, z: -1.2 } });
    l.update(1 / 60);
    const prompt = g.interactionPrompt;
    assert.ok(prompt && prompt.target === fi && prompt.action === 'use' && prompt.kind === 'item');
    assert.equal(prompt.text, `Aufheben: ${fi.name} (${CONFIG.rarities.epic.name})`);
    assert.equal(prompt.swap, false);
    // alles voll → Tauschen (Text ändert sich, Objekt bleibt dasselbe)
    g.weapons.giveLoadout(p, ['shotgun', 'smg', 'sniper', 'pistol', 'bandage']);
    l.update(1 / 60);
    assert.equal(g.interactionPrompt, prompt, 'kein neues Objekt pro Tick');
    assert.ok(prompt.swap && prompt.text.startsWith('Tauschen: '), prompt.text);
    // zu weit weg → kein Hinweis
    p.position.set(0, 0, 8);
    l.update(1 / 60);
    assert.equal(g.interactionPrompt, null);
    l.dispose();
    g.dispose();
  });

  it('Bots: interact öffnet Kisten und hebt Gegenstände nur in Reichweite auf', () => {
    const g = new Game({ headless: true, seed: 4 });
    const l = createLootSystem(g, {});
    const bot = g.addCharacter({ name: 'Bot', isBot: true, position: { x: 0, y: 0, z: 0 } });
    const chest = l.spawnChest({ x: 6, y: 0, z: 0 });
    assert.equal(l.interact(bot, chest), false, 'zu weit weg');
    bot.position.set(4.2, 0, 0);
    assert.equal(l.interact(bot, chest), true);
    assert.ok(chest.opened);
    const weapon = l.items.find((fi) => fi.kind === 'weapon');
    bot.position.set(weapon.position.x, 0, weapon.position.z + 1);
    assert.equal(l.interact(bot, weapon), true);
    assert.ok(bot.slots.includes(weapon.item));
    l.dispose();
    g.dispose();
  });
});

describe('Gelände (Höhen-Raster)', () => {
  const noise = createNoise(12);
  const cell = 4;
  const n = 33;
  const heights = sampleHeights(-64, -64, cell, n, n, (x, z) => 10 * noise.fbm(x / 40, z / 40, 3));
  const field = createHeightfield({ minX: -64, minZ: -64, cell, countX: n, countZ: n, heights });

  it('an den Raster-Punkten genau die gespeicherte Höhe', () => {
    for (let iz = 0; iz < n; iz += 5) {
      for (let ix = 0; ix < n; ix += 7) {
        assert.close(field.heightAt(-64 + ix * cell, -64 + iz * cell), heights[iz * n + ix], 1e-5);
      }
    }
  });

  it('stetig: kleine Schritte → kleine Höhen-Änderung (keine Sprünge an Dreiecks-Kanten)', () => {
    let maxRise = 0;
    for (let i = 1; i < n; i++) for (let j = 0; j < n; j++) {
      maxRise = Math.max(maxRise, Math.abs(heights[j * n + i] - heights[j * n + i - 1]));
    }
    const slope = (maxRise * 2) / cell; // Diagonale kann bis zu doppelt so steil sein
    const rng = createRng(3);
    for (let k = 0; k < 2000; k++) {
      const x = -60 + rng() * 120;
      const z = -60 + rng() * 120;
      const e = 0.01;
      const a = rng() * Math.PI * 2;
      const d = Math.abs(field.heightAt(x + Math.cos(a) * e, z + Math.sin(a) * e) - field.heightAt(x, z));
      assert.ok(d <= slope * e * 1.5 + 1e-6, `Sprung ${d} bei ${x.toFixed(2)}, ${z.toFixed(2)}`);
    }
  });

  it('limitSlopes macht zu steile Stellen flacher', () => {
    const h = new Float32Array(9 * 9);
    h[4 * 9 + 4] = 50;
    limitSlopes(h, 9, 9, 2, 10);
    assert.ok(h[4 * 9 + 4] <= 2 * Math.SQRT2 + 1e-4 + 2, `Spitze ${h[4 * 9 + 4]}`);
  });
});

describe('Karten', () => {
  it('Insel: gleiche Karte bei gleichem Startwert, andere bei anderem; schnell genug', () => {
    const g1 = new Game({ headless: true, seed: 1 });
    const t0 = performance.now();
    const a = createIslandMap(g1, { seed: 3 });
    const ms = performance.now() - t0;
    const g2 = new Game({ headless: true, seed: 99 });
    const b = createIslandMap(g2, { seed: 3 });
    const g3 = new Game({ headless: true, seed: 1 });
    const c = createIslandMap(g3, { seed: 4 });
    const sum = (m) => {
      let s = 0;
      for (let i = 0; i < m.terrain.heights.length; i += 97) s += m.terrain.heights[i] * (i % 13);
      return s;
    };
    assert.equal(sum(a), sum(b), 'Gelände gleich');
    assert.deepEqual(a.houses.map((h) => [h.cx, h.cz, h.floors]), b.houses.map((h) => [h.cx, h.cz, h.floors]));
    assert.deepEqual(a.chestSpots.map((s) => [s.x, s.z]), b.chestSpots.map((s) => [s.x, s.z]));
    assert.ok(sum(a) !== sum(c), 'anderer Startwert, andere Insel');
    assert.ok(ms < 2000, `Erzeugen dauert ${ms.toFixed(0)} ms`);
    for (const g of [g1, g2, g3]) g.dispose();
  });

  it('Insel: Häuser (10–20, einige mit 2 Stockwerken), 25–40 Kisten, 80–150 Boden-Loot, Fluss, Hänge begehbar', () => {
    const g = new Game({ headless: true, seed: 1 });
    const map = createIslandMap(g, {});
    assert.ok(map.houses.length >= 10 && map.houses.length <= 20, `Häuser: ${map.houses.length}`);
    assert.ok(map.houses.some((h) => h.floors === 2), '2 Stockwerke');
    assert.ok(map.chestSpots.length >= 25 && map.chestSpots.length <= 40, `Kisten: ${map.chestSpots.length}`);
    assert.ok(map.floorLootSpots.length >= 80 && map.floorLootSpots.length <= 150, `Boden-Loot: ${map.floorLootSpots.length}`);
    assert.ok(map.props.trees.length >= 150 && map.props.rocks.length > 20 && map.props.cars.length > 5);
    // Fluss: flaches Wasser (begehbar) quer über die Insel
    let water = 0;
    for (let z = -150; z <= 150; z += 30) {
      const h = map.heightAt(map.riverX(z), z);
      if (h < map.seaLevel && h > map.seaLevel - 1.2) water++;
    }
    assert.ok(water >= 10, `Fluss an ${water} von 11 Stellen`);
    // Wüstenstadt flach, Namen
    const t = CONFIG.maps.island.town;
    assert.close(map.heightAt(t.x + 5, t.z - 5), t.height, 1e-6);
    assert.equal(map.areaAt(t.x, t.z), 'Sandkrug');
    let steepest = 0;
    for (let x = -280; x <= 280; x += 3) for (let z = -280; z <= 280; z += 3) {
      if (map.isLand(x, z)) steepest = Math.max(steepest, map.terrain.slopeAt(x, z));
    }
    assert.ok(Math.atan(steepest) * 180 / Math.PI < CONFIG.player.maxWalkableSlope, `steilster Hang ${(Math.atan(steepest) * 180 / Math.PI).toFixed(1)}°`);
    g.dispose();
  });

  it('Insel: Startpunkte und Loot-Plätze stecken nicht in Objekten', () => {
    const g = new Game({ headless: true, seed: 1 });
    const map = createIslandMap(g, {});
    const spawns = map.spawnPoints(24);
    assert.equal(spawns.length, 24);
    for (const p of spawns) {
      assert.ok(bodyFits(g.world, p.x, p.y + 0.01, p.z, 0.4, 1.8), `Startpunkt frei: ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
      assert.ok(map.isLand(p.x, p.z), 'an Land');
    }
    for (const s of [...map.chestSpots, ...map.floorLootSpots]) {
      assert.ok(bodyFits(g.world, s.x, s.y + 0.05, s.z, 0.3, 0.6), `Loot-Platz frei: ${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)}`);
    }
    g.dispose();
  });

  it('Insel: Flug-Linie des Absprung-Fahrzeugs quert die Insel', () => {
    const g = new Game({ headless: true, seed: 1 });
    const map = createIslandMap(g, {});
    const rng = createRng(8);
    for (let i = 0; i < 20; i++) {
      const path = map.jumpPath(rng);
      // der Punkt der Linie, der der Mitte am nächsten ist, liegt über der Insel
      const t = -path.start.dot(path.dir);
      const closest = path.start.clone().addScaledVector(path.dir, t);
      assert.ok(Math.hypot(closest.x, closest.z) < 150, 'nah an der Mitte');
      assert.ok(!map.contains(path.start.x, path.start.z) && !map.contains(path.end.x, path.end.z), 'beginnt und endet über dem Meer');
      assert.equal(path.start.y, BR.jumpVehicleHeight);
    }
    g.dispose();
  });

  it('Duell-Arena: Startpunkte 40 m auseinander, Felsen/Bäume (zum Sammeln), unsichtbare Wand über der Mauer', () => {
    const g = new Game({ headless: true, seed: 1 });
    const map = createArenaMap(g, { size: CONFIG.modes.duel.arenaSize, props: true });
    const [a, b] = map.spawnPoints(2);
    assert.close(Math.hypot(a.x - b.x, a.z - b.z), CONFIG.modes.duel.spawnDistance, 1e-9);
    const trees = map.props.trees.length;
    const rocks = map.props.rocks.length;
    assert.ok(trees >= 4 && rocks >= 4, `Bäume ${trees}, Felsen ${rocks}`);
    for (const p of map.props.list) {
      assert.ok(p.colliders[0].data.harvest, 'Spitzhacke sammelt');
      for (const s of [a, b]) assert.ok(Math.hypot(p.position.x - s.x, p.position.z - s.z) >= CONFIG.maps.arena.propSpawnClearance - 1e-6);
    }
    // über der Mauer (y = 10) geht es nicht hinaus
    const half = CONFIG.modes.duel.arenaSize / 2;
    assert.ok(!bodyFits(g.world, half + 0.2, 10, 0, 0.4, 1.8), 'unsichtbare Wand');
    assert.ok(bodyFits(g.world, half - 1, 10, 0, 0.4, 1.8), 'innen frei');
    map.dispose();
    g.dispose();
  });

  it('Zone Wars: verteilte Startpunkte (Abstand), alle auf freiem Boden', () => {
    const g = new Game({ headless: true, seed: 1 });
    const map = createZoneWarsMap(g, {});
    const pts = map.spawnPoints(ZW.totalPlayers);
    assert.equal(pts.length, ZW.totalPlayers);
    for (let i = 0; i < pts.length; i++) {
      assert.ok(map.contains(pts[i].x, pts[i].z, 5));
      assert.ok(bodyFits(g.world, pts[i].x, pts[i].y + 0.01, pts[i].z, 0.4, 1.8));
      for (let j = i + 1; j < pts.length; j++) {
        assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z) >= CONFIG.maps.zoneWars.spawnMinDistance * 0.75 - 1e-6);
      }
    }
    g.dispose();
  });

  it('Startpunkt-Helfer: Mindestabstand, nie in einer Kiste', () => {
    const g = new Game({ headless: true, seed: 1 });
    g.world.addBox({ x: -5, y: 0, z: -5 }, { x: 5, y: 3, z: 5 });
    const pts = findSpawnPoints(g, 12, { rng: createRng(2), bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, minDistance: 6 });
    assert.equal(pts.length, 12);
    for (const p of pts) assert.ok(!(Math.abs(p.x) < 5.5 && Math.abs(p.z) < 5.5), 'nicht in der Kiste');
    g.dispose();
  });

  it('Sammel-Objekte: Leben, zerstört = Kollision weg', () => {
    const g = new Game({ headless: true, seed: 1 });
    const map = createArenaMap(g, { props: true });
    const tree = map.props.trees[0];
    const collider = tree.colliders[0];
    let destroyed = 0;
    g.events.on('propDestroyed', () => destroyed++);
    const r = tree.applyDamage(CONFIG.maps.props.tree.health - 1, {});
    assert.equal(r.destroyed, false);
    assert.ok(g.world.colliders.includes(collider));
    tree.applyDamage(50, {});
    assert.ok(tree.destroyed && destroyed === 1);
    assert.ok(!g.world.colliders.includes(collider), 'Kollision entfernt');
    map.dispose();
    g.dispose();
  });
});
