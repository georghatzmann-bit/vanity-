// Szenario-Tests: Waffen im Spiel (ohne Bildschirm) – Treffer, Kopfschuss, Schild,
// Mündungs-Prüfung, Wände, Granaten, Spitzhacke, Heilen, Zähler
import { describe, it, assert } from '../runner.js';
import * as THREE from 'three';
import { CONFIG } from '../../src/config.js';
import { collect } from './helpers.js';
import {
  createTestGame, addShooter, addTarget, bodyPoint, headPoint, addFakePiece, simulateUntil,
} from './weaponHelpers.js';

const W = CONFIG.weapons;
const H = CONFIG.healing;

// Schütze bei (0,0,0) mit Ausrüstung, Waffe schon in der Hand
function arena(loadout, options = {}) {
  const game = createTestGame();
  const { c, ctl } = addShooter(game, options.shooter);
  game.weapons.giveLoadout(c, loadout, { infiniteReserve: true, ...options.loadout });
  game.simulate(0.3);
  return { game, c, ctl };
}

// ein Schuss (Klick) und kurz warten
function shootOnce(game, ctl, wait = 0.05) {
  ctl.click();
  game.simulate(wait);
}

describe('Szenario: Treffer mit Strahl-Waffen', () => {
  it('Sturmgewehr: Körper 30, Kopf 45', () => {
    const { game, c, ctl } = arena(['ar']);
    const a = addTarget(game, { x: 0, y: 0, z: -10 }, { health: 100 });
    const hits = [];
    game.events.on('hit', (e) => hits.push({ amount: e.amount, head: e.head, kind: e.kind, target: e.target }));
    ctl.aimAt = bodyPoint(a);
    shootOnce(game, ctl, 0.3);
    assert.equal(a.health, 70, 'Körper');
    assert.deepEqual([hits.length, hits[0].amount, hits[0].head, hits[0].kind], [1, 30, false, 'character']);
    const b = addTarget(game, { x: 3, y: 0, z: -10 }, { health: 100 });
    ctl.aimAt = headPoint(b);
    shootOnce(game, ctl, 0.3);
    assert.equal(b.health, 55, 'Kopf');
    assert.ok(hits[1].head && hits[1].amount === 45);
    assert.equal(c.stats.headshots, 1);
  });

  it('Schrotflinte: aus 3 m bis zu 90 am Körper, aus 25 m viel weniger', () => {
    const near = arena(['shotgun']);
    const t1 = addTarget(near.game, { x: 0, y: 0, z: -3 }, { health: 100, shield: 100 });
    near.ctl.aimAt = bodyPoint(t1);
    shootOnce(near.game, near.ctl);
    const dealt = 200 - t1.health - t1.shield;
    assert.close(dealt, 90, 1e-9, 'alle 10 Kugeln treffen aus 3 m');
    const far = arena(['shotgun']);
    const t2 = addTarget(far.game, { x: 0, y: 0, z: -25 }, { health: 100, shield: 100 });
    far.ctl.aimAt = bodyPoint(t2);
    shootOnce(far.game, far.ctl);
    const farDealt = 200 - t2.health - t2.shield;
    assert.ok(farDealt < 20, `aus 25 m: ${farDealt.toFixed(1)}`);
  });

  it('Schild nimmt den Schaden zuerst (blaue Zahl)', () => {
    const { game, ctl } = arena(['ar']);
    const t = addTarget(game, { x: 0, y: 0, z: -8 }, { health: 100, shield: 100 });
    let shieldHit = null;
    game.events.on('hit', (e) => { shieldHit = e.shield; });
    ctl.aimAt = bodyPoint(t);
    shootOnce(game, ctl);
    assert.deepEqual([t.shield, t.health, shieldHit], [70, 100, true]);
    // Schild fast leer: Rest aufs Leben
    t.shield = 10;
    shootOnce(game, ctl, 0.3);
    assert.deepEqual([t.shield, t.health], [0, 80]);
  });

  it('Pistole und MP: Schaden laut config.js, mit Abfall', () => {
    const { game, ctl } = arena([['smg', 'pistol']]);
    const t = addTarget(game, { x: 0, y: 0, z: -10 }, { health: 1000 });
    ctl.secondary = true; // zielen = genauer
    ctl.aimAt = bodyPoint(t);
    shootOnce(game, ctl, 0.2);
    assert.equal(1000 - t.health, W.smg.damage, 'MP auf 10 m: voll');
    t.spawnAt({ x: 0, y: 0, z: -36 }, 0);
    ctl.aimAt = bodyPoint(t);
    const a = t.health;
    shootOnce(game, ctl, 0.2);
    assert.close(a - t.health, W.smg.damage * W.smg.falloff.minFactor, 1e-6, 'MP ab 30 m: 50 %');
    ctl.select(4);
    game.simulate(0.3);
    t.spawnAt({ x: 0, y: 0, z: -48 }, 0);
    ctl.aimAt = bodyPoint(t);
    const b = t.health;
    shootOnce(game, ctl, 0.2);
    assert.close(b - t.health, W.pistol.damage * W.pistol.falloff.minFactor, 1e-6, 'Pistole ab 45 m: 60 %');
  });

  it('nie den Schützen selbst treffen; Team-Kollegen werden durchschossen', () => {
    const { game, c, ctl } = arena(['ar']);
    const mate = addTarget(game, { x: 0, y: 0, z: -5 }, { team: 1, health: 100 });
    const enemy = addTarget(game, { x: 0, y: 0, z: -12 }, { team: 2, health: 100 });
    ctl.aimAt = bodyPoint(enemy);
    shootOnce(game, ctl);
    assert.equal(mate.health, 100, 'Team-Kollege');
    assert.equal(enemy.health, 70, 'Gegner dahinter');
    assert.equal(c.health, 100, 'Schütze');
  });

  it('unverwundbare Figuren nehmen keinen Schaden', () => {
    const { game, c, ctl } = arena(['ar']);
    const t = addTarget(game, { x: 0, y: 0, z: -8 }, { health: 100, shield: 50 });
    t.invulnerableUntil = game.time + 5;
    const hits = collect(game, 'hit');
    ctl.aimAt = bodyPoint(t);
    shootOnce(game, ctl);
    assert.deepEqual([t.health, t.shield, hits.length, c.stats.damageDealt, c.stats.shotsHit], [100, 50, 0, 0, 0]);
    assert.equal(c.stats.shotsFired, 1);
  });

  it('Zähler: Schüsse, Treffer, Kopfschüsse, Schaden (auch beim Ziel)', () => {
    const { game, c, ctl } = arena(['ar']);
    const t = addTarget(game, { x: 0, y: 0, z: -10 }, { health: 100, shield: 100 });
    ctl.aimAt = bodyPoint(t);
    shootOnce(game, ctl, 0.3);
    ctl.aimAt = headPoint(t);
    shootOnce(game, ctl, 0.3);
    ctl.aimAt = new THREE.Vector3(0, 30, -10); // daneben
    shootOnce(game, ctl, 0.3);
    assert.deepEqual([c.stats.shotsFired, c.stats.shotsHit, c.stats.headshots], [3, 2, 1]);
    assert.equal(c.stats.damageDealt, 75);
    assert.equal(t.stats.damageTaken, 75);
  });
});

