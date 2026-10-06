// =============================================================================
// Übungsplatz (Phase 2 – Start-Modus, bis es Menüs gibt)
// =============================================================================
// Eine 80 x 80 m Arena mit Stationen zum Ausprobieren:
//   - Kisten 0,3 m / 1 m / 2 m: die kleine steigt man einfach hoch, die anderen nicht
//   - hohe Wand (4 m): Kamera stößt an und geht nicht hindurch
//   - 45°-Rampe auf eine 4-m-Plattform – hochlaufen ohne Springen
//   - Turm (12 m, über Rampen erreichbar): herunterfallen = 50 Fallschaden
//   - niedrige Decke (1,5 m): nur geduckt passt man hindurch
//   - frei stehende Rampe, unter der man durchlaufen kann
//   - kleines Dach (Pyramide) zum Drüberlaufen
//   - ein paar stehende Übungs-Figuren (ohne KI)
//   - Phase 5: alle Waffen, Schieß-Stand mit Zielpuppen, Baum/Fels/Auto für die
//     Spitzhacke (weapons/practiceRange.js, Werte in CONFIG.practiceRange)
// Alle Höhen stehen in config.js unter modes.practice.
// =============================================================================
import { CONFIG } from '../config.js';
import { createArenaMap } from '../world/mapArena.js';
import { createPracticeRange } from '../weapons/practiceRange.js';

const COLORS = {
  step: ['#FFD166', '#FF9F43', '#EF6F6C'],
  wall: '#8FA3BF',
  ramp: '#4ECDC4',
  platform: '#5DADE2',
  tower: '#A78BFA',
  towerRamp: '#C4B5FD',
  tunnel: '#6BCB77',
  bridge: '#FF8FB1',
  post: '#B4BCC8',
  roof: '#D9A066',
  roofBase: '#E8D5B5',
};

/**
 * @param {object} game
 * @param {object} [options]  { seed }
 */
export function createPracticeMode(game, options = {}) {
  const cfg = CONFIG.modes.practice;
  const thickness = CONFIG.building.pieceThickness;
  let map = null;
  let respawnAt = -1;
  let range = null; // Schieß-Stand mit Zielpuppen (Phase 5, weapons/practiceRange.js)

  const mode = {
    id: 'practice',
    name: cfg.name,
    options,
    isOver: false,
    result: null,
    spawnPoint: { x: cfg.spawn.x, y: 0, z: cfg.spawn.z },
    spawnYaw: 0,

    start() {
      map = createArenaMap(game, { size: cfg.arenaSize, borderHeight: cfg.borderHeight });
      game.map = map;
      buildCourse(map, cfg, thickness);

      // Spieler
      game.addCharacter({
        name: game.settings?.game?.playerName ?? 'Spieler',
        isPlayer: true,
        team: 1,
        skin: CONFIG.skins.defaultId,
        position: mode.spawnPoint,
        yaw: mode.spawnYaw,
        health: cfg.startHealth,
        shield: cfg.startShield,
        materials: cfg.startMaterials,
        infiniteMaterials: cfg.infiniteMaterials,
      });

      // Stehende Übungs-Figuren (ohne KI)
      const spots = [
        { x: 3, y: 0, z: 13 },
        { x: -7, y: 0, z: 9 },
        { x: -19, y: cfg.platformHeight, z: -6 },
        { x: 29, y: 0, z: 6 },
      ];
      const skins = CONFIG.skins.list.filter((s) => s.id !== CONFIG.skins.defaultId);
      for (let i = 0; i < Math.min(cfg.idleBots, spots.length); i++) {
        const spot = spots[i];
        const dx = mode.spawnPoint.x - spot.x;
        const dz = mode.spawnPoint.z - spot.z;
        game.addCharacter({
          name: CONFIG.bots.names[i],
          isBot: true,
          brain: null, // keine KI: steht nur da
          team: 100 + i,
          skin: skins[i % skins.length].id,
          position: spot,
          yaw: Math.atan2(-dx, -dz), // schaut zum Startpunkt
          health: CONFIG.player.maxHealth,
          shield: CONFIG.player.maxShield,
        });
      }

      // Phase 5: alle Waffen + Schieß-Stand (Zielpuppen, Baum/Fels/Auto zum Sammeln)
      range = createPracticeRange(game, map);
      if (game.player) range.equip(game.player);
    },

    preUpdate(/* dt */) {},

    update(dt) {
      range?.update(dt);
      // Spieler nach kurzer Pause wieder auferstehen lassen
      const player = game.player;
      if (player && !player.alive && respawnAt >= 0 && game.time >= respawnAt) {
        respawnAt = -1;
        player.resetForRound({
          health: cfg.startHealth,
          shield: cfg.startShield,
          position: mode.spawnPoint,
          yaw: mode.spawnYaw,
        });
        game.cameraRig?.snap();
        game.events.emit('message', { text: 'Weiter geht’s!', kind: 'info', duration: 1.5 });
      }
    },

    onCharacterKilled(victim /* , killer */) {
      if (victim === game.player) respawnAt = game.time + cfg.respawnDelay;
    },

    hudInfo() {
      return { topCenter: cfg.name, alive: null, kills: null, zoneText: null, extra: [] };
    },

    dispose() {
      range?.dispose();
      range = null;
      map?.dispose();
      if (game.map === map) game.map = null;
      map = null;
    },
  };
  return mode;
}

