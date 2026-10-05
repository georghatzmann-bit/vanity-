// Tests: Waffen-System – Feuer-Tempo, Magazin, Nachladen, Wechseln, Zielen
// (ein Spiel ohne Bildschirm, ein Schütze schießt in die Luft bzw. auf eine Wand)
import { describe, it, assert } from './runner.js';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { createTestGame, addShooter, simulateUntil } from './scenario/weaponHelpers.js';
import { collect } from './scenario/helpers.js';

const W = CONFIG.weapons;
const SKY = new THREE.Vector3(0, 50, -100); // schräg in den Himmel (trifft nichts)

function setup(loadout, options = {}) {
  const game = createTestGame();
  const { c, ctl } = addShooter(game);
  game.weapons.giveLoadout(c, loadout, options);
  ctl.aimAt = SKY;
  game.simulate(0.3); // Waffe in die Hand nehmen (Wechsel-Zeit)
  const shots = collect(game, 'shot');
  return { game, c, ctl, shots };
}

// Zeitpunkte der Schüsse
function shotTimes(game, shots) {
  const times = [];
  game.events.on('shot', () => times.push(game.time));
  return times;
}

describe('Waffen: Feuer-Tempo', () => {
  it('Sturmgewehr gedrückt halten: ≈ 5,5 Schuss pro Sekunde (über 2 s)', () => {
    const { game, ctl, shots } = setup(['ar'], { infiniteReserve: true });
    const times = shotTimes(game, shots);
    ctl.primary = true;
    game.simulate(2);
    ctl.primary = false;
    assert.ok(shots.length === 11 || shots.length === 12, `${shots.length} Schüsse in 2 s`);
    const rate = (times.length - 1) / (times[times.length - 1] - times[0]);
    assert.close(rate, 5.5, 0.05, 'Schuss pro Sekunde');
  });

  it('Maschinenpistole: 12 Schuss pro Sekunde', () => {
    const { game, ctl, shots } = setup(['smg'], { infiniteReserve: true });
    const times = shotTimes(game, shots);
    ctl.primary = true;
    game.simulate(1);
    ctl.primary = false;
    const rate = (times.length - 1) / (times[times.length - 1] - times[0]);
    assert.close(rate, 12, 0.1, 'Schuss pro Sekunde');
    assert.ok(shots.length === 12 || shots.length === 13, `${shots.length} Schüsse in 1 s`);
  });

  it('Schrotflinte: höchstens 1 Schuss alle 0,8 s, auch beim schnellen Klicken', () => {
    const { game, ctl, shots } = setup(['shotgun'], { infiniteReserve: true });
    const times = shotTimes(game, shots);
    for (let i = 0; i < 120; i++) { // 2 s lang jeden Tick klicken
      ctl.click();
      game.fixedUpdate(1 / 60);
    }
    assert.equal(shots.length, 3, 'Schüsse bei 0 s, 0,8 s, 1,6 s');
    assert.close(times[1] - times[0], 0.8, 1e-6);
    assert.close(times[2] - times[1], 0.8, 1e-6);
  });

  it('Schrotflinte halb-automatisch: gedrückt halten schießt nur einmal; zu früher Klick wird gemerkt', () => {
    const { game, ctl, shots } = setup(['shotgun'], { infiniteReserve: true });
    const times = shotTimes(game, shots);
    ctl.click();
    ctl.primary = true;
    game.simulate(2);
    ctl.primary = false;
    assert.equal(shots.length, 1, 'gedrückt halten');
    ctl.click();
    game.fixedUpdate(1 / 60);
    const t = times[times.length - 1];
    game.simulate(0.7);
    ctl.click(); // 0,1 s zu früh
    game.simulate(0.3);
    assert.equal(shots.length, 3);
    assert.close(times[2] - t, 0.8, 1e-6, 'zählt genau nach 0,8 s');
  });

  it('Pistole automatisch 6/s, Sniper 1 Schuss / 1,6 s (Magazin 1 → Nachladen 2,5 s)', () => {
    const p = setup(['pistol'], { infiniteReserve: true });
    const pt = shotTimes(p.game, p.shots);
    p.ctl.primary = true;
    p.game.simulate(1);
    assert.close((pt.length - 1) / (pt[pt.length - 1] - pt[0]), 6, 0.1, 'Pistole');
    const s = setup(['sniper'], { infiniteReserve: true });
    const st = shotTimes(s.game, s.shots);
    for (let i = 0; i < 360; i++) {
      s.ctl.click();
      s.game.fixedUpdate(1 / 60);
    }
    assert.equal(s.shots.length, 3, 'Sniper in 6 s');
    assert.close(st[1] - st[0], W.sniper.reloadTime, 1 / 60 + 1e-6, 'nach jedem Schuss wird nachgeladen');
  });
});

