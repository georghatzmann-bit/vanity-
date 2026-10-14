import { describe, expect, it } from "vitest";
import { driveFor, installNoiseDb, periodForProgress } from "../../obs/drive";
import type { Progress } from "../../api";

const rel = (a: number, b: number) => Math.abs(a - b) / b;
const prog = (phase: Progress["phase"], percent: number): Progress => ({ phase, percent, downloaded: 0, total: 0, speed: 0, eta: 0 });

describe("periodForProgress (F.1)", () => {
  it("trifft die Tabelle F.1 (±0,5 %)", () => {
    const table: [number, number][] = [
      [0, 1.3373], [0.06, 1.3373], [0.2178, 0.3997], [0.23, 0.3456], [0.4, 0.08933], [0.48, 0.08933], [0.55, 0.05487], [0.578, 0.0416],
      [0.62, 0.0337], [0.7, 0.0337], [0.7823, 0.02084], [0.82, 0.01393], [0.85, 0.01007], [0.92, 0.005961], [0.94, 0.005757], [1, 0.005757],
    ];
    for (const [x, p] of table) expect(rel(periodForProgress(x), p), `x=${x}`).toBeLessThan(0.005);
  });

  it("Plateaus sind exakt", () => {
    for (const x of [0, 0.03, 0.06]) expect(periodForProgress(x)).toBeCloseTo(1.3373, 12);
    for (const x of [0.4, 0.44, 0.48]) expect(periodForProgress(x)).toBeCloseTo(0.08933, 12);
    for (const x of [0.62, 0.66, 0.7]) expect(periodForProgress(x)).toBeCloseTo(0.0337, 12);
    for (const x of [0.94, 0.97, 1]) expect(periodForProgress(x)).toBeCloseTo(0.005757, 12);
  });

  it("monoton nicht steigend", () => {
    let prev = Infinity;
    for (let i = 0; i <= 2000; i++) {
      const p = periodForProgress(i / 2000);
      expect(p).toBeLessThanOrEqual(prev + 1e-15);
      prev = p;
    }
  });

  it("begrenzt außerhalb [0, 1]", () => {
    expect(periodForProgress(-3)).toBe(periodForProgress(0));
    expect(periodForProgress(7)).toBe(periodForProgress(1));
    expect(periodForProgress(Number.NaN)).toBe(periodForProgress(0));
  });
});

describe("driveFor (F.1 Eingang)", () => {
  const none = { progress: null, unProgress: null };
  it("install: connect → 0, done → 1, sonst Prozent", () => {
    expect(driveFor("install", { ...none, progress: prog("connect", 3) })).toBe(0);
    expect(driveFor("install", { ...none, progress: prog("done", 100) })).toBe(1);
    expect(driveFor("install", { ...none, progress: prog("download", 43) })).toBeCloseTo(0.43, 12);
    expect(driveFor("install", { ...none, progress: prog("download", 140) })).toBe(1);
    expect(driveFor("install", none)).toBe(0);
  });
  it("un-run: x = 1 − percent/100", () => {
    expect(driveFor("un-run", { progress: null, unProgress: { step: "shortcuts", percent: 20 } })).toBeCloseTo(0.8, 12);
    expect(driveFor("un-run", none)).toBe(1);
  });
  it("done, Wartung, Bestätigen = 1; übrige = 0", () => {
    expect(driveFor("done", none)).toBe(1);
    expect(driveFor("maintenance", none)).toBe(1);
    expect(driveFor("un-confirm", none)).toBe(1);
    for (const s of ["intro", "welcome", "folder", "options", "un-done"] as const) expect(driveFor(s, none)).toBe(0);
  });
});

describe("Rauschbett in der Installation", () => {
  it("−46 dBFS bei 0, aus ab 0,25, dazwischen fallend", () => {
    expect(installNoiseDb(0)).toBe(-46);
    expect(installNoiseDb(0.25)).toBeNull();
    expect(installNoiseDb(0.6)).toBeNull();
    expect(installNoiseDb(0.2)!).toBeLessThan(installNoiseDb(0.1)!);
  });
});
