// Szenario: Kreativ-Modus ohne Bildschirm – unendlich Material, "Alles löschen", Bauteile/s
import { describe, it, assert } from '../runner.js';
import { CONFIG } from '../../src/config.js';
import { createTestGame, collect } from './helpers.js';
import { driveByCommands, buildOnce, tap } from './buildHelpers.js';
import { lobbyModes, getModeDef } from '../../src/modes/index.js';
import { isFlying } from '../../src/modes/creativeFly.js';

const FLY = CONFIG.modes.creative.fly;
const S = CONFIG.world.gridCellSize;
const H = CONFIG.world.wallHeight;

// 2× Springen mit kurzer Pause dazwischen (wie ein Spieler)
function doubleJump(game, fields, gapTicks = 6) {
  tap(game, fields, { jumpPressed: true });
  for (let i = 0; i < gapTicks; i++) tap(game, fields);
  tap(game, fields, { jumpPressed: true });
}
// so viele Sekunden simulieren (Befehle aus fields)
function run(game, fields, seconds) {
  for (let i = 0; i < Math.round(seconds * 60); i++) tap(game, fields);
}

function startCreative() {
  const game = createTestGame();
  game.startMode('creative');
  const p = game.player;
  const fields = driveByCommands(p, 0, -0.35);
  game.simulate(0.2);
  return { game, p, fields };
}

