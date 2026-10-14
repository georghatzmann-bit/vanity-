import { describe, expect, it } from "vitest";
import { diskTicks } from "../components/DiskScale";
import { nb } from "../components/Readout";
import { countdownTicks, countdownX } from "../components/Countdown";
import { formatBytes, formatEta, setLang } from "../i18n";
import { MARK_SMALL, smallRayEndpoints } from "@shared/ui/PulsarMark";

const GB = 1024 ** 3;

describe("Laufwerksskala (C.4)", () => {
  it("Striche in 1-2-5-Schritten bis zur Gesamtgröße", () => {
    const ticks = diskTicks(512_000_000_000);
    expect(ticks.map((b) => b / GB)).toEqual([0, 100, 200, 300, 400]);
    const small = diskTicks(64 * GB);
    expect(small.map((b) => b / GB)).toEqual([0, 20, 40, 60]);
    const tb = diskTicks(2 * 1024 * GB);
    expect(tb.length).toBeGreaterThanOrEqual(3);
    expect(tb.length).toBeLessThanOrEqual(6);
  });
  it("kein Strich ohne Größe", () => {
    expect(diskTicks(0)).toEqual([]);
    expect(diskTicks(Number.NaN)).toEqual([]);
  });
});

describe("Werte mit Einheit (B.3)", () => {
  it("NBSP zwischen Zahl und Einheit", () => {
    expect(nb("11,3 MB")).toBe("11,3 MB");
    expect(nb("11,3 MB")).not.toMatch(/[   ]/);
  });
});

if (typeof document === "undefined") {
  (globalThis as { document?: unknown }).document = { documentElement: {} };
}

describe("Countdown als Instrument (C.7)", () => {
  it("Skala 5 → 0 s: Striche je Sekunde, 0 rechts", () => {
    const ticks = countdownTicks(5);
    expect(ticks.map((k) => k.t)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(countdownX(0, 5)).toBe(472);
    expect(countdownX(5, 5)).toBe(0);
  });
  it("Update 2,6 s: nur ganze Sekunden (3·2·1·0) in gleichen Abständen, Nadel startet bei 2,6", () => {
    const ticks = countdownTicks(2.6);
    expect(ticks.map((k) => k.t)).toEqual([3, 2, 1, 0]);
    const gaps = ticks.slice(1).map((k, i) => k.x - ticks[i].x);
    for (const g of gaps) expect(g).toBeCloseTo(472 / 3, 6);
    expect(countdownX(2.6, 2.6)).toBeCloseTo(472 - (2.6 / 3) * 472, 6);
  });
});

describe("Einheiten wie die Messwerte", () => {
  it("Restzeit „8 s“, „1 min 5 s“, nie „1 min 60 s“", () => {
    for (const l of ["de", "en"] as const) {
      setLang(l);
      expect(formatEta(7.6)).toBe("8 s");
      expect(formatEta(65.2)).toBe("1 min 5 s");
      expect(formatEta(119.7)).toBe("2 min 0 s");
    }
  });
  it("kein „1.023 KB“: Einheit wechselt ab 1000", () => {
    setLang("de");
    expect(formatBytes(1023 * 1024)).toBe("1 MB");
    expect(formatBytes(999 * 1024)).toBe("999 KB");
    expect(formatBytes(11_800_000)).toBe("11,3 MB");
  });
});

describe("Titelleisten-Zeichen (≤ 24 px)", () => {
  it("Strahlen beginnen außerhalb des Rings (keine Linie durch den Ring) und passen ins Quadrat", () => {
    for (const size of [18, 24]) {
      const s = size / MARK_SMALL.BASE;
      const ringOuter = (MARK_SMALL.RING_R + MARK_SMALL.RING_STROKE / 2) * s;
      for (const e of smallRayEndpoints(size)) {
        const r0 = Math.hypot(e.x1 - size / 2, e.y1 - size / 2);
        expect(r0).toBeGreaterThan(ringOuter);
        for (const v of [e.x1, e.y1, e.x2, e.y2]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(size);
        }
      }
    }
  });
});
