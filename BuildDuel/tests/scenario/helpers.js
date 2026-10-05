// Hilfen für Szenario-Tests: ein Spiel ohne Bildschirm mit einer Test-Figur,
// die einen festen Befehl bekommt (wie ein ganz einfacher Bot).
import { Game } from '../../src/core/game.js';

/** Spiel ohne Bildschirm. */
export function createTestGame(options = {}) {
  return new Game({ headless: true, seed: 1, ...options });
}

/**
 * Test-Figur mit "Gehirn", das jeden Tick den Befehl aus fields liefert.
 * fields kann jederzeit geändert werden (drive.fields.moveZ = 0 …).
 */
export function addDrivenCharacter(game, options = {}) {
  const character = game.addCharacter({
    name: 'Test',
    shield: 0,
    position: { x: 0, y: 0, z: 0 },
    ...options,
    brain: null,
  });
  const fields = { yaw: options.yaw ?? 0, pitch: 0 };
  character.brain = {
    fields,
    think() {
      const cmd = character.command;
      cmd.moveX = 0;
      cmd.moveZ = 0;
      cmd.jump = false;
      cmd.jumpPressed = false;
      cmd.crouch = false;
      cmd.sprint = false;
      cmd.secondary = false;
      Object.assign(cmd, fields);
      fields.jumpPressed = false; // nur einmal
      return cmd;
    },
  };
  return character;
}

/** Sammelt Ereignisse eines Namens. */
export function collect(game, name) {
  const list = [];
  game.events.on(name, (payload) => list.push(payload));
  return list;
}

/** Simuliert und merkt sich die größte Höhe. */
export function maxHeightDuring(game, character, seconds) {
  let max = character.position.y;
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    game.fixedUpdate(1 / 60);
    if (character.position.y > max) max = character.position.y;
  }
  return max;
}
