// Szenario-Tests: Bewegung der Figur (laufen, springen, ducken, Kollision, Fallschaden)
// Jeder Test baut ein kleines Spiel ohne Bildschirm und simuliert es.
import { describe, it, assert } from '../runner.js';
import { CONFIG } from '../../src/config.js';
import { Input } from '../../src/input.js';
import { defaultSettings } from '../../src/core/settings.js';
import { bodyFits } from '../../src/player.js';
import { createRng } from '../../src/util/random.js';
import { RADIANS_PER_COUNT_PER_PERCENT } from '../../src/playerController.js';
import { createTestGame, addDrivenCharacter, collect, maxHeightDuring } from './helpers.js';

const P = CONFIG.player;
const R = P.hitbox.radius;
const box = (game, x0, y0, z0, x1, y1, z1) => game.world.addBox({ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 });

describe('Szenario: Laufen und Springen', () => {
  it('1 Sekunde laufen ≈ 6 m', () => {
    const game = createTestGame();
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    game.simulate(1);
    const d = -c.position.z;
    assert.ok(d > 5.4 && d <= 6.05, `gelaufen: ${d.toFixed(2)} m`);
    assert.close(c.position.x, 0, 1e-9, 'geradeaus');
    assert.equal(c.position.y, 0);
  });

  it('geduckt ≈ 3 m/s, Sprint ≈ 7,5 m/s (nur mit Sprint-Befehl), Zielen langsamer', () => {
    const speedOf = (fields, setup) => {
      const game = createTestGame();
      const c = addDrivenCharacter(game);
      Object.assign(c.brain.fields, fields);
      setup?.(c);
      game.simulate(0.5);
      const z0 = c.position.z;
      game.simulate(1);
      return z0 - c.position.z;
    };
    assert.close(speedOf({ moveZ: 1, crouch: true }), P.crouchSpeed, 0.05, 'geduckt');
    assert.close(speedOf({ moveZ: 1, sprint: true }), P.sprintSpeed, 0.05, 'sprinten');
    assert.close(speedOf({ moveZ: 1, secondary: true }), P.walkSpeed * CONFIG.weapons.aimMoveFactor, 0.05, 'zielen');
  });

  it('Sprunghöhe ≈ 1,4 m, danach wieder am Boden (Ereignisse jump + land)', () => {
    const game = createTestGame();
    const c = addDrivenCharacter(game);
    const jumps = collect(game, 'jump');
    const lands = collect(game, 'land');
    c.brain.fields.jumpPressed = true;
    const max = maxHeightDuring(game, c, 1.2);
    assert.close(max, 1.4, 0.05, 'höchster Punkt');
    assert.equal(jumps.length, 1);
    assert.equal(lands.length, 1);
    assert.close(lands[0].fallHeight, max, 1e-6);
    assert.ok(c.grounded && c.position.y === 0);
  });

  it('Schritte: beim Laufen kommen footstep-Ereignisse', () => {
    const game = createTestGame();
    const c = addDrivenCharacter(game);
    const steps = collect(game, 'footstep');
    c.brain.fields.moveZ = 1;
    game.simulate(1);
    assert.ok(steps.length >= 2, `${steps.length} Schritte`);
  });

  it('für weiche Grafik: prevPosition ist die Lage vom Anfang des Ticks', () => {
    const game = createTestGame();
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    game.simulate(0.5);
    const before = c.position.clone();
    game.fixedUpdate(1 / 60);
    assert.close(c.prevPosition.distanceTo(before), 0, 1e-12);
    assert.ok(c.position.distanceTo(before) > 0.05);
  });
});