/** Baut die Stationen des Übungsplatzes. */
function buildCourse(map, cfg, thickness) {
  const label = (text, x, y, z) => map.addLabel(text, { x, y, z });

  // --- Stufen: 0,3 m / 1 m / 2 m --------------------------------------------------
  cfg.stepHeights.forEach((height, i) => {
    const x0 = 4 + i * 6;
    map.addBox({ x: x0, y: 0, z: 0 }, { x: x0 + 4, y: height, z: 4 }, { color: COLORS.step[i % COLORS.step.length] });
    label(`${formatMeters(height)} hoch`, x0 + 2, height + 0.45, 4.3); // vorn, unter der Kamera-Höhe
  });

  // --- Hohe Wand (Kamera-Test) -----------------------------------------------------------
  map.addBox({ x: 24, y: 0, z: 1.85 }, { x: 34, y: cfg.highWall, z: 2.15 }, { color: COLORS.wall });
  label(`Wand ${formatMeters(cfg.highWall)}`, 29, cfg.highWall + 0.9, 2);

  // --- Rampe 45° auf die Plattform, weiter über Rampen auf den Turm ----------------------
  const h1 = cfg.platformHeight;
  const rampOptions = { color: COLORS.ramp };
  // Rampe A: Boden → Plattform (steigt Richtung −Z)
  map.addSlope({ minX: -24, maxX: -20, minZ: -4, maxZ: 0, baseY: 0, rise: h1, dir: 3, thickness }, rampOptions);
  map.addBox({ x: -28, y: 0, z: -12 }, { x: -16, y: h1, z: -4 }, { color: COLORS.platform });
  label('Rampe 45° → Plattform 4 m', -27, 1.2, 0.5); // neben der Rampe, nicht im Weg

  // Turm: zweite Stufe (8 m) und Gipfel (12 m), jeweils mit einer Rampe hinauf
  const top = cfg.towerHeight;
  const mid = (h1 + top) / 2;
  map.addSlope({ minX: -24, maxX: -20, minZ: -12, maxZ: -8, baseY: h1, rise: mid - h1, dir: 3, thickness }, { color: COLORS.towerRamp });
  map.addBox({ x: -24, y: 0, z: -20 }, { x: -20, y: mid, z: -12 }, { color: COLORS.tower });
  map.addSlope({ minX: -24, maxX: -20, minZ: -20, maxZ: -16, baseY: mid, rise: top - mid, dir: 3, thickness }, { color: COLORS.towerRamp });
  map.addBox({ x: -26, y: 0, z: -28 }, { x: -18, y: top, z: -20 }, { color: COLORS.tower });
  label(`Turm ${formatMeters(top)} – Fallschaden testen`, -18.6, top + 2.2, -27.4); // hinten am Rand

  // --- Niedrige Decke: nur geduckt hindurch ------------------------------------------------
  const ceil = cfg.lowCeiling;
  map.addBox({ x: 5.6, y: 0, z: -14 }, { x: 6, y: ceil + thickness, z: -6 }, { color: COLORS.tunnel });
  map.addBox({ x: 10, y: 0, z: -14 }, { x: 10.4, y: ceil + thickness, z: -6 }, { color: COLORS.tunnel });
  map.addBox({ x: 5.6, y: ceil, z: -14 }, { x: 10.4, y: ceil + thickness, z: -6 }, { color: COLORS.tunnel });
  label(`Decke ${formatMeters(ceil)} – ducken!`, 8, ceil + 0.9, -6);

  // --- Rampe zum Drunter-durch-Laufen ----------------------------------------------------
  const bridgeY = cfg.bridgeRampHeight;
  const bridge = map.addSlope({ minX: 16, maxX: 20, minZ: -14, maxZ: -10, baseY: bridgeY, rise: 4, dir: 3, thickness }, { color: COLORS.bridge });
  // dünne Stützen an den Ecken (bis unter die Platte)
  const post = 0.3;
  for (const [x, z] of [[16, -10], [20 - post, -10], [16, -14], [20 - post, -14]]) {
    const zz = z === -10 ? z - post : z;
    const underside = Math.min(
      bridge.a * x + bridge.b * zz + bridge.c, bridge.a * x + bridge.b * (zz + post) + bridge.c,
    ) - bridge.vThickness;
    map.addBox({ x, y: 0, z: zz }, { x: x + post, y: underside, z: zz + post }, { color: COLORS.post });
  }
  label('Unter der Rampe durch', 18, 6.4, -12); // über der Rampe (vom Start aus nicht hinter den Kisten-Schildern)

  // --- Kleines Dach (Pyramide) auf einem Sockel -------------------------------------------
  map.addBox({ x: 24, y: 0, z: -14 }, { x: 28, y: 0.3, z: -10 }, { color: COLORS.roofBase });
  map.addSlope({ minX: 24, maxX: 28, minZ: -14, maxZ: -10, baseY: 0.3, rise: CONFIG.building.roofHeight, dir: 'pyramid', thickness }, { color: COLORS.roof });
  label('Dach', 25.6, 3.4, -12); // über der Spitze, vom Start aus zwischen den Kisten-Schildern
}

// 0.3 → "0,3 m", 4 → "4 m"
function formatMeters(value) {
  return `${String(value).replace('.', ',')} m`;
}
