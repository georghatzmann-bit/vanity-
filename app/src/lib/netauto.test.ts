import { describe, expect, it } from "vitest";
import { AUTO_PROVIDERS, BACKEND_TEXTS, backendText, dnsScore, isDeclined, isManualProvider, mayBeChanged, pickBestDns, providerName, restoreDeclined, restoreProblems, shortDnsName } from "./netauto";
import { de } from "../locales/de";
import { en } from "../locales/en";
import type { AutoReport, DnsConfig, DnsResult } from "./types";

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

  it("jetziger DNS nicht gemessen (kein Eintrag current): kein Wechselvorschlag", () => {
    const p = pickBestDns([r("cloudflare", 11, 5), r("google", 16, 7)]);
    expect(p.current).toBeNull();
    expect(p.best?.id).toBe("cloudflare");
    expect(p.change).toBe(false);
    expect(p.gainMs).toBeNull();
    expect(p.currentScore).toBeNull();
    expect(p.reason).toBe("notMeasured");
  });

  it("nicht gemessen nach einem Wechsel: alte Router-Zeile ohne current zählt nicht", () => {
    // Vergleich lief mit Cloudflare, danach wurde zurückgestellt → keine Zeile ist mehr „current“
    const p = pickBestDns([r("cloudflare", 11, 5), r("google", 16, 7), r("current", 43, 3, { current: false })]);
    expect(p.reason).toBe("notMeasured");
    expect(p.change).toBe(false);
  });

  it("nicht gemessen und kein Kandidat zuverlässig: keine Daten", () => {
    const p = pickBestDns([r("cloudflare", 11, 5, { failed: 2 }), r("adguard", 9, 4)]);
    expect(p.reason).toBe("noData");
    expect(p.change).toBe(false);
  });

  it("aktueller DNS ohne Messwerte: hat nicht geantwortet → Wechsel zum besten Kandidaten", () => {
    const p = pickBestDns([r("cloudflare", 11, 5), r("current", null, null, { failed: 15 })]);
    expect(p.current?.id).toBe("current");
    expect(p.currentScore).toBeNull();
    expect(p.change).toBe(true);
    expect(p.gainMs).toBeNull();
    expect(p.reason).toBe("faster");
  });

  it("aktueller DNS mit Fehlern: nicht zuverlässig → Wechsel, auch wenn die Mediane gut aussehen", () => {
    const p = pickBestDns([r("cloudflare", 11, 5), r("current", 12, 3, { failed: 2 })]);
    expect(p.current?.id).toBe("current");
    expect(p.currentScore).toBeNull();
    expect(p.change).toBe(true);
    expect(p.gainMs).toBeNull();
    expect(p.reason).toBe("faster");
  });

  it("aktueller bekannter Dienst mit Fehlern: der beste zuverlässige Dienst wird vorgeschlagen", () => {
    const p = pickBestDns([r("cloudflare", 5, 2, { failed: 1, current: true }), r("google", 12, 6)]);
    expect(p.best?.id).toBe("google");
    expect(p.change).toBe(true);
    expect(p.reason).toBe("faster");
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

describe("Zurückstellen ehrlich auswerten", () => {
  const DECLINED = "Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.";
  const LEFT = "DNS noch nicht wie vorher";
  const dns = (changedByPulsar: boolean, otherBackups: string[] = []): DnsConfig => ({ adapterId: "{A}", adapter: "Ethernet", servers: ["192.168.178.1"], ipv6Servers: [], dhcp: true, provider: null, changedByPulsar, canChange: true, otherBackups });
  const rep = (x: Partial<AutoReport>): AutoReport => ({ dns: dns(false), dnsChanged: true, dnsError: null, applied: ["nagle"], failed: [], declined: false, restart: true, ...x });

  it("alles gut: keine Probleme, nicht abgelehnt", () => {
    expect(restoreProblems(rep({}), LEFT)).toEqual([]);
    expect(restoreDeclined(rep({}))).toBe(false);
  });
  it("abgelehnt: keine Probleme melden, aber als abgelehnt erkennen", () => {
    const r = rep({ declined: true, dnsChanged: false, applied: [], failed: [{ id: "nagle", error: DECLINED }] });
    expect(restoreProblems(r, LEFT)).toEqual([]);
    expect(restoreDeclined(r)).toBe(true);
  });
  it("DNS-Sicherung noch da: Windows hat den alten DNS nicht übernommen", () => {
    expect(restoreProblems(rep({ dns: dns(true), dnsChanged: false }), LEFT)).toEqual([LEFT]);
    // auch an einer anderen Verbindung
    expect(restoreProblems(rep({ dns: dns(false, ["WLAN"]), dnsChanged: false }), LEFT)).toEqual([LEFT]);
  });
  it("DNS-Fehler und fehlgeschlagene Optimierung werden gemeldet", () => {
    const r = rep({ dnsError: "Windows hat die DNS-Änderung nicht übernommen.", failed: [{ id: "netThrottle", error: "Nachkontrolle fehlgeschlagen" }] });
    expect(restoreProblems(r, LEFT)).toEqual(["Windows hat die DNS-Änderung nicht übernommen.", "Nachkontrolle fehlgeschlagen"]);
    expect(restoreDeclined(r)).toBe(false);
  });
  it("nur Ablehnungen in failed ohne DNS-Fehler zählen als abgelehnt", () => {
    expect(restoreDeclined(rep({ failed: [{ id: "nagle", error: DECLINED }] }))).toBe(true);
    expect(restoreDeclined(rep({ failed: [{ id: "nagle", error: DECLINED }], dnsError: "kaputt" }))).toBe(false);
  });
});

describe("Meldungen des Backends", () => {
  /** Übersetzen wie lib/i18n, aber mit fester Sprache */
  const tr = (dict: Record<string, unknown>) => (key: string, vars?: Record<string, string | number>) => {
    let cur: unknown = dict;
    for (const part of key.split(".")) cur = (cur as Record<string, unknown>)?.[part];
    const raw = typeof cur === "string" ? cur : key;
    return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
  };
  const deT = tr(de as unknown as Record<string, unknown>);
  const enT = tr(en as unknown as Record<string, unknown>);

  it("erkennt, dass Windows trotz Fehler schon geändert sein kann", () => {
    expect(mayBeChanged("Windows hat nicht alle Änderungen übernommen. Zurückstellen ist weiter möglich.")).toBe(true);
    expect(mayBeChanged("Der Admin-Helfer hat nicht rechtzeitig geantwortet. Zurückstellen ist weiter möglich.")).toBe(true);
    expect(mayBeChanged("Windows hat nicht alle Änderungen übernommen.")).toBe(false);
    expect(mayBeChanged(null)).toBe(false);
  });
  it("lässt deutsche Meldungen unverändert (die Texte in de.ts entsprechen dem Backend)", () => {
    for (const [sentence, key] of BACKEND_TEXTS) expect(deT(key)).toBe(sentence);
    const msg = "Der Admin-Helfer hat nicht rechtzeitig geantwortet. Zurückstellen ist weiter möglich.";
    expect(backendText(msg, deT)).toBe(msg);
    expect(backendText("DNS0.eu antwortet gerade nicht – Pulsar stellt ihn deshalb nicht ein.", deT)).toBe("DNS0.eu antwortet gerade nicht – Pulsar stellt ihn deshalb nicht ein.");
  });
  it("übersetzt bekannte Sätze, auch zusammengesetzte und mit Platzhalter", () => {
    expect(backendText("Der Admin-Helfer hat nicht rechtzeitig geantwortet. Zurückstellen ist weiter möglich.", enT)).toBe("The admin helper did not answer in time. Restoring is still possible.");
    expect(backendText("Mullvad antwortet gerade nicht – Pulsar stellt ihn deshalb nicht ein.", enT)).toBe("Mullvad is not answering right now – so Pulsar does not switch to it.");
    expect(backendText("Pulsar hat den DNS schon an 16 Verbindungen geändert – bitte erst zurückstellen.", enT)).toBe("Pulsar has already changed the DNS on 16 connections – please restore first.");
    expect(backendText("Pulsar kann den DNS auf diesem System nicht einstellen. Dafür braucht es Windows 10 Version 2004 oder neuer.", enT)).toBe(
      "Pulsar cannot set the DNS on this system. This needs Windows 10 version 2004 or newer.",
    );
    // Unbekanntes bleibt, wie es ist
    expect(backendText("Adapter fehlt: X Windows hat die DNS-Änderung nicht übernommen.", enT)).toBe("Adapter fehlt: X Windows did not accept the DNS change.");
  });
});

describe("Fehlersätze der 7 Netzwerk-Funktionen", () => {
  const look = (dict: unknown) => (key: string, vars?: Record<string, string | number>) => {
    let cur: unknown = dict;
    for (const p of key.split(".")) cur = (cur as Record<string, unknown>)?.[p];
    return String(cur).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ""));
  };
  it("feste Sätze und das Muster „Datei konnte nicht gespeichert werden“ werden übersetzt", () => {
    const enT = look(en);
    expect(backendText("Für diese Sitzung gibt es keine Messwerte.", enT)).toBe("There are no measurements for this session.");
    expect(backendText("Dateityp nicht erlaubt.", enT)).toBe("File type not allowed.");
    expect(backendText("Ungültiger Zeitraum.", enT)).toBe("Invalid time range.");
    expect(backendText("Datei konnte nicht gespeichert werden: Zugriff verweigert: C:\\x.png. Bitte prüfe die Berechtigungen.", enT)).toBe(
      "The file could not be saved: Zugriff verweigert: C:\\x.png. Bitte prüfe die Berechtigungen.",
    );
    expect(backendText("Datei konnte nicht gespeichert werden: X", look(de))).toBe("Datei konnte nicht gespeichert werden: X");
  });
});
