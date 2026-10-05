// Attrappe – wird in Welle 4a gebaut (Bot-KI: suchen, kämpfen, bauen, heilen …).
// Bis dahin steht ein Bot einfach still und schaut geradeaus.
import { createCommand, resetCommand } from '../player.js';

/**
 * @param {Character} character
 * @param {object} game
 * @param {string} difficulty  'easy' | 'medium' | 'hard'
 */
export function createBotBrain(character, game, difficulty = 'medium') {
  const command = createCommand();
  return {
    character,
    difficulty,
    /** Liefert den Befehl für diesen Tick (Attrappe: nichts tun). */
    think(/* dt */) {
      return resetCommand(command, character.yaw, character.pitch);
    },
  };
}