describe('Szenario: Sniper (Geschoss mit Flugzeit)', () => {
  it('Kopfschuss 262,5 besiegt ein Ziel mit 100 Leben + 100 Schild', () => {
    const { game, c, ctl } = arena(['sniper']);
    const t = addTarget(game, { x: 0, y: 0, z: -40 }, { health: 100, shield: 100 });
    const killed = collect(game, 'characterKilled');
    ctl.secondary = true; // Zielfernrohr: keine Streuung
    game.simulate(0.1);
    ctl.aimAt = headPoint(t);
    shootOnce(game, ctl, 0.5);
    assert.ok(!t.alive, 'besiegt');
    assert.equal(killed.length, 1);
    assert.equal(killed[0].killer, c);
    // genauer Wert an einem Ziel mit viel Leben
    const big = addTarget(game, { x: 4, y: 0, z: -40 }, { health: 1000 });
    big.health = 1000;
    game.simulate(3); // nachladen
    ctl.aimAt = headPoint(big);
    shootOnce(game, ctl, 0.5);
    assert.close(1000 - big.health, 262.5, 1e-9, 'Kopfschuss-Schaden');
  });

  it('fliegt 300 m/s: auf 90 m trifft es erst nach ≈ 0,3 s', () => {
    const { game, ctl } = arena(['sniper']);
    const t = addTarget(game, { x: 0, y: 0, z: -90 }, { health: 1000 });
    ctl.secondary = true;
    game.simulate(0.1);
    ctl.aimAt = bodyPoint(t);
    ctl.click();
    game.fixedUpdate(1 / 60);
    assert.equal(t.health, 1000, 'nicht sofort');
    const time = simulateUntil(game, () => t.health < 1000, 1);
    assert.ok(time > 0.25 && time < 0.36, `Flugzeit ${time.toFixed(3)} s`);
    assert.equal(1000 - t.health, 105);
  });

  it('kein "Durchtunneln": dünne Wand hält das schnelle Geschoss auf', () => {
    const { game, ctl } = arena(['sniper']);
    const wall = addFakePiece(game, { x: -3, y: 0, z: -20.1 }, { x: 3, y: 4, z: -20 }, 150);
    const t = addTarget(game, { x: 0, y: 0, z: -40 }, { health: 100 });
    ctl.aimAt = bodyPoint(t);
    shootOnce(game, ctl, 0.5);
    assert.equal(t.health, 100, 'Ziel hinter der Wand');
    assert.equal(wall.taken, W.sniper.structureDamage);
  });
});

