// =============================================================================
// Liste aller Spielmodi
// =============================================================================
// Jeder Eintrag: { id, name, description, create(game, options) → Modus }
// Die Form eines Modus steht in ARCHITECTURE.md (Abschnitt 10).
// Neue Modi (Duell, Battle Royale …) kommen in Welle 4b hier dazu.
// =============================================================================
import { CONFIG } from '../config.js';
import { createPracticeMode } from './practice.js';
import { createCreativeMode } from './creative.js';
import { createIslandSandbox, createArenaSandbox, createZoneWarsSandbox } from './sandbox.js';

export const MODES = [
  // Welle 5: Kreativ – der Standard-Modus in der Lobby
  {
    id: 'creative',
    name: CONFIG.modes.creative.name,
    description: 'Unendlich Material, alle Waffen.',
    create: createCreativeMode,
  },
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

/** Modus, wenn ?mode=… unbekannt ist (Schnellstart ohne Lobby). */
export const DEFAULT_MODE_ID = 'practice';

/** Vorauswahl in der Lobby (Welle 5). */
export const LOBBY_DEFAULT_MODE_ID = CONFIG.lobby.defaultMode;

/**
 * Kacheln für die Lobby in fester Reihenfolge (CONFIG.lobby.modeOrder): Modi, die es gibt,
 * sind wählbar; die anderen stehen grau mit "bald" da. Test-Modi (hidden) erscheinen nie.
 * @returns {{ id, name, description, available }[]}
 */
export function lobbyModes() {
  return CONFIG.lobby.modeOrder.map((id) => {
    const def = getModeDef(id);
    if (def && !def.hidden) return { id, name: def.name, description: def.description, available: true };
    return { id, name: CONFIG.modes[id]?.name ?? id, description: 'Kommt bald.', available: false };
  });
}

/** Sucht einen Modus nach id. Unbekannt → null. */
export function getModeDef(id) {
  return MODES.find((m) => m.id === id) ?? null;
}
