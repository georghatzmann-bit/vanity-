// Szenario: Ein Spiel ohne HUD (headless bzw. ohne HTML-Ebene) läuft trotzdem –
// mit Schüssen, Treffern, Kills, Bauen und Zerstören (alle Ereignisse, auf die HUD,
// Ton und Effekte hören).
import { describe, it, assert } from '../runner.js';
import { Game } from '../../src/core/game.js';
import { createTestGame, addShooter, addTarget, bodyPoint, simulateUntil } from './weaponHelpers.js';

function fightScene(game) {
  const { c, ctl } = addShooter(game, { position: { x: 0, y: 0, z: 0 } });
  game.weapons.giveLoadout(c, ['shotgun', 'ar']);
  const target = addTarget(game, { x: 0, y: 0, z: -8 }, { health: 60, shield: 50 });
  ctl.select(2);
  game.simulate(0.4);
  ctl.aimAt = bodyPoint(target);
  ctl.primary = true;
  return { c, ctl, target };
}

describe('Szenario: Spiel ohne HUD', () => {
  it('headless: HUD, Ton und Effekte sind Attrappen, das Spiel läuft mit Kills weiter', () => {
    const game = createTestGame();
    assert.equal(game.hud.headless, true);
    assert.equal(game.audio.enabled, false);
    const { ctl, target } = fightScene(game);
    let kills = 0;
    game.events.on('characterKilled', () => kills++);
    const t = simulateUntil(game, () => !target.alive, 5);
    ctl.primary = false;
    assert.ok(t >= 0, 'Ziel besiegt');
    assert.equal(kills, 1);
    game.simulate(1);
    // Hinweis-API ohne Bildschirm: tut nichts, wirft nichts
    game.hud.setPrompt('Tür öffnen');
    game.hud.setPrompt(null);
    game.frameUpdate(1 / 60, 1);
    game.dispose();
  });

  it('Übungsplatz headless: 3 Sekunden mit Bauen und Zerstören', () => {
    const game = createTestGame();
    game.startMode('practice');
    const p = game.player;
    assert.ok(p, 'Spieler da');
    // Wand hinstellen und zerstören (Ereignisse für Ton/Effekte), dann weiter simulieren
    game.simulate(0.2);
    game.building.placePiece('wall', 'wx:0:0:4', p, 'wood', { instant: true, force: true });
    const piece = game.building.getPieceAt('wx:0:0:4');
    assert.ok(piece, 'Wand steht');
    piece.applyDamage(1000, { attacker: p });
    game.simulate(0.5);
    assert.equal(game.building.getPieceAt('wx:0:0:4'), null, 'Wand zerstört');
    game.simulate(2.5);
    for (let i = 0; i < 10; i++) game.frameUpdate(1 / 60, 1);
    game.dispose();
  });

  it('mit Bildschirm-Teilen, aber ohne HTML-Ebene (HUD aus): läuft und räumt auf', () => {
    // headless: false, aber kein uiRoot und keine Kamera → HUD ist eine Attrappe,
    // Effekte und Figuren-Grafik werden trotzdem gebaut (ohne zu malen)
    const game = new Game({ headless: false, seed: 3, uiRoot: null });
    assert.equal(game.hud.headless, true, 'ohne uiRoot kein HUD');
    const { ctl, target } = fightScene(game);
    simulateUntil(game, () => !target.alive, 5);
    ctl.primary = false;
    for (let i = 0; i < 30; i++) {
      game.fixedUpdate(1 / 60);
      game.frameUpdate(1 / 60, 1);
    }
    const stats = game.effects.stats();
    assert.ok(stats.capacity.dust > 0, 'Effekt-Vorrat angelegt');
    assert.ok(stats.dust <= stats.capacity.dust && stats.chunks <= stats.capacity.chunks && stats.glow <= stats.capacity.glow);
    assert.ok(!target.alive);
    game.dispose();
    assert.ok(game.disposed);
  });
});