describe('Szenario: Wände und Mündungs-Prüfung', () => {
  it('Wand (Bauteil) hält Schüsse auf und nimmt den Bauteil-Schaden', () => {
    const { game, ctl } = arena(['shotgun', 'ar']);
    const wall = addFakePiece(game, { x: -2, y: 0, z: -5.1 }, { x: 2, y: 4, z: -4.9 }, 150);
    const t = addTarget(game, { x: 0, y: 0, z: -10 }, { health: 100 });
    const hits = collect(game, 'hit');
    ctl.select(2);
    game.simulate(0.3);
    ctl.aimAt = bodyPoint(t);
    shootOnce(game, ctl, 0.3);
    assert.equal(t.health, 100);
    assert.equal(wall.taken, W.ar.structureDamage, 'AR an Bauteilen');
    assert.equal(hits[0].kind, 'piece');
    ctl.select(1);
    game.simulate(0.3);
    shootOnce(game, ctl);
    assert.close(wall.taken - W.ar.structureDamage, W.shotgun.structureDamage, 1e-9, 'Schrotflinte: 60 gesamt');
    assert.equal(wall.hits, 2, 'eine Meldung pro Schuss (nicht pro Kugel)');
  });

  it('normale Kiste blockiert; durchlässige (blocksBullets: false) nicht', () => {
    const { game, ctl } = arena(['ar']);
    const box = game.world.addBox({ x: -1, y: 0, z: -5 }, { x: 1, y: 3, z: -4 });
    const t = addTarget(game, { x: 0, y: 0, z: -10 }, { health: 100 });
    ctl.aimAt = bodyPoint(t);
    shootOnce(game, ctl, 0.3);
    assert.equal(t.health, 100, 'Kiste blockiert');
    game.world.remove(box);
    game.world.addBox({ x: -1, y: 0, z: -5 }, { x: 1, y: 3, z: -4 }, { kind: 'static', blocksBullets: false });
    shootOnce(game, ctl, 0.3);
    assert.equal(t.health, 70, 'Busch lässt durch');
  });

  it('kein Schießen um Ecken: Kamera sieht am Eck vorbei, die Waffe trifft die Wand', () => {
    const { game, ctl } = arena(['ar']);
    // Wand links vor dem Schützen; ihre Ecke endet bei x = 0,45
    const wall = addFakePiece(game, { x: -2, y: 0, z: -2.2 }, { x: 0.45, y: 4, z: -2.0 }, 150);
    const t = addTarget(game, { x: 0.6, y: 0, z: -10 }, { health: 100 });
    // Ziel-Strahl wie die Schulter-Kamera: 0,6 m rechts der Augen
    ctl.aimOriginOffset = new THREE.Vector3(0.6, 0, 0);
    ctl.aimAt = bodyPoint(t);
    // Probe: Der Kamera-Strahl allein ist frei
    const origin = new THREE.Vector3(0.6, 1.6, 0);
    const dir = bodyPoint(t).sub(origin).normalize();
    assert.equal(game.world.raycast(origin, dir, 20, {}), null, 'Kamera sieht das Ziel');
    shootOnce(game, ctl, 0.3);
    assert.equal(t.health, 100, 'Ziel nicht getroffen');
    assert.equal(wall.taken, W.ar.structureDamage, 'die Wand bekommt den Treffer');
    // Ohne Wand trifft derselbe Schuss
    game.world.remove(wall.collider);
    shootOnce(game, ctl, 0.3);
    assert.equal(t.health, 70);
  });

  it('Wand direkt vor dem Gesicht: Schuss geht nicht hindurch', () => {
    const { game, ctl } = arena(['ar']);
    const wall = addFakePiece(game, { x: -2, y: 0, z: -0.6 }, { x: 2, y: 4, z: -0.45 }, 150);
    const t = addTarget(game, { x: 0, y: 0, z: -8 }, { health: 100 });
    ctl.aimOriginOffset = new THREE.Vector3(0.6, 0, -0.3); // Kamera-Strahl startet schon fast an der Wand
    ctl.aimAt = bodyPoint(t);
    shootOnce(game, ctl, 0.3);
    assert.equal(t.health, 100);
    assert.equal(wall.taken, W.ar.structureDamage);
  });
});

