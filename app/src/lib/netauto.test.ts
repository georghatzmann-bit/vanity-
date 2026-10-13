import { describe, expect, it } from "vitest";
import { AUTO_PROVIDERS, dnsScore, isDeclined, isManualProvider, pickBestDns, providerName, shortDnsName } from "./netauto";
import type { DnsResult } from "./types";

/** Messergebnis bauen: uncached = „neu“, cached = „bekannt“ */
const r = (id: string, uncachedMs: number | null, cachedMs: number | null, extra: Partial<DnsResult> = {}): DnsResult => ({
  id,
  name: id === "current" ? "Router (192.168.178.1)" : id,
  primary: "1.2.3.4",
  secondary: null,
  uncachedMs,
  cachedMs,
  failed: 0,
  current: id === "current",
  ...extra,
});

describe("DNS-Punktzahl", () => {
  it("gewichtet neue Adressen stärker als bekannte", () => {
    expect(dnsScore(r("x", 10, 20))).toBeCloseTo(13);
    expect(dnsScore(r("x", 20, 10))).toBeCloseTo(17);
  });
  it("braucht beide Messwerte", () => {
    expect(dnsScore(r("x", null, 5))).toBeNull();
    expect(dnsScore(r("x", 5, null))).toBeNull();
    expect(dnsScore(r("x", Number.NaN, 5))).toBeNull();
  });
});

