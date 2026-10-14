import { describe, expect, it } from "vitest";
import { JITTER_SPAN, MIN_LEAD_S, accentNext, createPlanState, planPulses, setDropout, setPeriod, skipNext } from "@shared/sound/voicePlan";

/** Plant wie der Scheduler in 25-ms-Takten mit 0,12 s Lookahead. */
function run(s: ReturnType<typeof createPlanState>, from: number, to: number) {
  const out = [];
  for (let now = from; now < to; now += 0.025) out.push(...planPulses(s, now, now + 0.12));
  return out;
}

describe("planPulses (eigener Takt, E.11)", () => {
  it("jitter 0: exakte Vielfache, kein akkumulierter Versatz", () => {
    const s = createPlanState({ periodS: 0.25, startAt: 10 });
    const ps = run(s, 9.9, 40);
    expect(ps.length).toBeGreaterThan(110);
    ps.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(Math.abs(p.t - (10 + i * 0.25))).toBeLessThan(1e-9);
    });
  });

  it("setPeriod wirkt erst ab dem nächsten noch nicht geplanten Puls", () => {
    const s = createPlanState({ periodS: 1, startAt: 0 });
    const a = run(s, -0.1, 2.5); // geplant: 0, 1, 2
    expect(a.map((p) => p.t)).toEqual([0, 1, 2].map((x) => expect.closeTo(x, 9)));
    setPeriod(s, 0.5);
    const b = run(s, 2.3, 4.1);
    expect(b[0].t).toBeCloseTo(2.5, 9); // 2 (letzter geplanter) + 0,5
    expect(b.map((p) => p.t)).toEqual([2.5, 3, 3.5, 4].map((x) => expect.closeTo(x, 9)));
  });

  it("jitter 1: Versatz ∈ [−0,35P; +0,35P], Mittel ±2 % P", () => {
    const P = 0.5;
    const s = createPlanState({ periodS: P, jitter: 1, seed: 1234, startAt: 0 });
    let sum = 0;
    let n = 0;
    for (let now = 0; n < 10000; now += 0.025) {
      for (const p of planPulses(s, now, now + 0.12)) {
        const off = p.t - p.nominal;
        if (p.t > now + MIN_LEAD_S + 1e-12) {
          expect(off).toBeGreaterThanOrEqual(-JITTER_SPAN * P - 1e-12);
          expect(off).toBeLessThanOrEqual(JITTER_SPAN * P + 1e-12);
        }
        sum += off;
        n++;
      }
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.02 * P);
  });

  it("skipNext lässt genau einen Puls aus", () => {
    const s = createPlanState({ periodS: 0.2, startAt: 0 });
    run(s, 0, 1);
    skipNext(s);
    const ps = run(s, 1, 3);
    expect(ps.filter((p) => p.dropped).length).toBe(1);
    expect(ps[0].dropped).toBe(true);
    expect(ps[0].level).toBe(0);
  });

  it("accentNext = min(1, 1,5·Basis), genau einmal", () => {
    const s = createPlanState({ periodS: 0.2, startAt: 0, level: 0.5 });
    run(s, 0, 1);
    accentNext(s);
    const ps = run(s, 1, 3);
    expect(ps[0].level).toBeCloseTo(0.75, 12);
    expect(ps.slice(1).every((p) => p.level === 0.5)).toBe(true);
    const s2 = createPlanState({ periodS: 0.2, startAt: 0, level: 0.9 });
    accentNext(s2, 1.5);
    expect(run(s2, 0, 0.1)[0].level).toBe(1);
  });

  it("dropout 0,25 → 25 % ±3 %", () => {
    const s = createPlanState({ periodS: 0.05, dropout: 0.25, seed: 99, startAt: 0 });
    const ps = run(s, 0, 500);
    expect(ps.length).toBeGreaterThan(9000);
    const r = ps.filter((p) => p.dropped).length / ps.length;
    expect(Math.abs(r - 0.25)).toBeLessThan(0.03);
  });

  it("setDropout mit Rampe: 0 → 1 über rampS", () => {
    const s = createPlanState({ periodS: 0.05, startAt: 0, seed: 3 });
    setDropout(s, 1, 0, 1);
    const ps = run(s, 0, 2);
    expect(ps.filter((p) => p.t > 1.01).every((p) => p.dropped)).toBe(true);
    expect(ps.filter((p) => p.t < 0.1).some((p) => !p.dropped)).toBe(true);
  });

  it("nie früher als now + 5 ms; kein Nachhol-Burst nach einer Pause", () => {
    const s = createPlanState({ periodS: 0.1, jitter: 1, startAt: 0, seed: 5 });
    run(s, 0, 1);
    // 3 s Pause (z. B. verborgen) – danach keine verpassten Pulse
    const after = planPulses(s, 4, 4.12);
    for (const p of after) expect(p.t).toBeGreaterThanOrEqual(4 + MIN_LEAD_S - 1e-12);
    expect(after.length).toBeLessThanOrEqual(3);
  });
});