describe('Szenario: Granatwerfer', () => {
  it('Explosion trifft eine Figur hinter einer Wand; Bauteile im Radius nehmen 150', () => {
    const { game, c, ctl } = arena(['grenadeLauncher'], { loadout: { infiniteReserve: true } });
    const wall = addFakePiece(game, { x: -2, y: 0, z: -8.1 }, { x: 2, y: 4, z: -7.9 }, 300);
    const t = addTarget(game, { x: 0, y: 0, z: -9.5 }, { health: 100 });
    const explosions = collect(game, 'explosion');
    ctl.aimAt = new THREE.Vector3(0, 1.4, -8);
    shootOnce(game, ctl, 1.0);
    assert.equal(explosions.length, 1, 'explodiert an der Wand');
    assert.ok(t.health < 100, `Ziel hinter der Wand: Leben ${t.health.toFixed(1)}`);
    assert.equal(wall.taken, W.grenadeLauncher.structureDamage);
    assert.equal(c.health, 100, 'eigene Granate verletzt nicht');
  });

  it('fliegt im Bogen und explodiert spätestens nach der Zünd-Zeit', () => {
    const { game, ctl } = arena(['grenadeLauncher']);
    const explosions = [];
    game.events.on('explosion', (e) => explosions.push({ y: e.position.y, t: game.time }));
    ctl.aimAt = new THREE.Vector3(0, 40, -30); // steil nach oben
    const start = game.time;
    shootOnce(game, ctl, 0.02);
    const p = game.projectiles.active[0];
    assert.ok(p && p.type === 'grenade', 'Granate fliegt');
    game.simulate(W.grenadeLauncher.fuseTime + 0.2);
    assert.equal(explosions.length, 1);
    assert.ok(explosions[0].t - start <= W.grenadeLauncher.fuseTime + 0.05, 'Zünd-Zeit');
    assert.equal(game.projectiles.active.length, 0);
  });

  it('Explosion: Mitte voll, am Rand weniger, außerhalb nichts', () => {
    const { game, c } = arena(['grenadeLauncher']);
    const near = addTarget(game, { x: 0, y: 0, z: -12 }, { health: 1000 });
    const edge = addTarget(game, { x: 3.8, y: 0, z: -12 }, { health: 1000, team: 3 }); // Kapsel-Rand (x = 3,4) 3 m entfernt
    const out = addTarget(game, { x: 5, y: 0, z: -12 }, { health: 1000, team: 4 });
    // Granate ohne Tempo genau an der Figur → explodiert im nächsten Schritt (Zünd-Zeit 0)
    game.projectiles.spawn({ type: 'grenade', owner: c, weaponId: 'grenadeLauncher', position: new THREE.Vector3(0.4, 1.0, -12),
      velocity: new THREE.Vector3(), gravity: 0, lifetime: 0 });
    game.fixedUpdate(1 / 60);
    const g = W.grenadeLauncher;
    assert.close(1000 - near.health, g.explosionDamage, 1e-6, 'Volltreffer');
    const expectedEdge = g.explosionDamage * (1 + (g.edgeDamageFactor - 1) * (3 / g.explosionRadius));
    assert.close(1000 - edge.health, expectedEdge, 1e-6, '3 m vom Mittelpunkt');
    assert.equal(out.health, 1000, 'außerhalb von 4 m');
  });
});

