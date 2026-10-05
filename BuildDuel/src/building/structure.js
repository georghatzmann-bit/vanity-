// Attrappe – wird in Welle 2a gebaut (Bau-System: Raster, Vorschau, Bauteile, Edit, Einsturz).
// Sie hat schon alle Methoden aus ARCHITECTURE.md (Abschnitt 9), tut aber nichts.
// So läuft das Spiel auch ohne Bau-System.

/**
 * @param {object} game
 */
export function createBuildingSystem(game) {
  return {
    game,
    pieces: new Map(), // slotKey → Bauteil
    /** Pro Figur und Tick: Vorschau, Setzen, Edit. */
    updateCharacter(/* character, command, dt */) {},
    /** Pro Tick: Aufbau-Zeit, Einsturz. */
    update(/* dt */) {},
    /** Bauteil setzen. Attrappe: setzt nichts. */
    placePiece(/* type, slotKey, owner, material, options */) {
      return null;
    },
    removePiece(/* piece */) {},
    clearAll() {},
    countFor(/* owner */) {
      return 0;
    },
    getPieceAt(/* slotKey */) {
      return null;
    },
    /** Darf die Figur gerade editieren (anvisiertes EIGENES Bauteil)? Attrappe: nein. */
    canEdit(/* character */) {
      return false;
    },
    /** Edit-Modus schließen (z. B. weil eine Waffe gewählt wurde). */
    closeEdit(/* character */) {},
    frameUpdate(/* alpha */) {},
    dispose() {},
  };
}