describe('Szenario: Wände und Stufen', () => {
  it('Wand hält auf (bleibt davor stehen)', () => {
    const game = createTestGame();
    box(game, -10, 0, -3.2, 10, 4, -3);
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    game.simulate(2);
    assert.ok(c.position.z >= -3 + R - 1e-3, `z = ${c.position.z}`);
    assert.close(c.position.z, -3 + R, 0.01, 'direkt an der Wand');
    assert.close(c.velocity.z, 0, 1e-9);
  });

  it('schräg gegen die Wand: rutscht an ihr entlang', () => {
    const game = createTestGame();
    box(game, -20, 0, -3.2, 20, 4, -3);
    const c = addDrivenCharacter(game, { yaw: Math.PI / 6 }); // 30° nach links
    c.brain.fields.moveZ = 1;
    game.simulate(2);
    assert.close(c.position.z, -3 + R, 0.01);
    assert.ok(c.position.x < -4, `seitlich gerutscht: x = ${c.position.x.toFixed(2)}`);
  });

  it('0,3-m-Kiste: man steigt einfach hinauf', () => {
    const game = createTestGame();
    box(game, -2, 0, -8, 2, 0.3, -4);
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    game.simulate(1);
    assert.close(c.position.y, 0.3, 1e-9);
    assert.ok(c.position.z < -5);
  });

  it('1-m-Kiste: geht nicht ohne Springen, mit Sprung schon', () => {
    const game = createTestGame();
    box(game, -2, 0, -8, 2, 1, -4);
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    game.simulate(1.5);
    assert.equal(c.position.y, 0);
    assert.close(c.position.z, -4 + R, 0.01);
    c.brain.fields.jumpPressed = true;
    game.simulate(1);
    assert.close(c.position.y, 1, 1e-9, 'oben');
  });

  it('2-m-Kiste: auch mit Sprung zu hoch', () => {
    const game = createTestGame();
    box(game, -2, 0, -8, 2, 2, -4);
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    c.brain.fields.jump = true; // Springen gedrückt halten
    game.simulate(2);
    assert.ok(c.position.z > -4, 'kommt nicht hinauf');
  });
});