describe('Szenario: Spitzhacke', () => {
  it('sammelt 5–10 Holz am Baum, Stein am Fels', () => {
    const { game, c, ctl } = arena(['ar']);
    c.materials = { wood: 0, stone: 0, metal: 0 };
    game.world.addBox({ x: -0.4, y: 0, z: -1.9 }, { x: 0.4, y: 5, z: -1.1 }, { kind: 'tree', harvest: 'wood' });
    const events = collect(game, 'harvest');
    ctl.pickaxe();
    game.simulate(0.3);
    ctl.aimAt = new THREE.Vector3(0, 1.3, -1.5);
    ctl.click();
    game.simulate(0.1);
    assert.equal(events.length, 1);
    assert.ok(c.materials.wood >= 5 && c.materials.wood <= 10, `Holz: ${c.materials.wood}`);
    assert.equal(c.materials.stone, 0);
    // 10 Schläge: jeder 5–10, Summe passt
    ctl.primary = true;
    game.simulate(5);
    ctl.primary = false;
    assert.ok(c.materials.wood >= 5 * 11 && c.materials.wood <= 10 * 11, `nach 11 Schlägen: ${c.materials.wood}`);
  });

  it('nicht über das Maximum (999)', () => {
    const { game, c, ctl } = arena([]);
    c.materials = { wood: 0, stone: 995, metal: 0 };
    game.world.addBox({ x: -1, y: 0, z: -2.2 }, { x: 1, y: 1.5, z: -1.2 }, { kind: 'rock', harvest: 'stone' });
    ctl.pickaxe();
    game.simulate(0.3);
    ctl.aimAt = new THREE.Vector3(0, 1.0, -1.5);
    ctl.click();
    game.simulate(0.1);
    assert.equal(c.materials.stone, CONFIG.materials.maxPerType);
  });

  it('50 Schaden an Bauteilen, 20 an Figuren, Reichweite 2 m', () => {
    const { game, ctl } = arena([]);
    const piece = addFakePiece(game, { x: -1, y: 0, z: -1.6 }, { x: 1, y: 4, z: -1.4 }, 150);
    ctl.pickaxe();
    game.simulate(0.3);
    ctl.aimAt = new THREE.Vector3(0, 1.3, -1.5);
    ctl.click();
    game.simulate(0.1);
    assert.equal(piece.taken, W.pickaxe.structureDamage);
    game.world.remove(piece.collider);
    const t = addTarget(game, { x: 0, y: 0, z: -1.3 }, { health: 100 });
    ctl.aimAt = bodyPoint(t);
    game.simulate(0.5);
    ctl.click();
    game.simulate(0.1);
    assert.equal(t.health, 100 - W.pickaxe.playerDamage);
    // zu weit weg
    const far = addTarget(game, { x: 3, y: 0, z: -3.5 }, { health: 100 });
    ctl.aimAt = bodyPoint(far);
    game.simulate(0.5);
    ctl.click();
    game.simulate(0.1);
    assert.equal(far.health, 100, 'außer Reichweite');
  });
});

