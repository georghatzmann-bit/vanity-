// Attrappe – wird in Welle 2b gebaut (Waffen, Zielen, Nachladen, Treffer).
// Sie hat schon alle Methoden aus ARCHITECTURE.md (Abschnitt 9), tut aber nichts.

/**
 * @param {object} game
 */
export function createWeaponSystem(game) {
  return {
    game,
    /** Pro Figur und Tick: schießen, nachladen, wechseln. */
    updateCharacter(/* character, command, dt */) {},
    /** Gibt einer Figur Waffen. Attrappe: nichts. */
    giveLoadout(/* character, ids, options */) {},
    /** Erzeugt einen Gegenstand. Attrappe: keiner. */
    createItem(/* id, rarity */) {
      return null;
    },
    frameUpdate(/* alpha */) {},
    dispose() {},
  };
}
