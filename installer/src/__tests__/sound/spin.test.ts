import { describe, expect, it } from "vitest";
import { KnotTrack, SpinModel, knotsFromFrequency, spinUpTrack } from "@shared/sound/spin";

describe("SpinModel (F.2)", () => {
  it("konstantes f: Phase linear (±1e-9)", () => {
    const m = new SpinModel({ t0: 10, f0: 2.5, phi0: 0.25 });
    m.advance(14);
    for (let t = 10; t < 14; t += 0.0137) expect(Math.abs(m.phaseAt(t) - (0.25 + 2.5 * (t - 10)))).toBeLessThan(1e-9);
    expect(m.freqAt(12.345)).toBeCloseTo(2.5, 12);
  });

  it("lineare Rampe: Trapez-Integral exakt", () => {
    const knots = knotsFromFrequency((t) => 10 + 20 * t, 0, 1, 0.02);
    const tr = new KnotTrack(knots);
    for (let t = 0; t <= 1; t += 0.0071) {
      expect(Math.abs(tr.phaseAt(t) - (10 * t + 10 * t * t))).toBeLessThan(1e-9);
      expect(Math.abs(tr.freqAt(t) - (10 + 20 * t))).toBeLessThan(1e-9);
    }
  });

  it("B1919: f₀ 0,74778 mit φ₀ 0,5 → Pulse bei 0,66865 und 2,00595 in [0; 2,7)", () => {
    const m = new SpinModel({ t0: 0, f0: 0.74778, phi0: 0.5 });
    const p = m.pulsesBetween(0, 2.7);
    expect(p.length).toBe(2);
    expect(Math.abs(p[0].t - 0.66865)).toBeLessThan(1e-4);
    expect(Math.abs(p[1].t - 2.00595)).toBeLessThan(1e-4);
    expect(p[0].index).toBe(1);
    expect(p[1].index).toBe(2);
  });

  it("Pulse liegen bei ganzzahliger Phase (< 1e-9), auch beim Hochdrehen", () => {
    const m = new SpinModel({ t0: 0, f0: 0.748 });
    m.setTarget({ f: 173.7, tauS: 0.6, maxOctPerS: 2 });
    const ps = m.pulsesBetween(0, 6);
    expect(ps.length).toBeGreaterThan(50);
    for (const p of ps) {
      expect(Math.abs(m.phaseAt(p.t) - p.index)).toBeLessThan(1e-9);
      expect(Number.isInteger(p.index)).toBe(true);
    }
    // keine Doppel- oder Fehlpulse
    for (let i = 1; i < ps.length; i++) expect(ps[i].index).toBe(ps[i - 1].index + 1);
  });

  it("Rate: Ziel 173,7 ab 0,748 mit maxOct 2 → nach 1 s f ≤ 2,992", () => {
    const m = new SpinModel({ t0: 0, f0: 0.748 });
    m.setTarget({ f: 173.7, maxOctPerS: 2 });
    m.advance(1);
    expect(m.freqAt(1)).toBeLessThanOrEqual(2.992 + 1e-9);
    expect(m.freqAt(1)).toBeGreaterThan(2.9);
  });

  it("kein Überschwingen (hoch und runter)", () => {
    const up = new SpinModel({ t0: 0, f0: 1 });
    up.setTarget({ f: 30, tauS: 0.15, maxOctPerS: 3 });
    up.advance(10);
    for (const k of up.knotsSince(-1)) expect(k.f).toBeLessThanOrEqual(30 + 1e-9);
    expect(up.freqAt(10)).toBeCloseTo(30, 6);
    const down = new SpinModel({ t0: 0, f0: 173.7 });
    down.setTarget({ f: 0.02, tauS: 1.2, maxOctPerS: 3 });
    down.advance(20);
    for (const k of down.knotsSince(-1)) expect(k.f).toBeGreaterThanOrEqual(0.02 - 1e-12);
  });

  it("prune erhält die Stetigkeit", () => {
    const m = new SpinModel({ t0: 0, f0: 1 });
    m.setTarget({ f: 40 });
    m.advance(5);
    const before = [3.0, 3.31, 4.2, 4.99].map((t) => [m.phaseAt(t), m.freqAt(t)]);
    m.prune(2.99);
    const after = [3.0, 3.31, 4.2, 4.99].map((t) => [m.phaseAt(t), m.freqAt(t)]);
    expect(after).toEqual(before);
    expect(m.pulsesBetween(3, 5).every((p) => Math.abs(m.phaseAt(p.t) - p.index) < 1e-9)).toBe(true);
  });

  it("erzeugte Knoten sind unveränderlich, auch nach setTarget", () => {
    const m = new SpinModel({ t0: 0, f0: 2 });
    m.setTarget({ f: 50 });
    m.advance(1);
    const snap = m.knotsSince(-1).map((k) => ({ ...k }));
    m.setTarget({ f: 0.5 });
    m.advance(2);
    expect(m.knotsSince(-1).slice(0, snap.length)).toEqual(snap);
  });

  it("spinUpTrack: erster Puls bei t0, Endfrequenz F_STAR", () => {
    const tr = spinUpTrack({ t0: 5, p0: 0.12, p1: 0.005757, durS: 0.9, shape: 1.6, holdS: 0.25 });
    const ps = tr.pulsesBetween(5, 6.15);
    expect(ps[0].t).toBeCloseTo(5, 9);
    expect(tr.freqAt(5)).toBeCloseTo(1 / 0.12, 6);
    expect(tr.freqAt(6)).toBeCloseTo(1 / 0.005757, 6);
    expect(tr.end).toBeCloseTo(6.15, 6);
  });
});