describe('Szenario: Rampen', () => {
  it('45°-Rampe auf die 4-m-Plattform hochlaufen – ohne zu springen', () => {
    const game = createTestGame();
    game.world.addSlope({ minX: -2, maxX: 2, minZ: -8, maxZ: -4, baseY: 0, rise: 4, dir: 3, thickness: 0.2 });
    box(game, -6, 0, -16, 6, 4, -8);
    const c = addDrivenCharacter(game);
    const jumps = collect(game, 'jump');
    const lands = collect(game, 'land');
    c.brain.fields.moveZ = 1;
    game.simulate(2.5);
    assert.close(c.position.y, 4, 1e-9, 'oben auf der Plattform');
    assert.ok(c.position.z < -9);
    assert.equal(jumps.length, 0, 'nicht gesprungen');
    assert.equal(lands.length, 0, 'nie in der Luft gewesen');
    // und wieder hinunter, ohne abzuheben
    c.brain.fields.yaw = Math.PI;
    game.simulate(3);
    assert.equal(c.position.y, 0);
    assert.ok(c.position.z > -4);
    assert.equal(lands.filter((l) => l.fallHeight > 0.6).length, 0, 'kein Fallen beim Hinunterlaufen');
  });

  it('oben an der Rampe auf die Plattform: klappt bei jedem Tempo und jeder Schritt-Lage', () => {
    // Die Vorderkante des Körpers erreicht die Plattform, bevor die Füße oben sind –
    // das darf nie zum Hängenbleiben führen (egal wo genau die Schritte landen).
    for (const fields of [{}, { sprint: true }, { crouch: true }, { secondary: true }]) {
      for (let k = 0; k < 10; k++) {
        const game = createTestGame();
        game.world.addSlope({ minX: -2, maxX: 2, minZ: -8, maxZ: -4, baseY: 0, rise: 4, dir: 3, thickness: 0.2 });
        box(game, -2, 0, -40, 2, 4, -8); // Plattform genau so breit wie die Rampe (und lang)
        const c = addDrivenCharacter(game, { position: { x: (k % 3) * 0.6 - 0.6, y: 0, z: -k * 0.013 } });
        Object.assign(c.brain.fields, { moveZ: 1 }, fields);
        game.simulate(4);
        assert.close(c.position.y, 4, 1e-9, `${JSON.stringify(fields)} Versatz ${k}: y = ${c.position.y.toFixed(3)}`);
        assert.ok(c.position.z < -8.5, `${JSON.stringify(fields)} Versatz ${k}: z = ${c.position.z.toFixed(2)}`);
      }
    }
  });

  it('Rampen-Kette (Rampe an Rampe, wie beim Hochbauen): ohne Springen bis oben', () => {
    // Am Übergang ist die Vorderkante der Figur schon auf der nächsten Rampe,
    // die Füße (Mitte) aber noch 0,4 m tiefer – das darf nicht blockieren.
    const ramp = (game, minX, maxX, minZ, maxZ, baseY, dir) =>
      game.world.addSlope({ minX, maxX, minZ, maxZ, baseY, rise: 4, dir, thickness: 0.2 });
    const cases = [
      { name: '+X gehen', fields: {}, yaw: -Math.PI / 2, start: { x: -4, y: 0, z: 0 },
        build: (g) => { ramp(g, -2, 2, -2, 2, 0, 0); ramp(g, 2, 6, -2, 2, 4, 0); ramp(g, 6, 10, -2, 2, 8, 0); box(g, 10, 0, -2, 70, 12, 2); } },
      { name: '+X sprinten', fields: { sprint: true }, yaw: -Math.PI / 2, start: { x: -4, y: 0, z: 0 },
        build: (g) => { ramp(g, -2, 2, -2, 2, 0, 0); ramp(g, 2, 6, -2, 2, 4, 0); ramp(g, 6, 10, -2, 2, 8, 0); box(g, 10, 0, -2, 70, 12, 2); } },
      { name: '−Z geduckt', fields: { crouch: true }, yaw: 0, time: 3.6, start: { x: 0.7, y: 0, z: 4 },
        build: (g) => { ramp(g, -2, 2, -2, 2, 0, 3); ramp(g, -2, 2, -6, -2, 4, 3); box(g, -2, 0, -60, 2, 8, -6); } },
    ];
    for (const k of cases) {
      const game = createTestGame();
      k.build(game);
      const c = addDrivenCharacter(game, { position: k.start, yaw: k.yaw });
      const jumps = collect(game, 'jump');
      Object.assign(c.brain.fields, { moveZ: 1 }, k.fields);
      const time = k.time ?? 2; // geduckt ist man halb so schnell
      game.simulate(time);
      assert.ok(c.position.y > 6, `${k.name}: nach ${time} s auf y = ${c.position.y.toFixed(2)} (hängt an der Naht?)`);
      game.simulate(4);
      const top = k.yaw === 0 ? 8 : 12;
      assert.close(c.position.y, top, 1e-9, `${k.name}: oben angekommen`);
      assert.equal(jumps.length, 0, `${k.name}: nicht gesprungen`);
    }
  });

  it('Grat (Rampe hoch, direkt Rampe runter) und Tal: ohne Springen hinüber', () => {
    for (const back of [false, true]) {
      const game = createTestGame();
      game.world.addSlope({ minX: -2, maxX: 2, minZ: -2, maxZ: 2, baseY: 0, rise: 4, dir: 0, thickness: 0.2 });
      game.world.addSlope({ minX: 2, maxX: 6, minZ: -2, maxZ: 2, baseY: 0, rise: 4, dir: 2, thickness: 0.2 });
      const c = addDrivenCharacter(game, { position: { x: back ? 8 : -4, y: 0, z: 0 }, yaw: back ? Math.PI / 2 : -Math.PI / 2 });
      const jumps = collect(game, 'jump');
      c.brain.fields.moveZ = 1;
      const max = maxHeightDuring(game, c, 3);
      assert.ok(max > 3.9, `über den Grat (${back ? 'rückwärts' : 'vorwärts'}): höchster Punkt ${max.toFixed(2)} m`);
      assert.ok(back ? c.position.x < -3 : c.position.x > 7, `auf der anderen Seite: x = ${c.position.x.toFixed(2)}`);
      assert.equal(c.position.y, 0);
      assert.equal(jumps.length, 0);
    }
    // Tal: Rampe hinunter, unten direkt wieder eine Rampe hinauf
    const game = createTestGame();
    box(game, -30, 0, -2, -2, 4, 2);
    game.world.addSlope({ minX: -2, maxX: 2, minZ: -2, maxZ: 2, baseY: 0, rise: 4, dir: 2, thickness: 0.2 });
    game.world.addSlope({ minX: 2, maxX: 6, minZ: -2, maxZ: 2, baseY: 0, rise: 4, dir: 0, thickness: 0.2 });
    box(game, 6, 0, -2, 30, 4, 2);
    const c = addDrivenCharacter(game, { position: { x: -6, y: 4, z: 0 }, yaw: -Math.PI / 2 });
    c.brain.fields.moveZ = 1;
    game.simulate(3);
    assert.close(c.position.y, 4, 1e-9, 'durch das Tal und wieder oben');
    assert.ok(c.position.x > 7);
  });

  it('unter einer hohen Rampe durchlaufen', () => {
    const game = createTestGame();
    game.world.addSlope({ minX: -2, maxX: 2, minZ: -10, maxZ: -6, baseY: 3, rise: 4, dir: 3, thickness: 0.2 });
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    game.simulate(2.5);
    assert.ok(c.position.z < -11, `durchgekommen: z = ${c.position.z.toFixed(2)}`);
    assert.equal(c.position.y, 0);
  });

  it('niedrige Rampe von der Seite: blockiert, wenn sie den Körper schneiden würde', () => {
    const game = createTestGame();
    // Rampe steigt nach +X; wir laufen (Richtung −Z) gegen ihre Seite, wo sie etwa 1 m hoch ist:
    // zu hoch zum Hinaufsteigen, zu niedrig zum Drunter-durch-Laufen
    game.world.addSlope({ minX: -3, maxX: 1, minZ: -10, maxZ: -6, baseY: 0, rise: 4, dir: 0, thickness: 0.2 });
    const c = addDrivenCharacter(game, { position: { x: -2, y: 0, z: 0 } });
    c.brain.fields.moveZ = 1;
    game.simulate(2);
    assert.ok(c.position.z > -6 + R - 0.1, `z = ${c.position.z.toFixed(2)}`);
    assert.equal(c.position.y, 0);
  });

  it('über ein Pyramiden-Dach laufen', () => {
    const game = createTestGame();
    game.world.addSlope({ minX: -2, maxX: 2, minZ: -8, maxZ: -4, baseY: 0, rise: CONFIG.building.roofHeight, dir: 'pyramid', thickness: 0.2 });
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    const max = maxHeightDuring(game, c, 2);
    assert.ok(max > CONFIG.building.roofHeight - 0.2, `über die Spitze: ${max.toFixed(2)} m`);
    assert.ok(c.position.z < -9);
    assert.equal(c.position.y, 0);
  });
});

