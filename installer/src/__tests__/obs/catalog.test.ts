import { describe, expect, it } from "vitest";
import { coordLine, logScaleX, nearestReference, REF_BOUNDARIES, REFERENCES } from "../../obs/catalog";

describe("Katalog (B.6)", () => {
  it("Perioden wörtlich", () => {
    expect(REFERENCES.b1919.periodS).toBe(1.3373);
    expect(REFERENCES.vela.periodS).toBe(0.08933);
    expect(REFERENCES.crab.periodS).toBe(0.0337);
    expect(REFERENCES.j0437.periodS).toBe(0.005757);
    expect(REFERENCES.j0437.freqHz).toBeCloseTo(173.7, 1);
  });

  it("Grenzen = geometrische Mittel 0,3456 / 0,05487 / 0,013929 s", () => {
    expect(REF_BOUNDARIES[0]).toBeCloseTo(0.3456, 4);
    expect(REF_BOUNDARIES[1]).toBeCloseTo(0.05487, 5);
    expect(REF_BOUNDARIES[2]).toBeCloseTo(0.013929, 6);
  });

  it("nächste Referenz im log-Abstand", () => {
    expect(nearestReference(1.3373)).toBe("b1919");
    expect(nearestReference(0.35)).toBe("b1919");
    expect(nearestReference(0.34)).toBe("vela");
    expect(nearestReference(0.056)).toBe("vela");
    expect(nearestReference(0.054)).toBe("crab");
    expect(nearestReference(0.0141)).toBe("crab");
    expect(nearestReference(0.0138)).toBe("j0437");
    expect(nearestReference(0.005757)).toBe("j0437");
  });

  it("Koordinatenzeilen wörtlich", () => {
    expect(coordLine("b1919")).toBe("PSR B1919+21 · RA 19h21m44.8s · DEC +21°53′02″ · J2000");
    expect(coordLine("vela")).toBe("PSR B0833−45 · RA 08h35m20.6s · DEC −45°10′35″ · J2000");
    expect(coordLine("crab")).toBe("PSR B0531+21 · RA 05h34m31.9s · DEC +22°00′52″ · J2000");
    expect(coordLine("j0437")).toBe("PSR J0437−4715 · RA 04h37m15.9s · DEC −47°15′09″ · J2000");
    // südliche Deklination mit U+2212, nie mit Bindestrich
    expect(coordLine("vela")).toContain("−");
    expect(coordLine("vela")).not.toMatch(/DEC -/);
  });

  it("Log-Skala des Schirms (C.2)", () => {
    expect(logScaleX(0.005757)).toBeCloseTo(94.7, 1);
    expect(logScaleX(0.0337)).toBeCloseTo(166.1, 1);
    expect(logScaleX(0.08933)).toBeCloseTo(205.4, 1);
    expect(logScaleX(1.3373)).toBeCloseTo(314.7, 1);
  });
});
