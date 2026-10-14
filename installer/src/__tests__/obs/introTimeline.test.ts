import { describe, expect, it } from "vitest";
import { chooseVariant, introEvents, introStateAt, introTimings, PULSE_MS, ROW_PULSE_TIMES, rowFactor, skipState, TIMELAPSE_GAPS } from "../../obs/introTimeline";

const pulses = (v: Parameters<typeof introEvents>[0]) => introEvents(v).filter((e) => e.kind === "pulse" || e.kind === "final");

describe("Intro-Zeitachse: Vollfassung (D.2)", () => {
  const ev = introEvents("full");
  const rowPulses = ev.filter((e) => e.kind === "pulse");

  it("16 Zeilen-Pulse", () => {
    expect(rowPulses).toHaveLength(16);
    expect(rowPulses.map((e) => e.row)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(PULSE_MS).toBe(1337.3);
  });

  it("Puls 2 − Puls 1 = 1337,3 ms", () => {
    expect(Math.abs(rowPulses[1].at - rowPulses[0].at - 1337.3)).toBeLessThan(0.01);
    expect(rowPulses[0].at).toBe(1150);
  });

  it("Zeitraffer-Faktoren steigen von 8,92 auf 26,75", () => {
    const f = Array.from({ length: 14 }, (_, i) => rowFactor(i + 3));
    expect(Math.abs(f[0] - 8.92)).toBeLessThan(0.05);
    expect(Math.abs(f[13] - 26.75)).toBeLessThan(0.05);
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
    expect(TIMELAPSE_GAPS.reduce((a, b) => a + b, 0)).toBeCloseTo(1284.0, 0);
  });

  it("t₃ = 2637,3, t₁₆ = 3771,3", () => {
    expect(ROW_PULSE_TIMES[2]).toBeCloseTo(2637.3, 6);
    expect(Math.abs(ROW_PULSE_TIMES[15] - 3771.3)).toBeLessThan(0.5);
  });

  it("Ausgang 5300, Ende ≤ 5700", () => {
    expect(ev.find((e) => e.kind === "exit")!.at).toBe(5300);
    expect(ev.find((e) => e.kind === "end")!.at).toBeLessThanOrEqual(5700);
    expect(ev.find((e) => e.kind === "acquired")!.at).toBe(4500);
    expect(ev.find((e) => e.kind === "final")!.at).toBe(4500);
  });

  it("Pegel −16,2 → −21,0 dBFS im Zeitraffer", () => {
    expect(rowPulses[0].gainDb).toBe(-14);
    expect(rowPulses[1].gainDb).toBe(-14);
    expect(rowPulses[2].gainDb!).toBeCloseTo(-16.2, 1);
    expect(rowPulses[15].gainDb!).toBeCloseTo(-21.0, 1);
  });

  it("Phasen für data-phase", () => {
    expect(introStateAt(500).phase).toBe("search");
    expect(introStateAt(2000).phase).toBe("realtime");
    expect(introStateAt(3000).phase).toBe("timelapse");
    expect(introStateAt(4000).phase).toBe("fold");
    expect(introStateAt(4800).phase).toBe("acquired");
    expect(introStateAt(5400).phase).toBe("exit");
  });

  it("Label ×1 Echtzeit, dann ×n Zeitraffer", () => {
    expect(introStateAt(2000).label).toEqual({ kind: "realtime" });
    const l = introStateAt(3700).label;
    expect(l?.kind).toBe("timelapse");
  });
});

describe("Intro-Zeitachse: Kurz und reduziert (D.5, D.6)", () => {
  it("short: Einrasten 300, Ausgang 1050, Ende ≤ 1400", () => {
    const tm = introTimings("short");
    expect(tm.lockAt).toBe(300);
    expect(tm.exitAt).toBe(1050);
    expect(tm.endAt).toBeLessThanOrEqual(1400);
    const p = pulses("short");
    expect(p[0].at).toBe(300);
    expect(introEvents("short").find((e) => e.kind === "end")!.at).toBeLessThanOrEqual(1400);
  });

  it("reduced: Pulse bei 300 und 1637,3, Ende ≤ 2000", () => {
    const p = pulses("reduced");
    expect(p.map((e) => e.at)).toEqual([300, 300 + 1337.3]);
    expect(p[1].at - p[0].at).toBeCloseTo(1337.3, 9);
    expect(introEvents("reduced").find((e) => e.kind === "end")!.at).toBeLessThanOrEqual(2000);
  });

  it("reducedShort: Puls 200, Ausgang 800, Ende 1000", () => {
    const tm = introTimings("reducedShort");
    expect(pulses("reducedShort").map((e) => e.at)).toEqual([200]);
    expect(tm.exitAt).toBe(800);
    expect(tm.endAt).toBe(1000);
  });

  it("Variante: reduziert > kurz > voll", () => {
    expect(chooseVariant({ reduced: false, mode: "install" })).toBe("full");
    expect(chooseVariant({ reduced: false, mode: "maintenance" })).toBe("full");
    expect(chooseVariant({ reduced: false, mode: "update" })).toBe("short");
    expect(chooseVariant({ reduced: false, mode: "uninstall" })).toBe("short");
    expect(chooseVariant({ reduced: false, mode: "install", preset: true })).toBe("short");
    expect(chooseVariant({ reduced: true, mode: "install" })).toBe("reduced");
    expect(chooseVariant({ reduced: true, mode: "update" })).toBe("reducedShort");
    expect(chooseVariant({ reduced: false, mode: null })).toBe("full");
  });
});

describe("introStateAt / skipState", () => {
  for (const v of ["full", "short", "reduced", "reducedShort"] as const) {
    it(`${v}: Zahl integrierter Zeilen sinkt nie, Faltung nie rückwärts`, () => {
      let rows = 0;
      let sum = 0;
      let ring = 0;
      const end = introTimings(v).endAt;
      for (let t = 0; t <= end + 100; t += 5) {
        const s = introStateAt(t, v);
        expect(s.rowsDone).toBeGreaterThanOrEqual(rows);
        expect(s.sumCount).toBeGreaterThanOrEqual(sum);
        expect(s.ringFold).toBeGreaterThanOrEqual(ring - 1e-12);
        rows = s.rowsDone;
        sum = s.sumCount;
        ring = s.ringFold;
      }
      expect(introStateAt(end, v).done).toBe(true);
    });

    it(`${v}: skipState = Endzustand`, () => {
      const s = skipState(v);
      expect(s.acquired).toBe(true);
      expect(s.rowsDone).toBe(16);
      expect(s.markAlpha).toBe(1);
      expect(s.exit).toBe(0);
      expect(s.done).toBe(false);
      expect(s.locked).toBe(true);
    });
  }

  it("Nadel: sucht und rastet bei 0,7478 Hz ein", () => {
    expect(introStateAt(300).needleHz).toBeCloseTo(0.4, 9);
    expect(introStateAt(560).needleHz).toBeCloseTo(2.6, 6);
    expect(introStateAt(1150).needleHz).toBeCloseTo(0.7478, 9);
    expect(introStateAt(1149).locked).toBe(false);
    expect(introStateAt(1150).locked).toBe(true);
  });
});
