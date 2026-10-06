// Hilfen für Bau-Szenario-Tests: eine Figur, die NUR über CharacterCommands
// gesteuert wird (wie ein Bot). Ihr "Gehirn" schreibt jeden Tick die Felder aus
// "fields" in den Befehl und setzt den Ziel-Strahl auf Augen + Blickrichtung.
// Einmal-Felder (…Pressed, selectBuild …) gelten nur für einen Tick.
import { CONFIG } from '../../src/config.js';

const ONCE = ['jumpPressed', 'primaryPressed', 'primaryReleased', 'secondaryPressed', 'secondaryReleased', 'selectBuild',
  'selectSlot', 'selectPickaxe', 'editPressed', 'editReleased', 'usePressed', 'reloadOrRotate', 'switchMaterial',
  'toggleBuild', 'nextItem', 'prevItem', 'emotePressed'];
const HELD = ['moveX', 'moveZ', 'jump', 'crouch', 'sprint', 'primary', 'secondary', 'edit'];

/**
 * Gibt einer Figur (z. B. game.player im Übungsplatz) ein Befehls-Gehirn.
 * @returns {object} fields – frei änderbar (yaw, pitch, moveZ, primary, …)
 */
export function driveByCommands(character, yaw = character.yaw, pitch = 0) {
  const fields = { yaw, pitch };
  character.brain = {
    fields,
    think() {
      const cmd = character.command;
      for (const key of HELD) cmd[key] = typeof cmd[key] === 'number' ? 0 : false;
      for (const key of ONCE) cmd[key] = key === 'selectBuild' ? null : key === 'selectSlot' ? 0 : false;
      for (const [key, value] of Object.entries(fields)) cmd[key] = value;
      // Ziel-Strahl: von den Augen in Blickrichtung (wie bei einem Bot)
      character.eyePosition(cmd.aimOrigin);
      const cp = Math.cos(cmd.pitch);
      cmd.aimDir.set(-Math.sin(cmd.yaw) * cp, Math.sin(cmd.pitch), -Math.cos(cmd.yaw) * cp);
      for (const key of ONCE) delete fields[key];
      return cmd;
    },
  };
  return fields;
}

const STEP = 1 / CONFIG.loop.tickRate;

/** Einen Tick mit Einmal-Feldern (z. B. { selectBuild: 'wall' }). */
export function tap(game, fields, once = {}) {
  Object.assign(fields, once);
  game.fixedUpdate(STEP);
}

/** Bauteil wählen und mit einem Klick setzen. Liefert das neue Bauteil oder null. */
export function buildOnce(game, character, fields, type) {
  const before = game.building.pieces.size;
  let placed = null;
  const off = game.events.on('piecePlaced', (e) => {
    if (e.owner === character) placed = e.piece;
  });
  tap(game, fields, { selectBuild: type });
  fields.primary = true;
  tap(game, fields, { primaryPressed: true });
  fields.primary = false;
  tap(game, fields, { primaryReleased: true });
  off();
  return game.building.pieces.size > before ? placed : null;
}

/** Blick (yaw, pitch) von den Augen der Figur auf einen Punkt. */
export function lookAt(character, fields, point) {
  const eye = character.eyePosition({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  fields.yaw = Math.atan2(-dx, -dz);
  fields.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

/** Simuliert so viele Ticks, bis cond() wahr ist (oder maxSeconds um sind). */
export function runUntil(game, cond, maxSeconds = 5) {
  const steps = Math.round(maxSeconds / STEP);
  for (let i = 0; i < steps; i++) {
    if (cond()) return true;
    game.fixedUpdate(STEP);
  }
  return cond();
}
