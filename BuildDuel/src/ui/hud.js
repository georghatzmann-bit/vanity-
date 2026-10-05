// Attrappe – wird in Welle 3a gebaut (Leben/Schild, Waffen-Leiste, Bau-Leiste, Kill-Feed …).

/**
 * @param {object} game
 * @param {HTMLElement|null} root  Ebene über dem 3D-Bild (#ui)
 */
export function createHud(game, root) {
  return {
    game,
    root,
    frameUpdate(/* dt */) {},
    dispose() {},
  };
}
