import { describe, expect, it } from "vitest";
import { diskTicks } from "../components/DiskScale";
import { nb } from "../components/Readout";

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