describe('Waffen: Magazin und Nachladen', () => {
  it('Magazin-Größen wie in config.js', () => {
    const game = createTestGame();
    const { c } = addShooter(game);
    game.weapons.giveLoadout(c, ['shotgun', 'ar', 'sniper', ['smg', 'pistol', 'grenadeLauncher']]);
    assert.deepEqual(c.slots.slice(0, 4).map((s) => s.ammo), [5, 30, 1, 30]);
    assert.deepEqual(c.weaponState.variants[3].map((s) => s.ammo), [30, 16, 6]);
  });

  it('Sturmgewehr: 30 Schuss, dann lädt es von selbst 2,2 s nach (Reserve wird weniger)', () => {
    const { game, c, ctl, shots } = setup(['ar']);
    const item = c.slots[1];
    const starts = collect(game, 'reloadStart');
    const ends = collect(game, 'reloadEnd');
    ctl.primary = true;
    const t = simulateUntil(game, () => item.ammo === 0, 10);
    ctl.primary = false;
    assert.ok(t > 0, 'Magazin leer');
    assert.equal(shots.length, 30);
    assert.equal(starts.length, 1, 'Nachladen beginnt von selbst');
    const reload = simulateUntil(game, () => item.ammo === 30, 5);
    assert.close(reload, W.ar.reloadTime, 1 / 60 + 1e-6, 'Nachlade-Zeit');
    assert.equal(ends.length, 1);
    assert.equal(item.reserve, W.defaultReserveAmmo.ar - 30);
  });

  it('R lädt nach (Zeiten: MP 2,0 s, Pistole 1,5 s, Granatwerfer 3,0 s)', () => {
    for (const id of ['smg', 'pistol', 'grenadeLauncher']) {
      const { game, c, ctl } = setup([id], { infiniteReserve: true });
      const item = c.slots[3];
      item.ammo = 1;
      ctl.reload();
      const t = simulateUntil(game, () => item.ammo === W[id].magazine, 5);
      assert.close(t, W[id].reloadTime, 1 / 60 + 1e-6, id);
    }
  });

  it('ohne Reserve kein Nachladen; volles Magazin lädt nicht', () => {
    const { game, c, ctl } = setup(['ar']);
    const item = c.slots[1];
    const starts = collect(game, 'reloadStart');
    ctl.reload();
    game.simulate(0.1);
    assert.equal(starts.length, 0, 'Magazin war voll');
    item.ammo = 3;
    item.reserve = 0;
    ctl.reload();
    game.simulate(3);
    assert.equal(item.ammo, 3);
    assert.equal(starts.length, 0);
  });

  it('Schrotflinte lädt Schuss für Schuss (0,9 s je Patrone, 4,5 s für 5)', () => {
    const { game, c, ctl } = setup(['shotgun'], { infiniteReserve: true });
    const item = c.slots[0];
    item.ammo = 0;
    ctl.reload();
    game.fixedUpdate(1 / 60);
    const counts = [];
    for (let i = 1; i <= 5; i++) {
      simulateUntil(game, () => item.ammo >= i, 2);
      counts.push(game.time);
    }
    const start = counts[0] - W.shotgun.reloadTimePerShell;
    assert.close(counts[4] - start, W.shotgun.reloadTime, 2 / 60, 'alle 5 Patronen');
    assert.close(counts[1] - counts[0], W.shotgun.reloadTimePerShell, 1 / 60 + 1e-6, 'je Patrone');
  });

  it('Schrotflinte: Schießen unterbricht das Nachladen', () => {
    const { game, c, ctl, shots } = setup(['shotgun'], { infiniteReserve: true });
    const item = c.slots[0];
    const ends = collect(game, 'reloadEnd');
    item.ammo = 0;
    ctl.reload();
    simulateUntil(game, () => item.ammo === 2, 3);
    ctl.click();
    game.fixedUpdate(1 / 60);
    assert.equal(shots.length, 1, 'geschossen');
    assert.equal(item.ammo, 1);
    assert.equal(ends.length, 1);
    assert.equal(game.weapons.isReloading(c), false, 'Nachladen beendet');
    game.simulate(2);
    assert.equal(item.ammo, 1, 'lädt danach nicht von selbst weiter (Magazin nicht leer)');
  });

  it('Leeres Magazin + Abzug lädt nach (ohne Auto-Nachladen)', () => {
    const { game, c, ctl } = setup(['ar']);
    const item = c.slots[1];
    item.ammo = 0;
    const starts = collect(game, 'reloadStart');
    ctl.click();
    game.fixedUpdate(1 / 60);
    assert.equal(starts.length, 1);
  });
});

