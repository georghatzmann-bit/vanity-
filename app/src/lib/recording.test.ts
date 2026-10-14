import { describe, expect, it } from "vitest";
import { appendFresh } from "./recording";
import type { PingSample } from "./types";

const KEEP = 900;
const sample = (i: number, start = 1_000_000): PingSample => ({ targetId: "a", t: start + i * 1000, rtt: 20 + (i % 7) });

/** Simuliert den Monitor-Puffer (useNet: höchstens 900 Werte) und die Aufzeichnung über den Abonnenten */
function simulate(ticks: number, opts: { clearAt?: number } = {}) {
  let buffer: PingSample[] = [];
  const rec = { start: 1_000_000, lastT: Number.NEGATIVE_INFINITY, samples: [] as PingSample[] };
  for (let i = 0; i < ticks; i++) {
    if (opts.clearAt === i) buffer = []; // Zielwechsel: neuer Puffer
    buffer = [...buffer, sample(i)].slice(-KEEP);
    const { fresh, lastT } = appendFresh(buffer, rec.lastT, rec.start);
    rec.samples.push(...fresh);
    rec.lastT = lastT;
  }
  return rec.samples;
}

describe("appendFresh (Fehler boost.ts:95 behoben)", () => {
  it("nimmt nach 900 Messwerten weiter auf", () => {
    const got = simulate(2000);
    expect(got).toHaveLength(2000);
    expect(got[1999].t).toBe(sample(1999).t);
  });
  it("keine doppelten Werte, auch wenn derselbe Puffer mehrfach ankommt", () => {
    const buffer = [sample(0), sample(1), sample(2)];
    const a = appendFresh(buffer, Number.NEGATIVE_INFINITY, 1_000_000);
    const b = appendFresh(buffer, a.lastT, 1_000_000);
    expect(a.fresh).toHaveLength(3);
    expect(b.fresh).toHaveLength(0);
    expect(b.lastT).toBe(a.lastT);
    const all = simulate(1200);
    expect(new Set(all.map((s) => s.t)).size).toBe(all.length);
  });
  it("Zielwechsel (Puffer geleert) verliert nichts", () => {
    expect(simulate(1500, { clearAt: 950 })).toHaveLength(1500);
  });
  it("Werte vor dem Spielstart (mehr als 2 s) zählen nicht", () => {
    const start = 1_000_000;
    const buffer: PingSample[] = [
      { targetId: "a", t: start - 5000, rtt: 10 },
      { targetId: "a", t: start - 2000, rtt: 11 },
      { targetId: "a", t: start + 1000, rtt: 12 },
    ];
    const { fresh } = appendFresh(buffer, Number.NEGATIVE_INFINITY, start);
    expect(fresh.map((s) => s.rtt)).toEqual([11, 12]);
  });
});
