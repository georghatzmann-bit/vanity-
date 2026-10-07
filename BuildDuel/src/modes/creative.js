// =============================================================================
// Kreativ-Modus (wie "JustBuild"/Kreativ im Original): frei bauen und üben
// =============================================================================
// - große flache Wiese (CONFIG.modes.creative.arenaSize, z. B. 200 x 200 m)
// - unendlich Material, alle Waffen und Heil-Items (Munition geht nie aus)
// - Zielpuppen an der Seite und Baum/Fels/Auto für die Spitzhacke (weapons/practiceRange.js)
// - Anzeige "Bauteile/s" (Bauteile in der letzten Sekunde) und "Bauteile" (gesamt)
// - Taste P (Aktion clearBuilds) oder Knopf im Pause-Menü: alle Bauteile löschen
// - wer stirbt oder aus der Welt fällt, ist kurz danach wieder am Startpunkt
// Läuft auch ohne Bildschirm (Tests).
// =============================================================================
import { CONFIG } from '../config.js';
import { createArenaMap } from '../world/mapArena.js';
import { createPracticeRange } from '../weapons/practiceRange.js';

/**
 * @param {object} game
 * @param {object} [options]  { seed, skin }
 */
export function createCreativeMode(game, options = {}) {
  const cfg = CONFIG.modes.creative;
  let map = null;
  let range = null;
  let respawnAt = -1;
  let offPlaced = null;
  // Zeitpunkte (Spielzeit) der zuletzt gesetzten Bauteile – fester Ring-Speicher, nichts wird neu angelegt
  const RING = 64;
  const placedTimes = new Float64Array(RING).fill(-Infinity);
  let ringIndex = 0;

  const stats = {
    total: 0, // vom Spieler gesetzte Bauteile seit dem Start
    perSecond: 0, // Bauteile in der letzten Sekunde
    best: 0, // Rekord "Bauteile/s"
    cleared: 0, // wie oft "Alles löschen" benutzt wurde
  };

  const mode = {
    id: 'creative',
    name: cfg.name,
    options,
    isOver: false,
    result: null,
    stats,
    spawnPoint: { x: cfg.spawn.x, y: 0, z: cfg.spawn.z },
    spawnYaw: 0,
    helpHint: 'Kreativ: unendlich Material – Z/Y Wand, X Boden, C Rampe, V Dach, Linksklick setzt (halten = mehrere). ' +
      'G = Edit, P = alle Bauteile löschen. Waffen 1–5 (Munition unendlich), Zielpuppen rechts hinten.',

    start() {
      map = createArenaMap(game, { size: cfg.arenaSize, borderHeight: cfg.borderHeight });
      game.map = map;
      game.addCharacter({
        name: game.settings?.game?.playerName ?? 'Spieler',
        isPlayer: true,
        team: 1,
        skin: options.skin ?? CONFIG.skins.defaultId,
        position: mode.spawnPoint,
        yaw: mode.spawnYaw,
        health: cfg.startHealth,
        shield: cfg.startShield,
        infiniteMaterials: cfg.infiniteMaterials,
      });
      // Alle Waffen + Heil-Items, Zielpuppen, Sammel-Objekte
      range = createPracticeRange(game, map);
      if (game.player) range.equip(game.player);
      offPlaced = game.events.on('piecePlaced', (e) => {
        if (!game.player || e.owner !== game.player) return;
        stats.total++;
        placedTimes[ringIndex] = game.time;
        ringIndex = (ringIndex + 1) % RING;
      });
    },

    /** Alle Bauteile weg (Taste P oder Knopf im Pause-Menü). */
    clearAll() {
      game.building.clearAll();
      stats.cleared++;
      game.events.emit('message', { text: 'Alle Bauteile gelöscht', kind: 'info', duration: 1.2 });
    },

    preUpdate(/* dt */) {
      if (game.lastSample?.pressed?.clearBuilds) mode.clearAll();
    },

    update(dt) {
      range?.update(dt);
      // Bauteile in der letzten Sekunde zählen
      const since = game.time - cfg.piecesPerSecondWindow;
      let count = 0;
      for (let i = 0; i < RING; i++) if (placedTimes[i] > since) count++;
      stats.perSecond = count / cfg.piecesPerSecondWindow;
      if (stats.perSecond > stats.best) stats.best = stats.perSecond;

      const player = game.player;
      if (!player) return;
      // Aus der Welt gefallen → zurück zum Start
      if (player.alive && player.position.y < cfg.fallRespawnY) respawn();
      // Besiegt (z. B. Fallschaden) → nach kurzer Pause wieder da
      if (!player.alive && respawnAt >= 0 && game.time >= respawnAt) {
        respawnAt = -1;
        respawn();
      }
    },

    onCharacterKilled(victim /* , killer */) {
      if (victim === game.player) respawnAt = game.time + cfg.respawnDelay;
    },

    hudInfo() {
      return {
        topCenter: cfg.name,
        alive: null,
        kills: null,
        zoneText: null,
        extra: [`Bauteile/s: ${formatRate(stats.perSecond)}  (Rekord ${formatRate(stats.best)})`, `Bauteile: ${stats.total}`],
      };
    },

    dispose() {
      offPlaced?.();
      offPlaced = null;
      range?.dispose();
      range = null;
      map?.dispose();
      if (game.map === map) game.map = null;
      map = null;
    },
  };

  function respawn() {
    game.player.resetForRound({
      health: cfg.startHealth,
      shield: cfg.startShield,
      position: mode.spawnPoint,
      yaw: mode.spawnYaw,
    });
    game.cameraRig?.snap();
    game.events.emit('message', { text: 'Weiter geht’s!', kind: 'info', duration: 1.5 });
  }

  return mode;
}

// 2 → "2", 2.5 → "2,5"
function formatRate(value) {
  return String(Math.round(value * 10) / 10).replace('.', ',');
}
