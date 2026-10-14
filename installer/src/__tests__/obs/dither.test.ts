import { describe, expect, it } from "vitest";
import { BAYER4, bayerLevel, bayerMask, maskCoverage } from "../../obs/dither";

describe("Bayer-Dither 4×4", () => {
  it("BAYER4 enthält 0…15 je einmal", () => {
    expect(BAYER4).toHaveLength(16);
    expect([...BAYER4].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it("Anteil von bayerMask(l) = l/16", () => {
    for (let l = 0; l <= 16; l++) expect(maskCoverage(bayerMask(l))).toBeCloseTo(l / 16, 12);
  });

  it("Muster sind verschachtelt (was einmal weg ist, bleibt weg)", () => {
    for (let l = 1; l <= 16; l++) {
      const a = bayerMask(l - 1);
      const b = bayerMask(l);
      for (let i = 0; i < 16; i++) expect(b[i]).toBeGreaterThanOrEqual(a[i]);
    }
  });

  it("Stufe zum Fortschritt", () => {
    expect(bayerLevel(0)).toBe(0);
    expect(bayerLevel(0.5)).toBe(8);
    expect(bayerLevel(1)).toBe(16);
    expect(bayerLevel(2)).toBe(16);
  });
});
