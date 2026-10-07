// Szenario: Kreativ-Modus ohne Bildschirm – unendlich Material, "Alles löschen", Bauteile/s
import { describe, it, assert } from '../runner.js';
import { CONFIG } from '../../src/config.js';
import { createTestGame } from './helpers.js';
import { driveByCommands, buildOnce, tap } from './buildHelpers.js';
import { lobbyModes, getModeDef } from '../../src/modes/index.js';

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
});