describe('Szenario: Ducken', () => {
  it('unter der 1,5-m-Decke nur geduckt; Aufstehen geht dort nicht', () => {
    const game = createTestGame();
    box(game, -2, 1.5, -10, 2, 1.7, -4);
    const c = addDrivenCharacter(game);
    c.brain.fields.moveZ = 1;
    game.simulate(1);
    assert.close(c.position.z, -4 + R, 0.01, 'stehend: Decke hält auf');
    c.brain.fields.crouch = true;
    game.simulate(1);
    assert.ok(c.position.z < -6, 'geduckt hinein');
    c.brain.fields.moveZ = 0;
    c.brain.fields.crouch = false;
    game.simulate(0.5);
    assert.ok(c.crouching, 'bleibt geduckt unter der Decke');
    assert.equal(c.height, P.hitbox.crouchHeight);
    c.brain.fields.moveZ = 1;
    game.simulate(2.5);
    assert.ok(c.position.z < -10.5);
    assert.ok(!c.crouching, 'draußen steht sie von selbst auf');
  });

  it('Springen unter einer Decke: Kopf stößt an', () => {
    const game = createTestGame();
    box(game, -2, 2.5, -2, 2, 2.7, 2);
    const c = addDrivenCharacter(game);
    c.brain.fields.jumpPressed = true;
    const max = maxHeightDuring(game, c, 1);
    assert.close(max, 2.5 - P.hitbox.height, 1e-6);
  });

  it('Springen unter eine Rampe, die genau auf Kopfhöhe ist: Füße bleiben auf dem Boden (nicht hineingedrückt)', () => {
    // Boden-Platte (0,2 m) und darüber eine Rampe in derselben Zelle; an dieser Stelle ist
    // unter der Rampe genau 1,8 m Platz (Unterseite liegt 0,02 mm unter dem Kopf)
    const game = createTestGame();
    box(game, -4, 0, 0, 0, 0.2, 4);
    game.world.addSlope({ minX: -4, maxX: 0, minZ: 0, maxZ: 4, baseY: 0, rise: 4, dir: 0, thickness: 0.2 });
    const x = -1.3171746834687459;
    const c = addDrivenCharacter(game, { position: { x, y: 0.2, z: 2 } });
    c.brain.fields.jumpPressed = true;
    for (let i = 0; i < 30; i++) {
      game.fixedUpdate(1 / 60);
      assert.ok(c.position.y >= 0.2, `Tick ${i}: Füße bei ${c.position.y} (im Boden)`);
      assert.ok(bodyFits(game.world, c.position.x, c.position.y, c.position.z, c.radius, c.height), `Tick ${i}: steckt fest`);
    }
  });
});

