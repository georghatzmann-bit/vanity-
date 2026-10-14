import { describe, expect, it } from "vitest";
import { formatDuration, formatExposure, formatHz, formatPercent, formatPeriod, NBSP } from "../../obs/format";

const n = (s: string) => s.replace(/ /g, NBSP);

describe("Formate (F.4)", () => {
  it("NBSP ist U+00A0", () => {
    expect(NBSP).toBe(" ");
  });

  it("de mit Komma", () => {
    expect(formatPeriod(1.3373, "de")).toBe(n("1,3373 s"));
    expect(formatPeriod(0.3456, "de")).toBe(n("345,6 ms"));
    expect(formatPeriod(0.08933, "de")).toBe(n("89,33 ms"));
    expect(formatPeriod(0.0337, "de")).toBe(n("33,70 ms"));
    expect(formatPeriod(0.005757, "de")).toBe(n("5,757 ms"));
    expect(formatHz(0.748, "de")).toBe(n("0,748 Hz"));
    expect(formatHz(11.19, "de")).toBe(n("11,19 Hz"));
    expect(formatHz(173.7, "de")).toBe(n("173,7 Hz"));
    expect(formatPercent(43, "de")).toBe(n("43,0 %"));
  });

  it("en mit Punkt", () => {
    expect(formatPeriod(1.3373, "en")).toBe(n("1.3373 s"));
    expect(formatPeriod(0.3456, "en")).toBe(n("345.6 ms"));
    expect(formatPeriod(0.08933, "en")).toBe(n("89.33 ms"));
    expect(formatPeriod(0.0337, "en")).toBe(n("33.70 ms"));
    expect(formatPeriod(0.005757, "en")).toBe(n("5.757 ms"));
    expect(formatHz(0.748, "en")).toBe(n("0.748 Hz"));
    expect(formatHz(11.19, "en")).toBe(n("11.19 Hz"));
    expect(formatHz(173.7, "en")).toBe(n("173.7 Hz"));
    expect(formatPercent(43, "en")).toBe("43.0%");
  });

  it("NBSP vor jeder Einheit, keine schmalen Leerzeichen", () => {
    for (const s of [formatPeriod(1.3373), formatPeriod(0.0337), formatHz(11.19), formatPercent(43), formatDuration(400)]) {
      expect(s).toContain(" ");
      expect(s).not.toMatch(/[   ]/);
    }
  });

  it("Dauer: „0,4 s“, „12 s“, „1:05“", () => {
    expect(formatDuration(400, "de")).toBe(n("0,4 s"));
    expect(formatDuration(400, "en")).toBe(n("0.4 s"));
    expect(formatDuration(12_000, "de")).toBe(n("12 s"));
    expect(formatDuration(65_000, "de")).toBe("1:05");
  });

  it("Belichtung: 1/60 s, Sekunden, 2 · P", () => {
    expect(formatExposure(0.748, "de")).toBe(n("1/60 s"));
    expect(formatExposure(1.37, "de")).toBe(n("0,12 s"));
    expect(formatExposure(11.19, "de")).toBe("2 · P");
  });
});
