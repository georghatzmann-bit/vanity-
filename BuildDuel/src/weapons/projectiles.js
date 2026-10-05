// Attrappe – wird in Welle 2b gebaut (Geschosse mit Flugzeit: Scharfschützengewehr, Granaten).

/**
 * @param {object} game
 */
export function createProjectileSystem(game) {
  return {
    game,
    spawn(/* spec */) {
      return null;
    },
    update(/* dt */) {},
    clear() {},
    dispose() {},
  };
}
