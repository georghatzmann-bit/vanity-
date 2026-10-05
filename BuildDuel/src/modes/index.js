// =============================================================================
// Liste aller Spielmodi
// =============================================================================
// Jeder Eintrag: { id, name, description, create(game, options) → Modus }
// Die Form eines Modus steht in ARCHITECTURE.md (Abschnitt 10).
// Neue Modi (Duell, Battle Royale …) kommen in Welle 4b hier dazu.
// =============================================================================
import { CONFIG } from '../config.js';
import { createPracticeMode } from './practice.js';

export const MODES = [
  {
    id: 'practice',
    name: CONFIG.modes.practice.name,
    description: 'Laufen, Springen, Ducken und die Kamera ausprobieren.',
    create: createPracticeMode,
  },
];

/** Modus, mit dem das Spiel startet (bis es ein Hauptmenü gibt). */
export const DEFAULT_MODE_ID = 'practice';

/** Sucht einen Modus nach id. Unbekannt → null. */
export function getModeDef(id) {
  return MODES.find((m) => m.id === id) ?? null;
}
