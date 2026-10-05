// Tests für das Spiel-Objekt (src/core/game.js) und die Attrappen der späteren Systeme
import { describe, it, assert } from './runner.js';
import { CONFIG } from '../src/config.js';
import { Game } from '../src/core/game.js';
import { MODES, getModeDef, DEFAULT_MODE_ID } from '../src/modes/index.js';
import { createBuildingSystem } from '../src/building/structure.js';
import { createWeaponSystem } from '../src/weapons/weapons.js';
import { createProjectileSystem } from '../src/weapons/projectiles.js';
import { createEffects } from '../src/world/effects.js';
import { createAudio } from '../src/audio/sfx.js';
import { createHud } from '../src/ui/hud.js';
import { createBotBrain } from '../src/ai/bot.js';
import { createStorm } from '../src/world/storm.js';
import { createLootSystem } from '../src/world/loot.js';

describe('Spiel (Game)', () => {
  it('ohne Bildschirm: alle Teile sind da', () => {
    const game = new Game({ headless: true, seed: 3 });
    for (const key of ['config', 'settings', 'events', 'rng', 'scene', 'world', 'characters', 'building', 'weapons',
      'projectiles', 'effects', 'audio', 'hud', 'systems', 'cameraRig', 'playerController']) {
      assert.ok(game[key] !== undefined && game[key] !== null, key);
    }
    assert.equal(game.time, 0);
    assert.equal(game.tick, 0);
    assert.equal(game.player, null);
    const r = game.rng();
    assert.ok(r >= 0 && r < 1);
    game.dispose();
  });

  it('Reihenfolge im Logik-Schritt wie in ARCHITECTURE.md §5', () => {
    const game = new Game({ headless: true });
    const log = [];
    game.mode = { preUpdate: () => log.push('mode.pre'), update: () => log.push('mode.update'), onCharacterKilled() {} };
    const bot = game.addCharacter({ name: 'B', isBot: true, brain: { think: () => { log.push('think'); return null; } } });
    const original = bot.applySelection.bind(bot);
    bot.applySelection = (cmd) => { log.push('select'); original(cmd); };
    game.building.updateCharacter = () => log.push('building.char');
    game.weapons.updateCharacter = () => log.push('weapons.char');
    game.projectiles.update = () => log.push('projectiles');
    game.building.update = () => log.push('building');
    game.systems.push({ update: (dt, g) => log.push(g === game ? 'system' : 'falsch') });
    game.fixedUpdate(1 / 60);
    assert.deepEqual(log, ['mode.pre', 'think', 'select', 'building.char', 'weapons.char', 'projectiles', 'building',
      'mode.update', 'system']);
    assert.equal(game.tick, 1);
    assert.close(game.time, 1 / 60, 1e-12);
    game.dispose();
  });

  it('simulate(1) = 60 Logik-Schritte', () => {
    const game = new Game({ headless: true });
    game.simulate(1);
    assert.equal(game.tick, CONFIG.loop.tickRate);
    assert.close(game.time, 1, 1e-9);
    game.dispose();
  });

  it('Figuren hinzufügen/entfernen; ohne Bildschirm keine Grafik', () => {
    const game = new Game({ headless: true });
    const p = game.addCharacter({ isPlayer: true, name: 'Ich' });
    const b = game.addCharacter({ isBot: true });
    assert.equal(game.player, p);
    assert.equal(p.view, null);
    assert.ok(b.brain && typeof b.brain.think === 'function', 'Bots bekommen ein Gehirn');
    const idle = game.addCharacter({ isBot: true, brain: null });
    assert.equal(idle.brain, null, 'brain: null = steht nur da');
    game.removeCharacter(p);
    assert.equal(game.player, null);
    assert.equal(game.characters.length, 2);
    game.dispose();
  });

  it('besiegte Figur → mode.onCharacterKilled(victim, killer)', () => {
    const game = new Game({ headless: true });
    let got = null;
    game.mode = { onCharacterKilled: (victim, killer) => { got = { victim, killer }; } };
    const a = game.addCharacter({ name: 'A' });
    const b = game.addCharacter({ name: 'B', shield: 0 });
    b.applyDamage(500, { attacker: a });
    assert.equal(got.victim, b);
    assert.equal(got.killer, a);
    game.dispose();
  });

  it('Modi: Liste, Übungsplatz starten, unbekannter Modus ist ein Fehler', () => {
    assert.ok(MODES.length >= 1);
    assert.ok(getModeDef(DEFAULT_MODE_ID));
    assert.equal(getModeDef('gibtsnicht'), null);
    const game = new Game({ headless: true });
    const mode = game.startMode('practice');
    for (const key of ['id', 'start', 'preUpdate', 'update', 'onCharacterKilled', 'hudInfo', 'dispose']) {
      assert.ok(key in mode, `Modus hat ${key}`);
    }
    assert.ok(game.player, 'Spieler da');
    assert.equal(game.characters.length, 1 + CONFIG.modes.practice.idleBots);
    assert.ok(game.world.colliders.length > 10, 'Stationen haben Kollision');
    assert.equal(mode.isOver, false);
    assert.equal(mode.hudInfo().topCenter, CONFIG.modes.practice.name);
    assert.throws(() => game.startMode('gibtsnicht'));
    game.dispose();
    assert.equal(game.world.colliders.length, 0, 'dispose räumt die Welt auf');
    assert.equal(game.characters.length, 0);
  });

  it('Übungsplatz: Spieler steht nach dem Besiegtwerden wieder auf', () => {
    const game = new Game({ headless: true });
    game.startMode('practice');
    const p = game.player;
    p.applyDamage(1000, { bypassShield: true });
    assert.ok(!p.alive);
    game.simulate(CONFIG.modes.practice.respawnDelay + 0.1);
    assert.ok(p.alive);
    assert.equal(p.health, CONFIG.modes.practice.startHealth);
    assert.close(p.position.z, CONFIG.modes.practice.spawn.z, 1e-6);
    game.dispose();
  });
});

