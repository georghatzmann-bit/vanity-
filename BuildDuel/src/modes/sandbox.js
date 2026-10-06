// =============================================================================
// Test-Modi für die Welt (nur für Entwickler, im Menü versteckt: hidden: true)
// =============================================================================
// Die echten Modi (Duell, Battle Royale, Zone Wars) kommen in Welle 4. Diese
// kleinen Modi laden die Welt-Teile zum Ausprobieren und für die Browser-Tests:
//   'sandbox-island'   – Insel + Sturm + Kisten/Boden-Loot + Absprung-Ballon
//                        (Spieler und ein paar stehende Bots fliegen mit)
//   'sandbox-arena'    – Duell-Arena mit Felsen und Bäumen, Spieler + Gegner an den Startpunkten
//   'sandbox-zonewars' – Zone-Wars-Karte mit wandernder Zone
// Start im Browser: index.html?mode=sandbox-island
// =============================================================================
import { CONFIG } from '../config.js';
import { createIslandMap } from '../world/mapIsland.js';
import { createArenaMap } from '../world/mapArena.js';
import { createZoneWarsMap } from '../world/mapZoneWars.js';
import { createStorm } from '../world/storm.js';
import { createLootSystem } from '../world/loot.js';
import { createJumpVehicle } from '../world/jumpVehicle.js';
import { WEAPON_IDS } from '../weapons/weapons.js';

const RESPAWN_DELAY = 3; // nur Test-Modus

function stormText(storm) {
  if (!storm || storm.state === 'closed' || !Number.isFinite(storm.radius)) return storm?.state === 'closed' ? 'Zone geschlossen' : null;
  const s = Math.ceil(storm.timeLeft);
  const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return storm.state === 'wait' ? `Zone schrumpft in ${time}` : `Zone schrumpft … ${time}`;
}

function addPlayer(game, position, yaw, options = {}) {
  return game.addCharacter({
    name: game.settings?.game?.playerName ?? 'Spieler',
    isPlayer: true,
    team: 1,
    skin: CONFIG.skins.defaultId,
    position,
    yaw,
    health: options.health ?? 100,
    shield: options.shield ?? 0,
    materials: options.materials ?? { wood: 0, stone: 0, metal: 0 },
  });
}

function addIdleBots(game, count, positions, options = {}) {
  const skins = CONFIG.skins.list.filter((s) => s.id !== CONFIG.skins.defaultId);
  const list = [];
  for (let i = 0; i < count; i++) {
    const p = positions[i % positions.length] ?? { x: 0, y: 0, z: 0, yaw: 0 };
    list.push(game.addCharacter({
      name: CONFIG.bots.names[i],
      isBot: true,
      brain: options.brain === undefined ? undefined : options.brain,
      team: 100 + i,
      skin: skins[i % skins.length].id,
      position: p,
      yaw: p.yaw ?? 0,
      health: 100,
      shield: options.shield ?? 0,
      materials: options.materials ?? { wood: 0, stone: 0, metal: 0 },
    }));
  }
  return list;
}

// ---------------------------------------------------------------------------
// Insel
// ---------------------------------------------------------------------------
export function createIslandSandbox(game, options = {}) {
  const br = CONFIG.modes.battleRoyale;
  let map = null;
  let vehicle = null;
  let respawnAt = -1;
  const mode = {
    id: 'sandbox-island',
    name: 'Test: Insel',
    options,
    isOver: false,
    result: null,
    helpHint: 'Test-Insel: Leertaste = aus dem Ballon springen (über der Insel), Gleiter öffnet sich von selbst. ' +
      'E öffnet Kisten und hebt Waffen auf, Munition und Material sammelt man im Vorbeilaufen.',
    start() {
      map = createIslandMap(game, { seed: options.mapSeed });
      game.map = map;
      game.useRarity = true;
      game.storm = createStorm(game, { ...br.storm, autoStart: options.stormAutoStart ?? true });
      game.loot = createLootSystem(game, { rarityWeights: br.rarityWeights, chest: br.chest });
      game.loot.populate(map);
      const bots = options.bots ?? 3;
      const spawns = map.spawnPoints(1 + bots, { minDistance: 30 });
      addPlayer(game, spawns[0], spawns[0].yaw);
      addIdleBots(game, bots, spawns.slice(1), { brain: null });
      if (options.skipVehicle) return;
      vehicle = createJumpVehicle(game, { path: map.jumpPath(game.rng) });
      game.systems.push(vehicle);
      for (const c of game.characters) vehicle.board(c);
      vehicle.scheduleBotDrops(game.rng);
    },
    update() {
      const p = game.player;
      if (p && !p.alive && respawnAt >= 0 && game.time >= respawnAt) {
        respawnAt = -1;
        const spot = map.spawnPoints(1, { minDistance: 0 })[0];
        p.resetForRound({ health: 100, shield: 0, position: spot, yaw: spot.yaw });
        game.cameraRig?.snap();
      }
    },
    onCharacterKilled(victim) {
      if (victim === game.player) respawnAt = game.time + RESPAWN_DELAY;
    },
    hudInfo() {
      const alive = game.characters.filter((c) => c.alive).length;
      const area = game.player ? map?.areaAt(game.player.position.x, game.player.position.z) : null;
      return { topCenter: area ?? mode.name, alive, kills: game.player?.stats.kills ?? 0, zoneText: stormText(game.storm), extra: [] };
    },
    get vehicle() {
      return vehicle;
    },
    dispose() {
      if (vehicle) {
        const i = game.systems.indexOf(vehicle);
        if (i >= 0) game.systems.splice(i, 1);
        vehicle.dispose();
        vehicle = null;
      }
      game.useRarity = false;
      map?.dispose();
      if (game.map === map) game.map = null;
      map = null;
    },
  };
  return mode;
}

