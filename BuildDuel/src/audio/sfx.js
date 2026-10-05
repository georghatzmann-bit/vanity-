// Attrappe – wird in Welle 3a gebaut (alle Töne per Web Audio API erzeugt).
// Das echte System hört auf Ereignisse (game.events) und spielt Töne.

/**
 * @param {object} game
 */
export function createAudio(game) {
  return {
    game,
    setVolumes(/* settings */) {},
    frameUpdate() {},
    dispose() {},
  };
}