describe("Besten DNS wählen", () => {
  it("nur Cloudflare, Google, Quad9 und OpenDNS kommen automatisch in Frage", () => {
    expect([...AUTO_PROVIDERS].sort()).toEqual(["cloudflare", "google", "opendns", "quad9"]);
    // AdGuard ist am schnellsten, wird aber nie automatisch gewählt
    const p = pickBestDns([r("adguard", 2, 1), r("dns0", 3, 1), r("mullvad", 3, 1), r("google", 10, 5), r("current", 40, 5)]);
    expect(p.best?.id).toBe("google");
    expect(p.change).toBe(true);
  });

  it("schlägt einen Wechsel vor, wenn der Router deutlich langsamer ist", () => {
    const p = pickBestDns([r("cloudflare", 11, 5), r("google", 16, 7), r("current", 43, 3)]);
    expect(p.best?.id).toBe("cloudflare");
    expect(p.current?.id).toBe("current");
    expect(p.change).toBe(true);
    expect(p.reason).toBe("faster");
    expect(p.bestScore).toBeCloseTo(9.2);
    expect(p.currentScore).toBeCloseTo(31);
    expect(p.gainMs).toBeCloseTo(21.8);
  });

  it("ohne aktuellen DNS: Wechsel zum besten Kandidaten", () => {
    const p = pickBestDns([r("cloudflare", 11, 5), r("google", 16, 7)]);
    expect(p.current).toBeNull();
    expect(p.best?.id).toBe("cloudflare");
    expect(p.change).toBe(true);
    expect(p.gainMs).toBeNull();
    expect(p.reason).toBe("faster");
  });

  it("aktueller DNS ohne Messwerte: Wechsel zum besten Kandidaten", () => {
    const p = pickBestDns([r("cloudflare", 11, 5), r("current", null, null, { failed: 15 })]);
    expect(p.current?.id).toBe("current");
    expect(p.currentScore).toBeNull();
    expect(p.change).toBe(true);
    expect(p.gainMs).toBeNull();
  });

  it("ist der aktuelle DNS schon der beste bekannte Dienst, bleibt alles", () => {
    const p = pickBestDns([r("cloudflare", 11, 5, { current: true }), r("google", 30, 7), r("quad9", 40, 9)]);
    expect(p.best?.id).toBe("cloudflare");
    expect(p.current?.id).toBe("cloudflare");
    expect(p.change).toBe(false);
    expect(p.gainMs).toBe(0);
    expect(p.reason).toBe("alreadyFast");
  });

  it("bei Gleichstand gewinnt der aktuelle Dienst", () => {
    const p = pickBestDns([r("cloudflare", 10, 10), r("google", 10, 10, { current: true })]);
    expect(p.best?.id).toBe("google");
    expect(p.change).toBe(false);
  });

  it("wechselt von einem langsamen bekannten Dienst zu einem schnelleren", () => {
    const p = pickBestDns([r("cloudflare", 10, 10), r("opendns", 30, 30, { current: true })]);
    expect(p.best?.id).toBe("cloudflare");
    expect(p.change).toBe(true);
    expect(p.gainMs).toBeCloseTo(20);
  });

  it("alle fehlgeschlagen oder ohne Werte: keine Daten, nichts ändern", () => {
    const p = pickBestDns([r("cloudflare", 11, 5, { failed: 1 }), r("google", null, 7), r("quad9", 12, null), r("current", 40, 5)]);
    expect(p.best).toBeNull();
    expect(p.change).toBe(false);
    expect(p.reason).toBe("noData");
    expect(p.current?.id).toBe("current");
    expect(pickBestDns([]).reason).toBe("noData");
  });

  it("ein Fehler reicht, damit ein Dienst nicht in Frage kommt", () => {
    const p = pickBestDns([r("cloudflare", 5, 2, { failed: 1 }), r("google", 12, 6), r("current", 40, 5)]);
    expect(p.best?.id).toBe("google");
  });

  describe("Schwellen (mindestens 15 % und mindestens 3 ms)", () => {
    // Punktzahl = 0,7 × neu + 0,3 × bekannt; gleiche Werte → Punktzahl = Wert
    it("genau 15 % und genau 3 ms: Wechsel", () => {
      const p = pickBestDns([r("cloudflare", 17, 17), r("current", 20, 20)]);
      expect(p.gainMs).toBeCloseTo(3);
      expect(p.change).toBe(true);
    });
    it("knapp unter 15 % (bei mehr als 3 ms): kein Wechsel", () => {
      const p = pickBestDns([r("cloudflare", 85.1, 85.1), r("current", 100, 100)]);
      expect(p.gainMs).toBeCloseTo(14.9);
      expect(p.change).toBe(false);
      expect(p.reason).toBe("alreadyFast");
    });
    it("genau 15 % bei viel mehr als 3 ms: Wechsel", () => {
      expect(pickBestDns([r("cloudflare", 85, 85), r("current", 100, 100)]).change).toBe(true);
    });
    it("knapp unter 3 ms (bei mehr als 15 %): kein Wechsel", () => {
      const p = pickBestDns([r("cloudflare", 7.1, 7.1), r("current", 10, 10)]);
      expect(p.gainMs).toBeCloseTo(2.9);
      expect(p.change).toBe(false);
    });
    it("genau 3 ms bei viel mehr als 15 %: Wechsel", () => {
      expect(pickBestDns([r("cloudflare", 7, 7), r("current", 10, 10)]).change).toBe(true);
    });
    it("Grenzen auch mit gemischten Werten (Rundungsfehler zählen nicht)", () => {
      // beste: 0,7 × 16 + 0,3 × 19,333… = 17 · aktuell: 0,7 × 20 + 0,3 × 20 = 20
      const p = pickBestDns([r("cloudflare", 16, 58 / 3), r("current", 20, 20)]);
      expect(p.change).toBe(true);
    });
  });
});

describe("Hilfen", () => {
  it("Namen und Hand-Dienste", () => {
    expect(providerName("cloudflare")).toBe("Cloudflare");
    expect(providerName("dns0")).toBe("DNS0.eu");
    expect(providerName("unbekannt")).toBe("unbekannt");
    expect(providerName(null)).toBe("");
    expect(isManualProvider("adguard")).toBe(true);
    expect(isManualProvider("mullvad")).toBe(true);
    expect(isManualProvider("cloudflare")).toBe(false);
    expect(isManualProvider(null)).toBe(false);
  });
  it("kurzer Name ohne Adresse in Klammern", () => {
    expect(shortDnsName(r("current", 1, 1))).toBe("Router");
    expect(shortDnsName(r("google", 1, 1, { name: "Google" }))).toBe("Google");
    expect(shortDnsName(null)).toBe("");
  });
  it("erkennt eine abgelehnte Windows-Abfrage", () => {
    expect(isDeclined("Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.")).toBe(true);
    expect(isDeclined("Windows hat die DNS-Änderung nicht übernommen.")).toBe(false);
    expect(isDeclined(null)).toBe(false);
  });
});