describe('Waffen: Wechseln und Zielen', () => {
  it('Wechsel-Zeit 0,25 s; jede Waffe hat ihre eigene Wartezeit (Schrotflinte → sofort AR)', () => {
    const { game, ctl } = setup(['shotgun', 'ar'], { infiniteReserve: true });
    const times = [];
    const ids = [];
    game.events.on('shot', (e) => {
      times.push(game.time);
      ids.push(e.weaponId);
    });
    ctl.click();
    game.fixedUpdate(1 / 60);
    const t0 = game.time;
    ctl.select(2);
    ctl.primary = true;
    game.simulate(0.5);
    ctl.primary = false;
    assert.equal(ids[0], 'shotgun');
    assert.equal(ids[1], 'ar');
    assert.close(times[1] - t0, W.switchTime, 1 / 60 + 1e-6, 'AR schießt nach 0,25 s');
    assert.ok(times[1] - times[0] < W.shotgun.fireInterval, 'schneller als der nächste Schrot-Schuss');
  });

  it('Wechsel bricht das Nachladen ab', () => {
    const { game, c, ctl } = setup(['shotgun', 'ar'], { infiniteReserve: true });
    const ar = c.slots[1];
    ctl.select(2);
    game.simulate(0.3);
    ar.ammo = 0;
    ctl.reload();
    game.simulate(1);
    ctl.select(1);
    game.simulate(3);
    assert.equal(ar.ammo, 0, 'AR hat nicht im Rucksack weitergeladen');
    assert.equal(game.weapons.isReloading(c), false);
  });

  it('gleiche Taste nochmal: Platz 4 wechselt MP → Pistole → Granatwerfer → MP', () => {
    const { game, c, ctl } = setup([['smg', 'pistol', 'grenadeLauncher']], { infiniteReserve: true });
    const seen = [c.slots[3].id];
    for (let i = 0; i < 3; i++) {
      ctl.select(4);
      game.simulate(0.05);
      seen.push(c.slots[3].id);
    }
    assert.deepEqual(seen, ['smg', 'pistol', 'grenadeLauncher', 'smg']);
  });

  it('Zielen nur mit Waffe; Sniper setzt das Zielfernrohr-Sichtfeld', () => {
    const { game, c, ctl } = setup(['ar', 'sniper', 'bandage']);
    ctl.secondary = true;
    game.simulate(0.1);
    assert.ok(c.aiming && c.scopeFov === null, 'AR: zielen ohne Zielfernrohr');
    ctl.select(3);
    game.simulate(0.4);
    assert.equal(c.scopeFov, CONFIG.camera.sniperFov, 'Sniper: Zielfernrohr');
    ctl.select(5);
    game.simulate(0.1);
    assert.ok(!c.aiming && c.scopeFov === null, 'Heil-Item: kein Zielen');
    ctl.secondary = false;
  });

  it('Fadenkreuz und Munition für das HUD', () => {
    const { game, c, ctl } = setup(['shotgun', 'ar'], { infiniteReserve: true });
    assert.equal(game.weapons.getCrosshair(c).type, 'circle');
    ctl.select(2);
    game.simulate(0.3);
    const cross = game.weapons.getCrosshair(c);
    assert.equal(cross.type, 'cross');
    assert.close(cross.spread, 0.6, 1e-9, 'stehend');
    ctl.moveZ = 1;
    game.simulate(0.3);
    assert.close(game.weapons.getCrosshair(c).spread, 1.2, 1e-9, 'laufend');
    ctl.moveZ = 0;
    const ammo = game.weapons.getAmmo(c);
    assert.deepEqual([ammo.mag, ammo.infinite, ammo.reloading], [30, true, false]);
    ctl.pickaxe();
    game.simulate(0.05);
    assert.equal(game.weapons.getAmmo(c), null, 'Spitzhacke hat keine Munition');
    assert.equal(game.weapons.getCrosshair(c).type, 'dot');
  });

  it('Spitzhacke: ein Schlag alle 0,5 s (gedrückt halten)', () => {
    const { game, ctl } = setup(['ar']);
    const swings = collect(game, 'swing');
    ctl.pickaxe();
    game.simulate(0.3);
    ctl.primary = true;
    game.simulate(2);
    ctl.primary = false;
    assert.ok(swings.length === 4 || swings.length === 5, `${swings.length} Schläge in 2 s`);
  });
});
