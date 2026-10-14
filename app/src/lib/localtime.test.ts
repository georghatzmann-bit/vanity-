import { describe, expect, it } from "vitest";
import { localParts } from "./localtime";

const BERLIN = "Europe/Berlin";
const utc = (iso: string) => Date.parse(iso);

describe("localParts (Ortszeit, Montag = 0)", () => {
  it("normaler Tag mit Winterzeit (UTC+1)", () => {
    expect(localParts(utc("2026-01-05T19:30:00Z"), BERLIN)).toEqual({ year: 2026, month: 1, day: 5, weekday: 0, hour: 20 });
  });
  it("Sommerzeit-Beginn: letzter Sonntag im März (29.03.2026, 2 → 3 Uhr)", () => {
    expect(localParts(utc("2026-03-29T00:59:59Z"), BERLIN)).toEqual({ year: 2026, month: 3, day: 29, weekday: 6, hour: 1 });
    expect(localParts(utc("2026-03-29T01:00:00Z"), BERLIN)).toEqual({ year: 2026, month: 3, day: 29, weekday: 6, hour: 3 });
  });
  it("Sommerzeit-Ende: letzter Sonntag im Oktober (25.10.2026, 3 → 2 Uhr – Stunde 2 zweimal)", () => {
    expect(localParts(utc("2026-10-25T00:30:00Z"), BERLIN).hour).toBe(2);
    expect(localParts(utc("2026-10-25T01:30:00Z"), BERLIN).hour).toBe(2);
    expect(localParts(utc("2026-10-25T02:30:00Z"), BERLIN).hour).toBe(3);
  });
  it("Tageswechsel in Ortszeit statt UTC", () => {
    expect(localParts(utc("2026-10-24T22:30:00Z"), BERLIN)).toEqual({ year: 2026, month: 10, day: 25, weekday: 6, hour: 0 });
    expect(localParts(utc("2026-10-24T22:30:00Z"), "UTC")).toEqual({ year: 2026, month: 10, day: 24, weekday: 5, hour: 22 });
  });
  it("Mitternacht ist Stunde 0 (nicht 24)", () => {
    expect(localParts(utc("2026-07-01T22:00:00Z"), BERLIN).hour).toBe(0);
  });
});