// ---------------------------------------------------------------------------
// Duell-Arena
// ---------------------------------------------------------------------------
export function createArenaSandbox(game, options = {}) {
  const duel = CONFIG.modes.duel;
  let map = null;
  const mode = {
    id: 'sandbox-arena',
    name: 'Test: Duell-Arena',
    options,
    isOver: false,
    result: null,
    helpHint: 'Test-Arena: Felsen und Bäume (Spitzhacke: F). Die unsichtbare Wand über der Mauer hält dich drin.',
    start() {
      map = createArenaMap(game, { size: duel.arenaSize, props: true, seed: options.seed });
      game.map = map;
      const [a, b] = map.spawnPoints(2);
      const player = addPlayer(game, a, a.yaw, { shield: duel.startShield, materials: duel.startMaterials });
      const [bot] = addIdleBots(game, 1, [b], { brain: null, shield: duel.startShield, materials: duel.startMaterials });
      for (const c of [player, bot]) game.weapons.giveLoadout(c, duel.loadout, { infiniteReserve: duel.infiniteReserveAmmo });
    },
    update() {},
    onCharacterKilled() {},
    hudInfo() {
      return { topCenter: mode.name, alive: null, kills: null, zoneText: null, extra: [] };
    },
    dispose() {
      map?.dispose();
      if (game.map === map) game.map = null;
      map = null;
    },
  };
  return mode;
}

// ---------------------------------------------------------------------------
// Zone Wars
// ---------------------------------------------------------------------------
export function createZoneWarsSandbox(game, options = {}) {
  const zw = CONFIG.modes.zoneWars;
  let map = null;
  const mode = {
    id: 'sandbox-zonewars',
    name: 'Test: Zone Wars',
    options,
    isOver: false,
    result: null,
    helpHint: 'Test-Zone-Wars: hügelige Karte, die Zone wandert und schrumpft schnell.',
    start() {
      map = createZoneWarsMap(game, { seed: options.mapSeed });
      game.map = map;
      game.storm = createStorm(game, { ...zw.storm, autoStart: options.stormAutoStart ?? true });
      const spawns = map.spawnPoints(zw.totalPlayers);
      const player = addPlayer(game, spawns[0], spawns[0].yaw, { shield: zw.startShield, materials: zw.startMaterials });
      const bots = addIdleBots(game, zw.totalPlayers - 1, spawns.slice(1), { brain: null, shield: zw.startShield, materials: zw.startMaterials });
      // zufällige Waffen (Zone Wars: randomLoadout)
      for (const c of [player, ...bots]) {
        const pick = (list) => list[Math.floor(game.rng() * list.length)];
        game.weapons.giveLoadout(c, ['shotgun', pick(['ar', 'smg', 'pistol']), pick(WEAPON_IDS.filter((w) => w !== 'shotgun'))], {
          rarity: CONFIG.rarities.order[Math.floor(game.rng() * 5)],
          infiniteReserve: true,
        });
      }
    },
    update() {},
    onCharacterKilled() {},
    hudInfo() {
      return { topCenter: mode.name, alive: game.characters.filter((c) => c.alive).length, kills: game.player?.stats.kills ?? 0, zoneText: stormText(game.storm), extra: [] };
    },
    dispose() {
      map?.dispose();
      if (game.map === map) game.map = null;
      map = null;
    },
  };
  return mode;
}
