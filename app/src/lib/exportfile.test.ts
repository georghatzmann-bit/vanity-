import { describe, expect, it } from "vitest";
import { CSV_FILTER, HTML_FILTER, ispLogFileName, matchCardFileName, PNG_FILTER, slug, textBytes } from "./exportfile";

describe("Dateinamen beim Export", () => {
  it("Slug: Kleinbuchstaben, nur a–z, 0–9, „-“, höchstens 40 Zeichen", () => {
    expect(slug("Counter-Strike 2")).toBe("counter-strike-2");
    expect(slug("Baldur's Gate 3")).toBe("baldur-s-gate-3");
    expect(slug("Hollow Knight: Silksong")).toBe("hollow-knight-silksong");
    expect(slug("Über Größe & Maß")).toBe("uber-grosse-mass");
    expect(slug("  ---  ")).toBe("spiel");
    expect(slug("トロピカル")).toBe("spiel");
    const long = slug("A".repeat(30) + " " + "B".repeat(30));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toMatch(/^[a-z0-9-]+$/);
    expect(long.endsWith("-")).toBe(false);
  });
  it("Bildkarte: pulsar-match-<spiel>-<JJJJ-MM-TT-HHMM>.png (Ortszeit)", () => {
    const start = new Date(2026, 9, 14, 20, 5).getTime();
    expect(matchCardFileName("Counter-Strike 2", start)).toBe("pulsar-match-counter-strike-2-2026-10-14-2005.png");
  });
  it("Anbieter-Protokoll: pulsar-anbieter-protokoll-<von>_bis_<bis>.html/.csv", () => {
    const from = new Date(2026, 8, 1, 0, 0).getTime();
    const to = new Date(2026, 8, 30, 23, 59).getTime();
    expect(ispLogFileName(from, to, "html")).toBe("pulsar-anbieter-protokoll-2026-09-01_bis_2026-09-30.html");
    expect(ispLogFileName(from, to, "csv")).toBe("pulsar-anbieter-protokoll-2026-09-01_bis_2026-09-30.csv");
  });
  it("Filter passen zu den erlaubten Endungen des Backends", () => {
    const allowed = ["png", "html", "csv", "md", "txt"];
    for (const f of [PNG_FILTER, HTML_FILTER, CSV_FILTER]) for (const e of f.extensions) expect(allowed).toContain(e);
  });
  it("UTF-8, CSV mit BOM", () => {
    expect([...textBytes("ä")]).toEqual([0xc3, 0xa4]);
    expect([...textBytes("a", true)]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
  });
});