describe('Szenario: Fallen', () => {
  it('Sturz aus 12 m: 50 Schaden, zuerst auf den Schild', () => {
    const game = createTestGame();
    box(game, -4, 0, -4, 4, 12, 4);
    const c = addDrivenCharacter(game, { position: { x: 0, y: 12, z: 0 }, health: 100, shield: 100 });
    const lands = collect(game, 'land');
    const damage = collect(game, 'characterDamaged');
    c.brain.fields.moveZ = 1;
    game.simulate(0.8);
    c.brain.fields.moveZ = 0;
    game.simulate(2);
    assert.equal(c.position.y, 0);
    assert.equal(lands.length, 1);
    assert.close(lands[0].fallHeight, 12, 1e-6);
    assert.equal(damage.length, 1);
    assert.close(damage[0].amount, 50, 1e-6);
    assert.equal(damage[0].kind, 'fall');
    assert.close(c.shield, 50, 1e-6, 'Schild zuerst');
    assert.equal(c.health, 100);
  });

  it('kleiner Sturz (4 m) und Sprünge machen keinen Schaden', () => {
    const game = createTestGame();
    box(game, -4, 0, -4, 4, 4, 4);
    const c = addDrivenCharacter(game, { position: { x: 0, y: 4, z: 0 }, health: 100, shield: 0 });
    c.brain.fields.moveZ = 1;
    c.brain.fields.jump = true;
    game.simulate(3);
    assert.equal(c.health, 100);
  });

  it('sehr schnelles Fallen geht nie durch einen 0,2 m dünnen Boden', () => {
    for (const speed of [80, 300, 1200, 5000]) {
      const game = createTestGame();
      box(game, -4, 49.8, -4, 4, 50, 4);
      const c = addDrivenCharacter(game, { position: { x: 0, y: 60, z: 0 } });
      c.grounded = false;
      c.moveState = 'air';
      c.velocity.y = -speed;
      game.simulate(1);
      assert.close(c.position.y, 50, 1e-9, `Tempo ${speed} m/s`);
    }
  });

  it('schnell seitlich gegen eine dünne Wand: kein Durchrutschen', () => {
    const game = createTestGame();
    box(game, -4, 0, -10.2, 4, 4, -10);
    const c = addDrivenCharacter(game);
    c.velocity.z = -400; // wie von einer Explosion weggeschleudert
    c.grounded = false;
    c.moveState = 'air';
    game.simulate(0.5);
    assert.ok(c.position.z > -10, `z = ${c.position.z.toFixed(2)}`);
  });

  it('unter die Welt gefallen (unter killPlaneY) = besiegt', () => {
    const game = createTestGame();
    game.world.setTerrain({ isFlat: true, height: -1000, heightAt: () => -1000 });
    const c = addDrivenCharacter(game, { health: 100, shield: 100 });
    const killed = collect(game, 'characterKilled');
    game.simulate(5);
    assert.ok(!c.alive);
    assert.equal(killed.length, 1);
    assert.equal(killed[0].victim, c);
    assert.ok(c.position.y < CONFIG.world.killPlaneY);
  });
});

