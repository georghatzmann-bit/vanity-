// Attrappe – wird in Welle 3b gebaut (Kisten, Boden-Loot, Aufheben, Fallenlassen).

/**
 * @param {object} game
 * @param {object} spec
 */
export function createLootSystem(game, spec = {}) {
  return {
    game,
    spec,
    chests: [],
    update(/* dt */) {},
    dropAll(/* character */) {},
    spawnFloorItem(/* ... */) {
      return null;
    },
    dispose() {},
  };
}