describe('Szenario: Kreativ-Modus', () => {
  it('startet: große Arena, Spieler mit unendlich Material und allen Waffen, Zielpuppen', () => {
    const { game, p } = startCreative();
    assert.equal(game.mode.id, 'creative');
    assert.equal(game.map.size, CONFIG.modes.creative.arenaSize);
    assert.ok(p.infiniteMaterials, 'unendlich Material');
    assert.ok(p.slots.filter(Boolean).length >= 5, 'alle Waffen + Heilen');
    assert.ok(game.characters.length > 1, 'Zielpuppen da');
    const info = game.mode.hudInfo();
    assert.equal(info.topCenter, 'Kreativ');
    assert.ok(info.extra.some((line) => line.startsWith('Bauteile/s')), 'Bauteile/s im HUD');
    game.dispose();
  });

  it('unendlich Material: viele Bauteile, Material bleibt gleich', () => {
    const { game, p, fields } = startCreative();
    const before = { ...p.materials };
    let placed = 0;
    const types = ['wall', 'floor', 'ramp', 'wall', 'floor'];
    for (let i = 0; i < 25; i++) {
      fields.yaw = (i / 25) * Math.PI * 2;
      if (buildOnce(game, p, fields, types[i % types.length])) placed++;
      game.simulate(0.05);
    }
    assert.ok(placed >= 10, `gebaut: ${placed}`);
    assert.deepEqual(p.materials, before, 'Material unverändert');
    assert.equal(game.mode.stats.total, placed);
    game.dispose();
  });

  it('Bauteile/s zählt die letzte Sekunde, Rekord bleibt', () => {
    const { game, p, fields } = startCreative();
    for (let i = 0; i < 4; i++) {
      fields.yaw = i * (Math.PI / 2);
      buildOnce(game, p, fields, 'wall');
    }
    game.simulate(0.05);
    const rate = game.mode.stats.perSecond;
    assert.ok(rate >= 3, `Bauteile/s direkt danach: ${rate}`);
    game.simulate(CONFIG.modes.creative.piecesPerSecondWindow + 0.1);
    assert.equal(game.mode.stats.perSecond, 0, 'nach einer Sekunde ohne Bauen: 0');
    assert.ok(game.mode.stats.best >= rate, 'Rekord bleibt');
    game.dispose();
  });

  it('Alles löschen: Taste (Aktion clearBuilds) und Funktion entfernen alle Bauteile', () => {
    const { game, p, fields } = startCreative();
    buildOnce(game, p, fields, 'wall');
    fields.yaw = Math.PI;
    buildOnce(game, p, fields, 'floor');
    assert.ok(game.building.pieces.size >= 2, 'Bauteile da');
    // wie die echte Eingabe: ein Tick mit pressed.clearBuilds
    const sample = { pressed: { clearBuilds: true }, held: {}, released: {} };
    game.lastSample = null;
    game.mode.preUpdate(1 / 60); // ohne Eingabe: nichts passiert
    assert.ok(game.building.pieces.size >= 2);
    game.lastSample = sample;
    game.mode.preUpdate(1 / 60);
    assert.equal(game.building.pieces.size, 0, 'Taste P löscht alles');
    buildOnce(game, p, fields, 'wall');
    assert.ok(game.building.pieces.size >= 1);
    game.mode.clearAll();
    assert.equal(game.building.pieces.size, 0, 'Knopf löscht alles');
    assert.equal(game.mode.stats.cleared, 2);
    tap(game, fields);
    game.dispose();
  });

  it('aus der Welt gefallen oder besiegt → zurück zum Start', () => {
    const { game, p } = startCreative();
    // flacher Boden fängt einen sonst auf – darum direkt unter die Welt setzen und den Modus fragen
    p.position.set(5, -30, 5);
    game.mode.update(1 / 60);
    assert.ok(p.position.y >= 0 && Math.abs(p.position.z - CONFIG.modes.creative.spawn.z) < 0.5, `zurückgesetzt: ${p.position.y}`);
    p.applyDamage(500, { kind: 'fall', ignoreInvulnerable: true });
    assert.ok(!p.alive);
    game.simulate(CONFIG.modes.creative.respawnDelay + 0.2);
    assert.ok(p.alive, 'wieder da');
    game.dispose();
  });

  it('Lobby-Liste: Kreativ und Übungsplatz wählbar, Test-Modi nie, Rest "bald"', () => {
    const list = lobbyModes();
    assert.equal(list[0].id, 'creative');
    assert.ok(list.find((m) => m.id === 'creative').available);
    assert.ok(list.find((m) => m.id === 'practice').available);
    assert.ok(!list.some((m) => m.id.startsWith('sandbox')), 'keine Test-Modi');
    for (const m of list) assert.equal(m.available, !!getModeDef(m.id) && !getModeDef(m.id).hidden, m.id);
    assert.ok(list.some((m) => !m.available), 'manche sind "bald"');
  });

  it('Fliegen: 2× Springen schaltet an, kein Absinken; nochmal 2× Springen = normal fallen', () => {
    const { game, p, fields } = startCreative();
    fields.pitch = 0;
    // einmal Springen: nur ein Sprung, kein Fliegen
    tap(game, fields, { jumpPressed: true });
    run(game, fields, 1);
    assert.ok(!isFlying(p) && p.grounded, 'ein Sprung allein: nicht fliegen');
    // zu langsam (Pause länger als doubleTapTime): auch nicht
    doubleJump(game, fields, Math.ceil(FLY.doubleTapTime * 60) + 3);
    assert.ok(!isFlying(p), 'zu langsam: kein Fliegen');
    run(game, fields, 1);
    doubleJump(game, fields);
    assert.ok(isFlying(p), `2× schnell: fliegt (${p.moveState})`);
    const y = p.position.y;
    assert.ok(y > 0.3, `in der Luft: ${y.toFixed(2)}`);
    run(game, fields, 1);
    assert.ok(isFlying(p) && Math.abs(p.position.y - y) < 0.05, `schwebt: ${y.toFixed(2)} → ${p.position.y.toFixed(2)}`);
    // HUD-Zeile zeigt den Zustand
    assert.ok(game.mode.hudInfo().extra.some((l) => l.startsWith('Fliegen: an')), 'HUD: Fliegen an');
    doubleJump(game, fields);
    assert.ok(!isFlying(p), 'wieder aus');
    run(game, fields, 1.5);
    assert.ok(p.grounded && Math.abs(p.position.y) < 1e-6, `gelandet: ${p.position.y.toFixed(2)}`);
    assert.ok(game.mode.hudInfo().extra.includes('Fliegen: 2× Springen'), 'HUD-Hinweis');
    game.dispose();
  });

  it('Fliegen: Springen halten = hoch, Ducken halten = runter, WASD in Blickrichtung, Sprinten schneller, Boden = landen', () => {
    const { game, p, fields } = startCreative();
    fields.pitch = 0;
    doubleJump(game, fields);
    assert.ok(isFlying(p));
    // hoch
    const y0 = p.position.y;
    fields.jump = true;
    run(game, fields, 2);
    fields.jump = false;
    const up = p.position.y - y0;
    assert.ok(up > FLY.verticalSpeed * 2 * 0.8 && up < FLY.verticalSpeed * 2 * 1.05, `hoch in 2 s: ${up.toFixed(2)} m`);
    assert.ok(!p.crouching, 'aufrecht');
    // waagerecht: Blick nach −Z, W
    run(game, fields, 0.5);
    const z0 = p.position.z;
    const yHover = p.position.y;
    fields.moveZ = 1;
    run(game, fields, 1);
    const walked = z0 - p.position.z;
    assert.ok(walked > FLY.speed * 0.8 && walked < FLY.speed * 1.01, `W 1 s: ${walked.toFixed(2)} m`);
    assert.ok(Math.abs(p.position.y - yHover) < 1e-6, 'Höhe bleibt beim Vorwärtsfliegen');
    fields.sprint = true;
    run(game, fields, 0.5);
    const z1 = p.position.z;
    run(game, fields, 1);
    assert.ok(z1 - p.position.z > FLY.speed * 1.5, `mit Sprinten schneller: ${(z1 - p.position.z).toFixed(2)} m/s`);
    fields.sprint = false;
    fields.moveZ = 0;
    run(game, fields, 0.6);
    // runter bis zum Boden: Landen beendet das Fliegen
    const lands = collect(game, 'land');
    fields.crouch = true;
    run(game, fields, 6);
    fields.crouch = false;
    assert.ok(!isFlying(p) && p.grounded && Math.abs(p.position.y) < 1e-6, `gelandet: ${p.moveState} y=${p.position.y.toFixed(2)}`);
    assert.ok(lands.length >= 1);
    assert.equal(p.health, CONFIG.modes.creative.startHealth);
    game.dispose();
  });

  it('kein Fallschaden im Kreativ-Modus (auch aus 40 m)', () => {
    const { game, p, fields } = startCreative();
    fields.pitch = 0;
    doubleJump(game, fields);
    fields.jump = true;
    run(game, fields, 5);
    fields.jump = false;
    assert.ok(p.position.y > 35, `hoch: ${p.position.y.toFixed(1)} m`);
    const lands = collect(game, 'land');
    doubleJump(game, fields); // Fliegen aus → fallen
    run(game, fields, 4);
    assert.ok(p.grounded && lands.length === 1, 'gelandet');
    assert.ok(lands[0].fallHeight > CONFIG.player.fallDamage.safeHeight, `Fallhöhe ${lands[0].fallHeight.toFixed(1)} m`);
    assert.equal(p.health, CONFIG.modes.creative.startHealth, 'Leben voll');
    assert.equal(p.shield, CONFIG.modes.creative.startShield, 'Schild voll');
    game.dispose();
  });

  it('Bauen und Editieren im Flug (wie in Fortnite Kreativ)', () => {
    const { game, p, fields } = startCreative();
    fields.pitch = 0;
    const b = game.building;
    assert.ok(buildOnce(game, p, fields, 'wall'), 'Wand am Boden');
    doubleJump(game, fields);
    assert.ok(isFlying(p));
    // eine Ebene höher fliegen und dort eine Wand auf die untere setzen
    fields.jump = true;
    const target = H + 0.6;
    for (let i = 0; i < 600 && p.position.y < target; i++) tap(game, fields);
    fields.jump = false;
    run(game, fields, 0.3);
    assert.ok(isFlying(p) && p.position.y > H, `oben: ${p.position.y.toFixed(2)}`);
    const t = b.getTarget(p, 'wall');
    assert.equal(t.j, 1, `Ziel eine Ebene höher (${t.slotKey}, ${t.reason})`);
    const upper = buildOnce(game, p, fields, 'wall');
    assert.ok(upper && upper.j === 1, `Wand im Flug gesetzt: ${upper?.slotKey}`);
    assert.ok(isFlying(p), 'fliegt weiter');
    // Boden vor sich (steht auf der oberen Wand) und Edit der oberen Wand
    assert.ok(buildOnce(game, p, fields, 'floor'), 'Boden im Flug');
    run(game, fields, 1.2); // fertig aufbauen
    const cx = (upper.i + 0.5) * S;
    const eye = p.eyePosition({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
    fields.yaw = Math.atan2(-(cx - eye.x), -(upper.k * S - eye.z));
    fields.pitch = Math.atan2(upper.j * H + H / 2 - eye.y, Math.hypot(cx - eye.x, upper.k * S - eye.z));
    tap(game, fields);
    tap(game, fields, { editPressed: true });
    assert.equal(p.mode, 'edit', 'Edit im Flug');
    tap(game, fields, { editPressed: true });
    assert.ok(isFlying(p), 'immer noch in der Luft');
    game.dispose();
  });
});