describe('Szenario: Heil-Items (Platz 5)', () => {
  it('Verband: +15 pro Benutzung, gedrückt halten heilt weiter, stoppt bei 75', () => {
    const { game, c, ctl } = arena(['bandage'], { loadout: { healCount: 5 } });
    c.health = 50;
    const heals = collect(game, 'heal');
    ctl.primary = true;
    game.simulate(H.bandage.useTime + 0.1);
    assert.equal(c.health, 65, 'nach 3 s');
    game.simulate(H.bandage.useTime * 2);
    ctl.primary = false;
    assert.equal(c.health, 75, 'höchstens 75');
    assert.equal(heals.length, 2);
    assert.equal(c.slots[4].count, 3, 'zwei Verbände verbraucht');
    assert.equal(c.healing, null);
  });

  it('beim Benutzen langsamer; Waffenwechsel bricht ab (kein Heilen)', () => {
    const { game, c, ctl } = arena(['ar', 'medkit']);
    c.health = 30;
    const cancels = collect(game, 'healCancel');
    ctl.select(5);
    game.simulate(0.3);
    ctl.click();
    game.simulate(1);
    assert.ok(c.healing && c.healing.itemId === 'medkit', 'heilt gerade');
    assert.equal(c.speedFactor, H.moveSpeedFactor, 'langsamer laufen');
    ctl.select(2);
    game.simulate(H.medkit.useTime);
    assert.equal(c.health, 30, 'abgebrochen');
    assert.equal(c.speedFactor, 1, 'wieder normal schnell');
    assert.equal(cancels.length, 1);
    assert.equal(c.slots[4].count, H.medkit.stack, 'nichts verbraucht');
  });

  it('Medikit: Leben auf 100 (8 s)', () => {
    const { game, c, ctl } = arena(['medkit']);
    c.health = 20;
    ctl.click();
    const t = simulateUntil(game, () => c.health === 100, 10);
    assert.close(t, H.medkit.useTime, 1 / 60 + 1e-6);
  });

  it('Schildtränke: klein +25 bis höchstens 50, groß +50 bis 100', () => {
    const small = arena(['smallShield']);
    small.c.shield = 40;
    small.ctl.click();
    small.game.simulate(H.smallShield.useTime + 0.1);
    assert.equal(small.c.shield, 50, 'klein: nicht über 50');
    small.ctl.click();
    small.game.simulate(H.smallShield.useTime + 0.1);
    assert.equal(small.c.shield, 50, 'bei 50 geht der kleine nicht mehr');
    assert.equal(small.c.slots[4].count, H.smallShield.stack - 1);
    const big = arena(['bigShield']);
    big.c.shield = 80;
    big.ctl.click();
    big.game.simulate(H.bigShield.useTime + 0.1);
    assert.equal(big.c.shield, 100);
  });

  it('letztes Heil-Item verbraucht → Platz leer, zurück zur Waffe', () => {
    const { game, c, ctl } = arena(['ar', 'bandage'], { loadout: { healCount: 1 } });
    c.health = 40;
    ctl.select(5);
    game.simulate(0.3);
    ctl.click();
    game.simulate(H.bandage.useTime + 0.1);
    assert.equal(c.health, 55);
    assert.equal(c.slots[4], null);
    assert.equal(c.selectedSlot, 1, 'Sturmgewehr wieder in der Hand');
  });
});
