import { describe, expect, it } from "vitest";
import {
  angleToSight, basis, beamQuad, blurWeight, capEllipse, dipolePoints, exposureAlpha, exposureTurns, FIELD_CHI_DEG, FIELD_L, flashAllowed, LOGO_PHASE, magneticAxis, MARK_PARAMS, markMorph, projectedAngle, psiForPhase, pulseDisc, sampleCount, STAR_PARAMS, strobeWindow, type Vec3,
} from "../../obs/star";

const deg = Math.PI / 180;
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

describe("Neutronenstern: Geometrie (F.3)", () => {
  it("Basis nach R_z(−35°) wie nachgerechnet", () => {
    const b = basis();
    const close = (v: Vec3, w: number[]) => v.forEach((x, i) => expect(x).toBeCloseTo(w[i], 4));
    close(b.omega, [0.43939, 0.62751, 0.64279]);
    close(b.e1, [-0.81915, 0.57358, 0]);
    close(b.e2, [-0.36869, -0.52654, 0.76604]);
  });

  it("psiForPhase: φ 0 → 90°, φ 0,5 → 270°", () => {
    expect(psiForPhase(0) / deg).toBeCloseTo(90, 9);
    expect(psiForPhase(0.5) / deg).toBeCloseTo(270, 9);
    expect(LOGO_PHASE).toBe(0.5);
  });

  it("Puls: m(ψ = 90°) liegt 5,0° von der Sichtlinie", () => {
    expect(Math.abs(angleToSight(magneticAxis(90 * deg)) - 5)).toBeLessThan(0.05);
  });

  it("Gegenstrahl kommt der Sichtlinie nie näher als 84,9°", () => {
    for (let i = 0; i < 720; i++) {
      const m = magneticAxis((i / 720) * 2 * Math.PI);
      expect(angleToSight([-m[0], -m[1], -m[2]])).toBeGreaterThanOrEqual(84.9);
    }
  });

  it("Logo-Phase: m(270°) projiziert 35,0°, z = −0,087", () => {
    const m = magneticAxis(270 * deg);
    expect(Math.abs(projectedAngle(m) - 35)).toBeLessThan(0.1);
    expect(Math.abs(m[2] - -0.087)).toBeLessThan(0.002);
    expect(len(m)).toBeCloseTo(1, 12);
  });

  it("Dipol-Feldlinie r = L·sin²θ, Endpunkte auf der Oberfläche", () => {
    const m = magneticAxis(psiForPhase(0.2));
    for (const L of FIELD_L)
      for (const chi of FIELD_CHI_DEG) {
        const pts = dipolePoints(L, chi, m, 40);
        expect(pts).toHaveLength(40);
        expect(pts[0].r).toBeCloseTo(1, 9);
        expect(pts[39].r).toBeCloseTo(1, 9);
        // Scheitel (θ = 90°) liegt bei r ≈ L
        expect(Math.max(...pts.map((p) => p.r))).toBeGreaterThan(L * 0.99);
        for (const p of pts) expect(p.r).toBeLessThanOrEqual(L + 1e-9);
      }
  });

  it("Strahl: Viereck von R★ bis 2,5 R★, Endellipse ≤ 46 px Durchmesser", () => {
    const q = beamQuad(magneticAxis(90 * deg));
    expect(q.quad).toHaveLength(4);
    expect(2 * q.end.rx).toBeLessThanOrEqual(46);
    expect(2 * q.end.rx).toBeGreaterThan(45);
  });

  it("Polkappen: Deckkraft 0,7·max(0, ±m_z)", () => {
    const m = magneticAxis(90 * deg);
    expect(capEllipse(m, 1).alpha).toBeCloseTo(0.7 * m[2], 9);
    expect(capEllipse(m, -1).alpha).toBe(0);
    expect(capEllipse(m, -1).visible).toBe(false);
  });
});

describe("Neutronenstern: Kamera, Blitzschutz, Wandlung", () => {
  it("Belichtete Umdrehungen n(f)", () => {
    expect(exposureTurns(0.748)).toBeCloseTo(0.0125, 3);
    expect(exposureTurns(2.5)).toBe(2);
    expect(exposureTurns(11.19)).toBe(2);
    expect(exposureTurns(1.0)).toBeCloseTo(0.026, 3);
    expect(exposureTurns(1.37)).toBeCloseTo(0.159, 3);
    expect(exposureTurns(2.0)).toBeCloseTo(1.26, 2);
  });

  it("Samples: Abstand ≤ 6°, gedeckelt je Qualitätsstufe", () => {
    expect(sampleCount(2, 2)).toBe(60);
    expect(sampleCount(2, 1)).toBe(30);
    expect(sampleCount(2, 0)).toBe(12);
    expect(sampleCount(0.25, 2)).toBe(15);
  });

  it("A(n): 0,16 → 0,10 unter n = 1, dann bis 0,20 bei f★", () => {
    expect(exposureAlpha(0, 0.748)).toBeCloseTo(0.16, 9);
    expect(exposureAlpha(1, 2.5)).toBeCloseTo(0.1, 9);
    expect(exposureAlpha(2, 173.7)).toBeCloseTo(0.2, 9);
    expect(blurWeight(0)).toBe(1);
    expect(blurWeight(2)).toBeCloseTo(0.2, 9);
  });

  it("flashAllowed: 2,5 Hz ja, 2,6 Hz nein (≤ 3 Blitze pro Sekunde)", () => {
    expect(flashAllowed(2.5)).toBe(true);
    expect(flashAllowed(2.6)).toBe(false);
    expect(pulseDisc(magneticAxis(90 * deg), 173.7).alpha).toBe(0.18);
    expect(pulseDisc(magneticAxis(90 * deg), 0.748).alpha).toBeCloseTo(0.45 * Math.exp(-((5 / 6) ** 2)), 6);
  });

  it("Stroboskop: Fenster um ⌊φ⌋ + 0,5, Breite 2 → 0 in 800 ms", () => {
    const a = strobeWindow(17.3, 0);
    expect(a.center).toBe(17.5);
    expect(a.width).toBeCloseTo(2, 9);
    expect(strobeWindow(17.3, 800).width).toBeCloseTo(0, 9);
    expect(strobeWindow(17.3, 400).width).toBeLessThan(1);
  });

  it("markMorph(0) = Stern, markMorph(1) = Zeichen", () => {
    expect(markMorph(0)).toEqual(STAR_PARAMS);
    const end = markMorph(1);
    for (const k of Object.keys(MARK_PARAMS) as (keyof typeof MARK_PARAMS)[]) expect(end[k]).toBeCloseTo(MARK_PARAMS[k], 9);
    expect(STAR_PARAMS.ringR).toBe(58);
    expect(MARK_PARAMS.ringR).toBeCloseTo(72.2, 1);
    expect(MARK_PARAMS.ringWidth).toBeCloseTo(3.4, 1);
    expect(MARK_PARAMS.coreR).toBeCloseTo(18.9, 1);
  });
});
