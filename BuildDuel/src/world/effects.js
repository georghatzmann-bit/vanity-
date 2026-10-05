// Attrappe – wird in Welle 3a gebaut (Mündungsblitz, Splitter, Treffer-Zahlen …).
// Das echte System hört auf Ereignisse (game.events) und malt Effekte.

/**
 * @param {object} game
 */
export function createEffects(game) {
  return {
    game,
    frameUpdate(/* dt */) {},
    dispose() {},
  };
}