describe('Szenario: Spieler mit echter Eingabe auf dem Übungsplatz', () => {
  it('W gedrückt: die Rampe hinauf auf die Plattform (über Input + Steuerung + Kamera)', () => {
    const settings = defaultSettings();
    const input = new Input(settings, { getGamepads: () => [] });
    const game = createTestGame({ input, settings });
    game.startMode('practice');
    const p = game.player;
    const S = CONFIG.world.gridCellSize;
    p.spawnAt({ x: -5.5 * S, y: 0, z: S }, 0); // vor Rampe A, Blick nach −Z
    input.setVirtual('moveForward', true);
    game.simulate(2); // eine Zelle bis zur Rampe, die Rampe hinauf, ein Stück auf die Plattform
    input.setVirtual('moveForward', false);
    game.simulate(0.3);
    assert.close(p.position.y, CONFIG.modes.practice.platformHeight, 1e-6, 'auf der Plattform (ein Stockwerk)');
    // Blick drehen: 90° nach rechts
    const turn = (Math.PI / 2) / (RADIANS_PER_COUNT_PER_PERCENT * CONFIG.sensitivity.x);
    input.addLook(turn, 0);
    game.simulate(1 / 60);
    assert.close(p.yaw, -Math.PI / 2, 1e-6);
    game.dispose();
  });
});

describe('Szenario: Zufalls-Spaziergang über den Übungsplatz', () => {
  it('8 Figuren, 2 x 30 s zufällig laufen/springen/ducken: nie in einer Wand, nie unter dem Boden', () => {
    let checks = 0;
    for (const seed of [3, 11]) {
      const game = createTestGame({ seed });
      game.startMode('practice');
      const rng = createRng(seed * 77);
      const walkers = [];
      for (let i = 0; i < 8; i++) {
        const c = addDrivenCharacter(game, { name: `W${i}`, position: { x: (rng() - 0.5) * 60, y: 0, z: (rng() - 0.5) * 60 }, yaw: rng() * 6.28 });
        c.brain.fields.moveZ = 1;
        walkers.push(c);
      }
      for (let t = 0; t < 30 * 60; t++) {
        for (const c of walkers) {
          const f = c.brain.fields;
          if (rng() < 0.02) f.yaw = rng() * 6.28;
          if (rng() < 0.02) f.moveX = (rng() - 0.5) * 2;
          f.jumpPressed = rng() < 0.01;
          f.jump = rng() < 0.05;
          if (rng() < 0.01) f.crouch = !f.crouch;
          f.sprint = rng() < 0.5;
        }
        game.fixedUpdate(1 / 60);
        if (t < 120) continue; // Startpunkte dürfen in Kisten liegen – erst hinauslaufen lassen
        for (const c of walkers) {
          const p = c.position;
          assert.ok(Number.isFinite(p.x + p.y + p.z), `${c.name}: Position ungültig`);
          assert.ok(p.y > -0.001, `${c.name}: unter dem Boden (y = ${p.y})`);
          const half = CONFIG.modes.practice.arenaSize / 2;
          assert.ok(Math.abs(p.x) < half + 0.01 && Math.abs(p.z) < half + 0.01, `${c.name}: aus der Arena`);
          assert.ok(bodyFits(game.world, p.x, p.y, p.z, c.radius, c.height),
            `${c.name} steckt fest bei ${p.toArray().map((v) => v.toFixed(2)).join(', ')} (Tick ${t})`);
          checks++;
        }
      }
      game.dispose();
    }
    assert.ok(checks > 20000);
  });
});
