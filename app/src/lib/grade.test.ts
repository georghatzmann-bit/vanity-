import { describe, expect, it } from "vitest";
import { countSpikes, isLiveSpike, PING_GRADE_LIMITS, pingGrade, spikeLimit } from "./grade";
import fixtures from "./fixtures/spikes.json";

interface CountCase {
  name: string;
  rtts: (number | null)[];
  limit: number | null;
  spikes: number;
}
interface LiveCase {
  name: string;
  window: (number | null)[];
  spike: boolean;
}

describe("Ausreißer-Regel (gleiche Prüfdaten wie das Backend)", () => {
  it.each((fixtures.count as CountCase[]).map((c) => [c.name, c] as const))("zählt: %s", (_name, c) => {
    expect(spikeLimit(c.rtts.filter((v): v is number => v !== null))).toBe(c.limit);
    expect(countSpikes(c.rtts)).toBe(c.spikes);
  });
  it.each((fixtures.live as LiveCase[]).map((c) => [c.name, c] as const))("live: %s", (_name, c) => {
    expect(isLiveSpike(c.window)).toBe(c.spike);
  });
  it("Prüfdaten enthalten alle Pflichtfälle", () => {
    const names = [...fixtures.count, ...fixtures.live].map((c) => c.name).join(" | ");
    for (const must of ["leer", "nur Verlust", "ungerade", "gerade", "genau auf der Grenze", "+40", "×2", "Verluste gemischt", "9 Antworten", "10 Antworten", "über 60"]) expect(names).toContain(must);
  });
});

describe("Ø-Ping-Stufen", () => {
  it("PING_GRADE_LIMITS sind die Grenzen von pingGrade", () => {
    expect(PING_GRADE_LIMITS).toEqual([20, 35, 60, 100, 180]);
    const grades = ["A+", "A", "B", "C", "D", "F"];
    PING_GRADE_LIMITS.forEach((limit, i) => {
      expect(pingGrade(limit - 0.1, 0, 0)).toBe(grades[i]);
      expect(pingGrade(limit, 0, 0)).toBe(grades[i + 1]);
    });
  });
});
