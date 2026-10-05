// =============================================================================
// Zufall mit "Startwert" (Seed)
// =============================================================================
// Math.random() liefert jedes Mal andere Zahlen. Für Dinge wie das Gras-Muster
// oder später Bäume auf der Karte wollen wir aber bei jedem Start DAS GLEICHE
// Ergebnis. Dafür gibt es diesen kleinen Zufalls-Generator (Mulberry32):
// gleicher Startwert → gleiche Zahlenfolge.
// =============================================================================

/**
 * @param {number} seed  Startwert (ganze Zahl)
 * @returns {() => number} Funktion, die bei jedem Aufruf eine Zahl von 0 bis unter 1 liefert
 */
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zufallszahl zwischen min und max (mit dem gegebenen Generator). */
export function randomRange(rng, min, max) {
  return min + (max - min) * rng();
}