describe('Attrappen der späteren Systeme (gleiche Methoden-Namen wie im Bauplan)', () => {
  const game = { time: 0, events: { on() {}, emit() {} } };
  const check = (name, obj, methods) => {
    for (const m of methods) assert.equal(typeof obj[m], 'function', `${name}.${m}`);
  };

  it('Bauen, Waffen, Geschosse, Effekte, Ton, HUD', () => {
    const building = createBuildingSystem(game);
    check('building', building, ['updateCharacter', 'update', 'placePiece', 'removePiece', 'clearAll', 'countFor',
      'getPieceAt', 'frameUpdate', 'canEdit', 'closeEdit']);
    assert.ok(building.pieces instanceof Map);
    assert.equal(building.canEdit({}), false);
    check('weapons', createWeaponSystem(game), ['updateCharacter', 'giveLoadout', 'createItem', 'frameUpdate']);
    check('projectiles', createProjectileSystem(game), ['spawn', 'update', 'clear']);
    check('effects', createEffects(game), ['frameUpdate']);
    check('audio', createAudio(game), ['setVolumes', 'frameUpdate']);
    check('hud', createHud(game, null), ['frameUpdate', 'dispose']);
  });

  it('Bot-Gehirn, Sturm, Loot', () => {
    const character = { yaw: 1.2, pitch: -0.1 };
    const brain = createBotBrain(character, game, 'easy');
    const cmd = brain.think(1 / 60);
    assert.equal(cmd.yaw, 1.2);
    assert.equal(cmd.moveZ, 0);
    const storm = createStorm(game, {});
    check('storm', storm, ['update', 'isInside']);
    assert.ok(storm.isInside({ x: 1e6, y: 0, z: 0 }));
    for (const key of ['center', 'radius', 'nextCenter', 'nextRadius', 'phase', 'state', 'timeLeft', 'damagePerSecond']) {
      assert.ok(key in storm, `storm.${key}`);
    }
    const loot = createLootSystem(game, {});
    check('loot', loot, ['update', 'dropAll', 'spawnFloorItem']);
    assert.ok(Array.isArray(loot.chests));
  });
});
