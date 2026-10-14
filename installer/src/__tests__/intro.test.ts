import { describe, expect, it } from "vitest";
import { buildIntroScore, isSkipKey, scoreStart, SCORE_LEAD_S, type IntroSound } from "../intro/IntroScreen";
import { tunerReading } from "../intro/Tuner";
import { DEC_LINES, RA_LINES, RA_SEC_PX } from "../intro/SkyGrid";
import { PULSE_MS } from "../obs/introTimeline";
import type { IntroVariant } from "../obs/types";

/** Fake-Engine: zeichnet alle Aufrufe mit Modellzeit auf */
function fakeSound() {
  const calls: { kind: string; at?: number; gainDb?: number; gain?: number; o?: unknown }[] = [];
  const bed = {
    set: (o: { levelDb: number; at?: number }) => calls.push({ kind: "bed.set", at: o.at, gainDb: o.levelDb, o }),
    follow: (c: Float32Array, o: { at: number; durS: number }) => calls.push({ kind: "bed.follow", at: o.at, o: { n: c.length, first: c[0], last: c[c.length - 1], durS: o.durS } }),
    stop: (o?: { fadeS?: number }) => calls.push({ kind: "bed.stop", o }),
  };
  const snd: IntroSound = {
    pulse: (o) => calls.push({ kind: "pulse", at: o.at, gainDb: o.gainDb, o }),
    play: (n, o) => calls.push({ kind: `play.${n}`, at: o.at, gain: o.gain }),
    chord: (o) => calls.push({ kind: "chord", at: o.at, o }),
    noiseBed: () => bed,
    now: () => 0,
    later: (_ms, fn) => fn(),
  };
  return { snd, calls };
}

function runScore(v: IntroVariant, t0 = 100) {
  const { snd, calls } = fakeSound();
  for (const e of buildIntroScore(v, snd)) e.run(t0 + e.at);
  return calls;
}

describe("Intro: Überspringen per Taste (D.7)", () => {
  it("Esc, Enter, Leertaste und druckbare Tasten", () => {
    for (const key of ["Escape", "Enter", " ", "a", "Z", "1", "ß", "."]) expect(isSkipKey({ key })).toBe(true);
  });
  it("nicht: Tab, Modifier, M (Ton), Kürzel", () => {
    for (const key of ["Tab", "Shift", "Control", "Alt", "Meta", "m", "M", "ArrowLeft", "F5", "CapsLock"]) expect(isSkipKey({ key })).toBe(false);
    expect(isSkipKey({ key: "r", ctrlKey: true })).toBe(false);
    expect(isSkipKey({ key: "c", metaKey: true })).toBe(false);
  });
});

describe("Intro: Partitur aus derselben Tabelle (D.2)", () => {
  it("Vollfassung: 16 Zeilen-Pulse, Puls 2 − Puls 1 = 1337,3 ms, Schlusspuls mit Teiltönen 2 und 4", () => {
    const calls = runScore("full");
    const pulses = calls.filter((c) => c.kind === "pulse");
    // 16 Zeilen + Schlusspuls
    expect(pulses).toHaveLength(17);
    expect((pulses[1].at! - pulses[0].at!) * 1000).toBeCloseTo(PULSE_MS, 6);
    expect(pulses[0].gainDb).toBe(-14);
    expect(pulses[1].gainDb).toBe(-14);
    expect(pulses[15].gainDb!).toBeCloseTo(-21.0, 1);
    const final = pulses[16];
    expect(final.gainDb).toBe(-18);
    expect((final.at! - 100) * 1000).toBeCloseTo(4500, 6);
    const chord = calls.find((c) => c.kind === "chord")!;
    expect(chord.at).toBe(final.at);
    expect(chord.o).toMatchObject({ partials: [2, 4], levelsDb: [-30, -32] });
  });

  it("Vollfassung: Rauschbett −34 → Suche → −44 bei 1150, Rastklick −42, Stopp bei 3900", () => {
    const calls = runScore("full");
    const sets = calls.filter((c) => c.kind === "bed.set");
    expect(sets[0].gainDb).toBe(-34);
    expect(sets[1].gainDb).toBe(-44);
    expect((sets[1].at! - 100) * 1000).toBeCloseTo(1150, 6);
    const follow = calls.find((c) => c.kind === "bed.follow")!;
    expect(follow.o).toMatchObject({ n: 48 });
    expect((follow.o as { durS: number }).durS).toBeCloseTo(0.85, 6);
    // Kurve endet auf der Bandpass-Mitte der Faltfrequenz
    expect((follow.o as { last: number }).last).toBeCloseTo(300 * Math.pow(8, Math.log(0.7478 / 0.25) / Math.log(16)), 1);
    const tick = calls.find((c) => c.kind === "play.tick")!;
    expect(20 * Math.log10(tick.gain!) - 30).toBeCloseTo(-42, 6);
    expect(calls.some((c) => c.kind === "bed.stop")).toBe(true);
  });

  it("Kurzfassung: ein Puls bei 300, Schlusspuls bei 750", () => {
    const p = runScore("short", 0).filter((c) => c.kind === "pulse");
    expect(p.map((c) => Math.round(c.at! * 1000))).toEqual([300, 750]);
  });

  it("reduziert: zwei echte Pulse 1337,3 ms auseinander, kein Rauschbett", () => {
    const calls = runScore("reduced", 0);
    const p = calls.filter((c) => c.kind === "pulse");
    expect(p).toHaveLength(2);
    expect((p[1].at! - p[0].at!) * 1000).toBeCloseTo(PULSE_MS, 6);
    expect(calls.some((c) => c.kind.startsWith("bed."))).toBe(false);
  });

  it("reduziert kurz: genau ein Puls bei 200 ms, keine Teiltöne", () => {
    const calls = runScore("reducedShort", 0);
    expect(calls.filter((c) => c.kind === "pulse").map((c) => Math.round(c.at! * 1000))).toEqual([200]);
    expect(calls.some((c) => c.kind === "chord")).toBe(false);
  });
});

