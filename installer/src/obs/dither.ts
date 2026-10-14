/**
 * Bayer-Dither 4×4 (Spec F.3 „Zerfall“), rein: Die Stern-Ebene löst sich in 16 Stufen ins Rauschen.
 * Stufe l (0…16) = Anteil l/16 der Pixel ist „weg“ (Maske 1).
 */

/** Klassische Bayer-Matrix 4×4, Werte 0…15 je einmal (zeilenweise) */
export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Maske der Stufe l als 16 Werte (zeilenweise, 4×4): 1 = Pixel entfernt, 0 = bleibt.
 * Eine Zelle fällt, sobald ihr Bayer-Wert < l ist; so sind die Muster verschachtelt.
 */
export function bayerMask(level: number): Uint8Array {
  const l = Math.max(0, Math.min(16, Math.round(level)));
  const m = new Uint8Array(16);
  for (let i = 0; i < 16; i++) m[i] = BAYER4[i] < l ? 1 : 0;
  return m;
}

/** Stufe zum Fortschritt u ∈ [0, 1] (0 = Stern ganz, 1 = ganz Rauschen) */
export function bayerLevel(u: number): number {
  return Math.max(0, Math.min(16, Math.floor((Number.isFinite(u) ? u : 0) * 16 + 1e-9)));
}

/** Anteil der entfernten Pixel einer Maske */
export function maskCoverage(mask: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i] ? 1 : 0;
  return mask.length ? s / mask.length : 0;
}
