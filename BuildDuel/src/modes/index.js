// =============================================================================
// Liste aller Spielmodi
// =============================================================================
// Jeder Eintrag: { id, name, description, create(game, options) → Modus }
// Die Form eines Modus steht in ARCHITECTURE.md (Abschnitt 10).
// Neue Modi (Duell, Battle Royale …) kommen in Welle 4b hier dazu.
// =============================================================================
import { CONFIG } from '../config.js';
import { createPracticeMode } from './practice.js';
import { createIslandSandbox, createArenaSandbox, createZoneWarsSandbox } from './sandbox.js';

export const MODES = [
  {
    id: 'practice',
    name: CONFIG.modes.practice.name,
    description: 'Laufen, Springen, Ducken und die Kamera ausprobieren.',
    create: createPracticeMode,
  },
  // Welle 3b: Test-Modi für die Welt (nur für Entwickler, nicht im Menü: hidden)
  { id: 'sandbox-island', name: 'Test: Insel', description: 'Insel, Sturm, Loot, Absprung (Entwickler-Test).', hidden: true, create: createIslandSandbox },
  { id: 'sandbox-arena', name: 'Test: Duell-Arena', description: 'Arena mit Felsen und Bäumen (Entwickler-Test).', hidden: true, create: createArenaSandbox },
  { id: 'sandbox-zonewars', name: 'Test: Zone Wars', description: 'Hügel-Karte mit wandernder Zone (Entwickler-Test).', hidden: true, create: createZoneWarsSandbox },
];

/** Modus, mit dem das Spiel startet (bis es ein Hauptmenü gibt). */
export const DEFAULT_MODE_ID = 'practice';

/** Sucht einen Modus nach id. Unbekannt → null. */
export function getModeDef(id) {
  return MODES.find((m) => m.id === id) ?? null;
}
