// Attrappe – wird in Welle 3b gebaut (Sturm-Zone: Phasen, Schrumpfen, Schaden).
// Die Attrappe ist "unendlich groß": Niemand ist draußen, niemand nimmt Schaden.
import * as THREE from 'three';

/**
 * @param {object} game
 * @param {object} spec  Werte aus config.js (z. B. CONFIG.modes.battleRoyale.storm)
 */
export function createStorm(game, spec = {}) {
  return {
    game,
    spec,
    center: new THREE.Vector3(),
    radius: Infinity,
    nextCenter: new THREE.Vector3(),
    nextRadius: Infinity,
    phase: 0,
    state: 'wait', // 'wait' | 'shrink'
    timeLeft: 0,
    damagePerSecond: 0,
    update(/* dt */) {},
    isInside(/* position */) {
      return true;
    },
    dispose() {},
  };
}
