// =============================================================================
// Übungsplatz (Phase 2 – Start-Modus, bis es Menüs gibt)
// =============================================================================
// Eine Arena (20 x 20 Bau-Zellen) mit Stationen zum Ausprobieren:
//   - Kisten 0,3 m / 1 m / 2 m: die kleine steigt man einfach hoch, die anderen nicht
//   - hohe Wand (eine Wandhöhe): Kamera stößt an und geht nicht hindurch
//   - Rampe (wie eine gebaute) auf eine Plattform ein Stockwerk hoch – hochlaufen ohne Springen
//   - Turm (3 Stockwerke, über Rampen erreichbar): herunterfallen = Fallschaden
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
 * @param {object} [options]  { seed, skin }
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
    // Zeile unter der Steuerungs-Hilfe (main.js)
    helpHint: cfg.infiniteMaterials
      ? 'Übungsplatz: Bauen mit unendlich Material – Z/Y Wand, X Boden, C Rampe, V Dach, Linksklick setzt. ' +
        'G auf ein eigenes Teil = Edit (Felder klicken, G bestätigt), E öffnet Türen. ' +
        'Waffen: 1–4 (nochmal 4: Pistole, Granatwerfer), 5 Heilen. Zielpuppen hinten rechts, ' +
        'Baum/Fels/Auto für die Spitzhacke vorn links hinter dem Turm.'
      : 'Übungsplatz: Kisten, Rampen, Turm (Fallschaden), niedrige Decke.',

    start() {
      map = createArenaMap(game, { size: cfg.arenaSize, borderHeight: cfg.borderHeight });
      game.map = map;
      buildCourse(map, cfg, thickness);

      // Spieler
      game.addCharacter({
        name: game.settings?.game?.playerName ?? 'Spieler',
        isPlayer: true,
        team: 1,
        skin: options.skin ?? CONFIG.skins.defaultId, // Welle 5: Skin aus dem Spind
        pickaxe: options.pickaxe, // … und die Spitzhacke
        position: mode.spawnPoint,
        yaw: mode.spawnYaw,
        health: cfg.startHealth,
        shield: cfg.startShield,
        materials: cfg.startMaterials,
        infiniteMaterials: cfg.infiniteMaterials,
      });

      // Stehende Übungs-Figuren (ohne KI)
      const S = CONFIG.world.gridCellSize;
      const spots = [
        { x: 0.75 * S, y: 0, z: 3.25 * S },
        { x: -1.75 * S, y: 0, z: 2.25 * S },
        { x: -4.75 * S, y: cfg.platformHeight, z: -1.5 * S },
        { x: 7.25 * S, y: 0, z: 1.5 * S },
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

/**
 * Baut die Stationen des Übungsplatzes. Alle Lagen sind in Bau-Zellen angegeben
 * (S = CONFIG.world.gridCellSize, H = wallHeight) – so liegen Rampen, Plattform und
 * Turm genau auf dem Bau-Raster, egal wie groß eine Zelle ist.
 */
function buildCourse(map, cfg, thickness) {
  const S = CONFIG.world.gridCellSize;
  const H = CONFIG.world.wallHeight;
  const label = (text, x, y, z) => map.addLabel(text, { x, y, z });

  // --- Stufen: 0,3 m / 1 m / 2 m (je eine Zelle groß) -----------------------------------
  cfg.stepHeights.forEach((height, i) => {
    const x0 = (1 + i * 1.5) * S;
    map.addBox({ x: x0, y: 0, z: 0 }, { x: x0 + S, y: height, z: S }, { color: COLORS.step[i % COLORS.step.length] });
    label(`${formatMeters(height)} hoch`, x0 + S / 2, height + 0.45, S + 0.3); // vorn, unter der Kamera-Höhe
  });

  // --- Hohe Wand (Kamera-Test) -----------------------------------------------------------
  map.addBox({ x: 6 * S, y: 0, z: S / 2 - 0.15 }, { x: 8.5 * S, y: cfg.highWall, z: S / 2 + 0.15 }, { color: COLORS.wall });
  label(`Wand ${formatMeters(cfg.highWall)}`, 7.25 * S, cfg.highWall + 0.9, S / 2);

  // --- Rampe auf die Plattform, weiter über Rampen auf den Turm (je 1 Zelle, 1 Ebene) -------
  const h1 = cfg.platformHeight;
  const rampOptions = { color: COLORS.ramp };
  const slopeDeg = Math.round(CONFIG.building.rampSlopeDeg);
  // Rampe A: Boden → Plattform (steigt Richtung −Z)
  map.addSlope({ minX: -6 * S, maxX: -5 * S, minZ: -S, maxZ: 0, baseY: 0, rise: h1, dir: 3, thickness }, rampOptions);
  map.addBox({ x: -7 * S, y: 0, z: -3 * S }, { x: -4 * S, y: h1, z: -S }, { color: COLORS.platform });
  label(`Rampe ${slopeDeg}° → Plattform ${formatMeters(h1)}`, -6.75 * S, 1.2, 0.5); // neben der Rampe, nicht im Weg

  // Turm: zweite Stufe und Gipfel, jeweils mit einer Rampe hinauf
  const top = cfg.towerHeight;
  const mid = (h1 + top) / 2;
  map.addSlope({ minX: -6 * S, maxX: -5 * S, minZ: -3 * S, maxZ: -2 * S, baseY: h1, rise: mid - h1, dir: 3, thickness }, { color: COLORS.towerRamp });
  map.addBox({ x: -6 * S, y: 0, z: -5 * S }, { x: -5 * S, y: mid, z: -3 * S }, { color: COLORS.tower });
  map.addSlope({ minX: -6 * S, maxX: -5 * S, minZ: -5 * S, maxZ: -4 * S, baseY: mid, rise: top - mid, dir: 3, thickness }, { color: COLORS.towerRamp });
  map.addBox({ x: -6.5 * S, y: 0, z: -7 * S }, { x: -4.5 * S, y: top, z: -5 * S }, { color: COLORS.tower });
  label(`Turm ${formatMeters(top)} – Fallschaden testen`, -4.65 * S, top + 2.2, -6.85 * S); // hinten am Rand

  // --- Niedrige Decke: nur geduckt hindurch ------------------------------------------------
  const ceil = cfg.lowCeiling;
  const wall = 0.4;
  map.addBox({ x: 1.5 * S - wall, y: 0, z: -3.5 * S }, { x: 1.5 * S, y: ceil + thickness, z: -1.5 * S }, { color: COLORS.tunnel });
  map.addBox({ x: 2.5 * S, y: 0, z: -3.5 * S }, { x: 2.5 * S + wall, y: ceil + thickness, z: -1.5 * S }, { color: COLORS.tunnel });
  map.addBox({ x: 1.5 * S - wall, y: ceil, z: -3.5 * S }, { x: 2.5 * S + wall, y: ceil + thickness, z: -1.5 * S }, { color: COLORS.tunnel });
  label(`Decke ${formatMeters(ceil)} – ducken!`, 2 * S, ceil + 0.9, -1.5 * S);

  // --- Rampe zum Drunter-durch-Laufen ----------------------------------------------------
  const bridgeY = cfg.bridgeRampHeight;
  const bx0 = 4 * S;
  const bx1 = 5 * S;
  const bz0 = -3.5 * S;
  const bz1 = -2.5 * S;
  const bridge = map.addSlope({ minX: bx0, maxX: bx1, minZ: bz0, maxZ: bz1, baseY: bridgeY, rise: H, dir: 3, thickness }, { color: COLORS.bridge });
  // dünne Stützen an den Ecken (bis unter die Platte)
  const post = 0.3;
  for (const [x, z] of [[bx0, bz1], [bx1 - post, bz1], [bx0, bz0], [bx1 - post, bz0]]) {
    const zz = z === bz1 ? z - post : z;
    const underside = Math.min(
      bridge.a * x + bridge.b * zz + bridge.c, bridge.a * x + bridge.b * (zz + post) + bridge.c,
    ) - bridge.vThickness;
    map.addBox({ x, y: 0, z: zz }, { x: x + post, y: underside, z: zz + post }, { color: COLORS.post });
  }
  // neben der Rampe (nicht über dem Weg hinauf), höher als das Dach-Schild daneben
  label('Unter der Rampe durch', bx1 + 1.2, bridgeY + H - 0.4, (bz0 + bz1) / 2);

  // --- Kleines Dach (Pyramide) auf einem Sockel -------------------------------------------
  const roofBase = 0.3;
  map.addBox({ x: 6 * S, y: 0, z: -3.5 * S }, { x: 7 * S, y: roofBase, z: -2.5 * S }, { color: COLORS.roofBase });
  map.addSlope({ minX: 6 * S, maxX: 7 * S, minZ: -3.5 * S, maxZ: -2.5 * S, baseY: roofBase, rise: CONFIG.building.roofHeight, dir: 'pyramid', thickness }, { color: COLORS.roof });
  label('Dach', 6.4 * S, roofBase + CONFIG.building.roofHeight + 1.6, -3 * S); // über der Spitze, vom Start aus zwischen den Kisten-Schildern
}

// 0.3 → "0,3 m", 3.84 → "3,84 m", 11.52 → "11,52 m"
function formatMeters(value) {
  return `${String(Math.round(value * 100) / 100).replace('.', ',')} m`;
}