describe("Intro: Partitur-Start und Nachholen", () => {
  it("Rauschbett-Ereignisse werden auch verspätet ausgeführt (catchUp)", () => {
    const calls: unknown[] = [];
    const snd = { pulse: () => calls.push(1), play: () => calls.push(1), chord: () => calls.push(1), noiseBed: () => ({ set() {}, follow() {}, stop() {} }), now: () => 0, later: () => undefined };
    const ev = buildIntroScore("full", snd as unknown as IntroSound);
    expect(ev.filter((e) => e.catchUp).length).toBeGreaterThanOrEqual(2);
    expect(ev.filter((e) => e.catchUp).every((e) => e.at <= 2)).toBe(true);
  });
  it("erster Puls hat mindestens 80 ms Vorlauf", () => {
    for (const v of ["full", "short", "reduced", "reducedShort"] as const) {
      const t0 = 10;
      const now = 10.25;
      const s = scoreStart(t0, now, v);
      expect(s).toBeGreaterThanOrEqual(t0);
      const first = buildIntroScore(v, { pulse() {}, play() {}, chord() {}, noiseBed: () => ({ set() {}, follow() {}, stop() {} }), now: () => 0, later() {} } as unknown as IntroSound).find((e) => e.at > 0 && e.at < 5);
      expect(first).toBeDefined();
    }
    expect(scoreStart(10, 10.25, "reducedShort")).toBeGreaterThanOrEqual(10.25 + SCORE_LEAD_S - 0.2 - 1e-9);
  });
});

describe("Intro: Ablesung und Himmelskarte (C.1, B.6)", () => {
  it("Ablesung beim Suchen und eingerastet (wörtlich)", () => {
    expect(tunerReading(0.412, false, "de")).toBe("F 0,412 Hz · P 2,427 s");
    expect(tunerReading(0.7478, true, "de")).toBe("F 0,7478 Hz · P 1,3373 s");
    expect(tunerReading(0.7478, true, "en")).toBe("F 0.7478 Hz · P 1.3373 s");
  });
  it("Karte unverzerrt: 5 s RA = 115,99 px, 1′ Dec = 100 px, CP 1919 bei (490, 250)", () => {
    for (let i = 1; i < RA_LINES.length; i++) expect(RA_LINES[i][0] - RA_LINES[i - 1][0]).toBeCloseTo(5 * RA_SEC_PX, 0);
    for (let i = 1; i < DEC_LINES.length; i++) expect(DEC_LINES[i][0] - DEC_LINES[i - 1][0]).toBeCloseTo(100, 6);
    // RA 19h21m44.8s: 0,2 s rechts von 21m45s; Dec +21°53′02″: 2″ über +21°53′
    expect(RA_LINES[3][0] + 0.2 * RA_SEC_PX).toBeCloseTo(490, 0);
    expect(DEC_LINES[1][0] - (2 / 60) * 100).toBeCloseTo(250, 0);
  });
});
