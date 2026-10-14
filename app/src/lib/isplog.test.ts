import { describe, expect, it } from "vitest";
import { de } from "../locales/de";
import { en } from "../locales/en";
import { textBytes } from "./exportfile";
import {
  BNETZA_STAND,
  BNETZA_URL,
  bnetzaStandText,
  buildIspLog,
  csvField,
  defaultNetId,
  escapeHtml,
  HTML_MAX_ROWS,
  isoLocal,
  netChoices,
  offsetLabel,
  spikeGroup,
  spikeText,
  translator,
} from "./isplog";
import { DEMO_NET_ID, demoHourlyRows } from "./mock/calendar";
import { demoIspEvents, isplogMock, summarize } from "./mock/isplog";
import { defaultIspLog } from "./settings/isplog";
import { CONNECTION_KINDS, EVENT_KINDS, LAG_CAUSES, OUTAGE_SCOPES, type EventSummaryRow, type HourlyRow, type IspLogInput, type NetEvent } from "./types";

const TZ = "Europe/Berlin";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Ende der Sommerzeit 2026: 25.10. 03:00 MESZ → 02:00 MEZ (01:00 UTC)
const FROM = Date.UTC(2026, 9, 23, 0);
const TO = Date.UTC(2026, 9, 28, 0);

let nextId = 0;
function ev(p: Partial<NetEvent> & Pick<NetEvent, "kind" | "t">): NetEvent {
  return {
    id: ++nextId,
    endT: null,
    targetKey: "aws-eu-central-1",
    targetLabel: "Frankfurt (AWS)",
    method: "tcp",
    netId: "net-a",
    connection: "ethernet",
    value: null,
    cause: null,
    scope: null,
    sessionId: null,
    detail: null,
    ...p,
  };
}

function hourRow(hourStart: number, p: Partial<HourlyRow> = {}): HourlyRow {
  return {
    hourStart,
    targetKey: "aws-eu-central-1",
    netId: "net-a",
    connection: "ethernet",
    kind: "region",
    label: "Frankfurt (AWS)",
    method: "tcp",
    n: 3000,
    lost: 0,
    sumRtt: 60000,
    sumJitter: 3000,
    nJitter: 2999,
    maxRtt: 80,
    spikes: 0,
    coveredMs: HOUR,
    ...p,
  };
}

const outage = (t: number, scope: NetEvent["scope"], s = 10, p: Partial<NetEvent> = {}) => ev({ kind: "outage", t, endT: t + s * 1000, value: s, scope, detail: { checks: { link: true, gw: true, ext: false } }, ...p });

function build(over: Partial<IspLogInput> = {}) {
  const r = buildIspLog({ events: [], truncated: false, summary: [], hourly: [], from: FROM, to: TO, netId: "net-a", contract: defaultIspLog(), lang: "de", timeZone: TZ, now: TO, ...over });
  // Zahl und Einheit sind im HTML mit &nbsp; verbunden – für Textvergleiche als Leerzeichen lesen (eigener Test unten)
  return { ...r, html: r.html.replace(/&nbsp;/g, " ") };
}

describe("Ortszeit und Zeitzone", () => {
  it("Tageswerte in Ortszeit über die Sommerzeit-Grenze (Europe/Berlin)", () => {
    const a = Date.UTC(2026, 9, 24, 22, 30); // 25.10. 00:30 MESZ
    const b = Date.UTC(2026, 9, 25, 22, 30); // 25.10. 23:30 MEZ
    const c = Date.UTC(2026, 9, 25, 23, 30); // 26.10. 00:30 MEZ
    const r = build({
      events: [outage(a, "internet", 4), outage(b, "internet", 6), outage(c, "internet", 8)],
      // 02:00 MESZ und 02:00 MEZ: zwei Messstunden am selben Tag
      hourly: [hourRow(Date.UTC(2026, 9, 25, 0)), hourRow(Date.UTC(2026, 9, 25, 1)), hourRow(Date.UTC(2026, 9, 25, 2), { coveredMs: 20 * 60_000 })],
    });
    const d25 = r.days.find((d) => d.date === "2026-10-25");
    const d26 = r.days.find((d) => d.date === "2026-10-26");
    expect(d25?.internetOutages).toBe(2);
    expect(d25?.internetOutageS).toBe(10);
    expect(d25?.measuredHours).toBe(2);
    expect(d26?.internetOutages).toBe(1);
    expect(r.days.find((d) => d.date === "2026-10-24")).toBeUndefined();
    expect(r.header.utcOffset).toBe("UTC+2 / UTC+1");
    expect(r.header.timeZone).toBe(TZ);
    expect(r.csv).toContain("2026-10-25T00:30:00+02:00;2026-10-24T22:30:00Z;2026-10-25T00:30:04+02:00");
    expect(r.csv).toContain("2026-10-26T00:30:00+01:00;2026-10-25T23:30:00Z");
    expect(r.html).toContain("Europe/Berlin, UTC+2 / UTC+1");
    expect(r.html).toContain("So 25.10.2026");
  });

  it("Versatz-Texte und ISO-Zeiten", () => {
    expect(offsetLabel(0)).toBe("UTC");
    expect(offsetLabel(120)).toBe("UTC+2");
    expect(offsetLabel(330)).toBe("UTC+5:30");
    expect(offsetLabel(-180)).toBe("UTC-3");
    expect(isoLocal(Date.UTC(2026, 6, 1, 12, 0, 5), "UTC")).toBe("2026-07-01T12:00:05+00:00");
    expect(isoLocal(Date.UTC(2026, 6, 1, 12, 0, 5), "Asia/Kolkata")).toBe("2026-07-01T17:30:05+05:30");
    // Unbekannte Zeitzone verhindert den Bericht nie
    expect(build({ timeZone: "Mars/Olympus" }).header.timeZone).toBe("UTC");
  });
});

describe("Bewertung (nur gezählt, nichts juristisch)", () => {
  it("nur scope = internet zählt als „Aussetzer der Internetverbindung“", () => {
    const t = Date.UTC(2026, 9, 24, 8);
    const r = build({ events: [outage(t, "internet", 30), outage(t + HOUR, "homeNetwork"), outage(t + 2 * HOUR, "targetOnly"), outage(t + 3 * HOUR, "pc"), outage(t + 4 * HOUR, "unknown"), outage(t + 5 * HOUR, null)] });
    expect(r.totals.internetOutages).toBe(1);
    expect(r.totals.internetOutageS).toBe(30);
    expect(r.totals.otherOutages).toBe(5);
    const d = r.days[0];
    expect([d.homeNetworkOutages, d.targetOnlyOutages, d.pcOutages, d.unknownOutages]).toEqual([1, 1, 1, 2]);
    expect(r.html).toContain("Heimnetz/WLAN: 1 · nur Messziel: 1 · PC: 1 · unklar: 2");
    expect(r.html).toContain("Störung beim Anbieter melden und Ticketnummer notieren.");
    // Ohne Aussetzer der Internetverbindung kein Hinweis auf eine Störungsmeldung
    const quiet = build({ events: [outage(t, "pc"), outage(t + HOUR, "targetOnly")] });
    expect(quiet.totals.internetOutages).toBe(0);
    expect(quiet.html).not.toContain("Ticketnummer");
  });

  it("Ausreißer nur gezählt, nach Ursache mit „vermutlich“", () => {
    const h = Date.UTC(2026, 9, 24, 18);
    const s = (cause: EventSummaryRow["cause"], countSum: number, rows = 1): EventSummaryRow => ({ hourStart: h, kind: "spike", cause, scope: null, connection: "ethernet", netId: "net-a", rows, countSum, durationS: 0 });
    const summary = [s("wifi", 3), s("router", 1), s("localTraffic", 2), s("isp", 4), s("internet", 1), s("unknown", 2), s(null, 0, 1)];
    const r = build({ summary, events: [ev({ kind: "spike", t: h + 5, value: 180, cause: "wifi" })] });
    expect(r.totals.spikesByCause).toEqual({ home: 6, isp: 4, internet: 1, unknown: 3 });
    expect(r.html).toContain("14 Ausreißer – davon vermutlich Heimnetz/WLAN/PC: 6 · Anschluss/Anbieter: 4 · Internet: 1 · unklar: 3");
    expect(r.rows.some((x) => (x.kind as string) === "spike")).toBe(false);
    expect(build({ summary, lang: "en" }).html).toContain("14 spikes – of which likely home network/Wi-Fi/PC: 6");
    for (const c of LAG_CAUSES) expect(["home", "isp", "internet", "unknown"]).toContain(spikeGroup(c));
  });

  it("Netzfilter mit Hinweis auf andere Netze", () => {
    const h = Date.UTC(2026, 9, 24, 18);
    const hourly = [hourRow(h), hourRow(h + HOUR), hourRow(h, { netId: "net-b", coveredMs: 10 * 60_000 }), hourRow(h, { netId: "net-c", coveredMs: 5 * 60_000 })];
    const events = [outage(h, "internet"), outage(h + 60_000, "internet", 10, { netId: "net-b" })];
    const r = build({ hourly, events });
    expect(r.totals.internetOutages).toBe(1);
    expect(r.header.otherNets).toBe(2);
    expect(r.header.hours).toBe(2);
    expect(r.html).toContain("Messungen aus 2 anderen Netzen sind nicht enthalten.");
    expect(r.html).toContain("Netz 1");
    const b = build({ hourly, events, netId: "net-b" });
    expect(b.totals.internetOutages).toBe(1);
    expect(b.html).toContain("Netz 2");
    const one = build({ hourly: hourly.slice(0, 3) });
    expect(one.html).toContain("Messungen aus 1 anderen Netz sind nicht enthalten.");
    expect(build({ hourly: hourly.slice(0, 2) }).html).not.toContain("anderen Netz");
    // Standard-Netz: meiste Messzeit; Netze nur mit Ereignissen dahinter
    const extra: EventSummaryRow = { hourStart: h, kind: "outage", cause: null, scope: "internet", connection: null, netId: "net-x", rows: 1, countSum: 1, durationS: 3 };
    expect(defaultNetId(hourly, [extra])).toBe("net-a");
    expect(netChoices(hourly, [extra]).map((c) => [c.netId, c.index])).toEqual([["net-a", 1], ["net-b", 2], ["net-c", 3], ["net-x", 4]]);
    expect(defaultNetId([], [])).toBeNull();
  });

  it("WLAN-Anteil im Kopf (ab 1 %), VPN-Anteil", () => {
    const h = Date.UTC(2026, 9, 24, 8);
    const hourly = [...Array.from({ length: 38 }, (_, i) => hourRow(h + i * HOUR)), ...Array.from({ length: 62 }, (_, i) => hourRow(h + (40 + i) * HOUR, { connection: "wifi" }))];
    const r = build({ hourly, to: TO + 5 * DAY });
    expect(r.header.wifiShare).toBeCloseTo(0.62, 5);
    expect(r.html).toContain("62 % der Messzeit per WLAN – Aussetzer können am WLAN liegen; für Aussagen zum Anschluss per Kabel messen.");
    const tiny = build({ hourly: [...Array.from({ length: 199 }, (_, i) => hourRow(h + i * 600_000)), hourRow(h + 200 * 600_000, { connection: "wifi" })], to: TO + 5 * DAY });
    expect(tiny.header.wifiShare).toBeLessThan(0.01);
    expect(tiny.html).not.toContain("per WLAN");
    const vpn = build({ hourly: [hourRow(h), hourRow(h + HOUR, { connection: "vpn" })], events: [outage(h + 60_000, "internet", 5, { connection: "vpn" })] });
    expect(vpn.html).toContain("50 % der Messzeit mit VPN");
    expect(vpn.html).toContain('<tr class="vpn">');
  });

  it("Verlust als „x von n Paketen“, langsame Minuten je Ziel", () => {
    const t = Date.UTC(2026, 9, 24, 18, 5);
    const loss = ev({ kind: "loss", t, endT: t + 60_000, value: 5, detail: { lost: 3, n: 60 } });
    const slowA = ev({ kind: "slow", t: t + HOUR, endT: t + HOUR + 180_000, value: 142.4, detail: { threshold: 100, minutes: 3 } });
    const slowB = ev({ kind: "slow", t: t + 2 * HOUR, endT: t + 2 * HOUR + 120_000, value: 160, targetKey: "valve-cs2-fra", targetLabel: "CS2 Frankfurt", method: "icmp", detail: { threshold: 110, minutes: 2 } });
    const r = build({ events: [loss, slowA, slowB] });
    expect(r.rows[0].text).toBe("3 von 60 Paketen (5 %)");
    expect(build({ events: [loss], lang: "en" }).rows[0].text).toBe("3 of 60 packets (5 %)");
    expect(r.days[0].lossWorst).toEqual({ lost: 3, n: 60, pct: 5 });
    expect(r.days[0].slowMinutes).toBe(5);
    expect(r.days[0].slowByTarget).toEqual([
      { key: "aws-eu-central-1", label: "Frankfurt (AWS)", minutes: 3 },
      { key: "valve-cs2-fra", label: "CS2 Frankfurt", minutes: 2 },
    ]);
    expect(r.html).toContain("Frankfurt (AWS): 3 min");
    expect(r.html).toContain("CS2 Frankfurt: 2 min");
    expect(r.html).toContain("Entfernung zum Server ist kein Anbieterfehler");
    expect(r.rows[1].text).toBe("Ø bis 142 ms (Schwelle 100 ms) · 3 min");
  });

  it("Vertragsprozent nur mit Eintrag und nur als Zahl", () => {
    const t = Date.UTC(2026, 9, 24, 19);
    const st = ev({ kind: "speedtest", t, value: 450, targetKey: null, targetLabel: null, method: null, detail: { downloadMbps: 450, uploadMbps: 45, server: "FRA", connection: "ethernet", localMbps: 0.2 } as never });
    const without = build({ events: [st] });
    expect(without.rows[0].text).toBe("↓ 450 · ↑ 45 Mbit/s · Cloudflare FRA");
    expect(without.html).not.toContain("der eingetragenen Maximal-Geschwindigkeit");
    expect(without.html).toContain("nicht eingetragen");
    const contract = { ...defaultIspLog(), contractDownMbps: 500, contractUpMbps: 50, contractDownNormalMbps: 400 };
    const withC = build({ events: [st], contract });
    expect(withC.rows[0].text).toBe("↓ 450 · ↑ 45 Mbit/s · Cloudflare FRA · 90 % der eingetragenen Maximal-Geschwindigkeit");
    expect(withC.html).toContain("Maximal-Geschwindigkeit laut Vertrag (Produktinformationsblatt): Download 500 Mbit/s · Upload 50 Mbit/s");
    // leeres Feld: „Upload: nicht eingetragen“ statt „Upload – Mbit/s“
    const downOnly = build({ events: [st], contract: { ...defaultIspLog(), contractDownMbps: 500 } });
    expect(downOnly.html).toContain("Download 500 Mbit/s · Upload: nicht eingetragen");
    expect(downOnly.html).not.toContain("Upload – Mbit/s");
    expect(build({ events: [st], contract: { ...defaultIspLog(), contractDownMbps: 500 }, lang: "en" }).html).toContain("Upload: not entered");
    expect(withC.html).toContain("normalerweise verfügbar: 400 Mbit/s");
    expect(withC.html).not.toContain("minimal:");
    expect(withC.days[0].speed).toEqual({ n: 1, downMin: 450, downMedian: 450, upMin: 45, upMedian: 45 });
    // Keine Bewertung der Zahl
    for (const word of ["zu langsam", "unterschritten", "erheblich", "Anspruch"]) expect(withC.rows[0].text).not.toContain(word);
  });
});

describe("Export", () => {
  const t = Date.UTC(2026, 9, 24, 18, 0, 0);
  const tricky = [
    outage(t, "internet", 12.34, { targetLabel: 'Server "A"; Nord', sessionId: 42 }),
    ev({ kind: "loss", t: t + HOUR, endT: t + HOUR + 60_000, value: 6.7, detail: { lost: 4, n: 60 }, connection: "wifi" }),
    ev({ kind: "slow", t: t + 2 * HOUR, endT: t + 2 * HOUR + 60_000, value: 130, targetLabel: "=SUMME(1;2)", detail: { threshold: 100, minutes: 1 } }),
    ev({ kind: "speedtest", t: t + 3 * HOUR, value: 452.1, targetKey: null, targetLabel: null, method: null, detail: { downloadMbps: 452.1, uploadMbps: 44.3, server: "FRA" } as never }),
    ev({ kind: "quiet", t: t + 3 * HOUR - 14_000, endT: t + 3 * HOUR, targetKey: null, targetLabel: null, method: null, connection: null, detail: { reason: "speedtest" } }),
  ];

  it("CSV: Spalten, Maskierung, BOM über die Datei-Ausgabe, Dezimalkomma bei de, Punkt bei en", () => {
    const r = build({ events: tricky });
    const lines = r.csv.split("\r\n");
    expect(lines[0]).toBe("zeit_lokal;zeit_utc;ende_lokal;art;umfang;ziel;messart;verbindung;wert;einheit;verloren;messungen;ursache;sitzung");
    expect(lines[0].split(";")).toContain("verbindung");
    expect(r.csv.endsWith("\r\n")).toBe(true);
    // Maskierung nach Vertrag: ; und " → in Anführungszeichen, " verdoppelt
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("a;b")).toBe('"a;b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("ok")).toBe("ok");
    expect(r.csv).toContain(';"Server ""A""; Nord";TCP:443;Kabel;12,3;s;;;;42');
    // Formelbeginn wird entschärft
    expect(r.csv).toContain(";\"'=SUMME(1;2)\";");
    // Verlust mit Paketen, WLAN; Dezimalkomma auf Deutsch (deutsches Excel), Trennzeichen bleibt „;“
    expect(r.csv).toContain(";Verlust;;Frankfurt (AWS);TCP:443;WLAN;6,7;%;4;60;;");
    expect(r.csv).toContain(";Speedtest Download;;Cloudflare FRA;;Kabel;452,1;Mbit/s;");
    expect(r.csv).toContain(";Speedtest Upload;;Cloudflare FRA;;Kabel;44,3;Mbit/s;");
    // 1 Kopf + 5 Ereignisse (+1 für den Upload) + leere letzte Zeile
    expect(lines.length).toBe(1 + 6 + 1);
    // BOM: nicht im Text selbst (sonst doppelt), aber in der gespeicherten Datei
    expect(r.csv.charCodeAt(0)).not.toBe(0xfeff);
    const bytes = textBytes(r.csv, true);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const enCsv = build({ events: tricky, lang: "en" }).csv;
    expect(enCsv.split("\r\n")[0]).toBe("time_local;time_utc;end_local;kind;scope;target;method;connection;value;unit;lost;samples;cause;session");
    expect(enCsv).toContain(";Outage;Internet connection;");
    expect(enCsv).toContain(";452.1;Mbit/s;");
    expect(enCsv).toContain(";6.7;%;4;60;;");
  });

  it("CSV: Speedtest 462,8 → de ';462,8;Mbit/s;', en '462.8'", () => {
    const st = ev({ kind: "speedtest", t: t + HOUR, value: 462.8, targetKey: null, targetLabel: null, method: null, detail: { downloadMbps: 462.8, uploadMbps: null, server: "FRA" } as never });
    expect(build({ events: [st] }).csv).toContain(";462,8;Mbit/s;");
    const enCsv = build({ events: [st], lang: "en" }).csv;
    expect(enCsv).toContain(";462.8;Mbit/s;");
    expect(enCsv).not.toContain("462,8");
  });

  it("HTML: Hinweis-Kasten wörtlich (de/en), druckbar, ohne Skripte und externe Quellen", () => {
    for (const lang of ["de", "en"] as const) {
      const dict = lang === "de" ? de : en;
      const r = build({ events: tricky, lang });
      const box = escapeHtml(`${dict.ispLog.bnetza.text} ${dict.ispLog.bnetza.more.replace("{stand}", bnetzaStandText(lang))}`);
      expect(r.html).toContain(box);
      expect(r.html).toContain(escapeHtml(dict.ispLog.bnetza.title));
      expect(r.html).toContain(`lang="${lang}"`);
      expect(r.html).toContain("@media print");
      expect(r.html).toContain("size:A4");
      expect(r.html).not.toMatch(/<script/i);
      expect(r.html).not.toMatch(/<link|<img|<iframe|@import|url\(|src=/i);
      const links = r.html.match(/https?:\/\/[^\s"<)]+/g) ?? [];
      expect(new Set(links)).toEqual(new Set([BNETZA_URL]));
      expect(r.html.match(/<a /g)?.length).toBe(1);
    }
    const deHtml = build({ events: tricky }).html;
    expect(deHtml).toContain("Festnetz-Anschlüsse");
    expect(deHtml).toContain("mit mindestens einem Tag Abstand zwischen den Messtagen");
    expect(deHtml).toContain("Stand: Oktober 2026");
    expect(BNETZA_STAND).toBe("2026-10");
    expect(deHtml).toContain("Pulsar sieht andere Geräte im Haushalt nicht");
    const enHtml = build({ events: tricky, lang: "en" }).html;
    expect(enHtml).toContain("In Germany");
    expect(enHtml).toContain("fixed-line connections");
    expect(enHtml).toContain("at least one day between the measurement days");
    expect(enHtml).toContain("as of October 2026");
  });

  it("HTML: Tagestabelle nur mit Ereignis-Tagen plus „Gesamt“, Ausreißer je Tag nur als Zahl, &nbsp; zwischen Zahl und Einheit", () => {
    const raw = buildIspLog({ events: tricky, truncated: false, summary: [], hourly: [], from: FROM, to: TO, netId: "net-a", contract: defaultIspLog(), lang: "de", timeZone: TZ, now: TO });
    const rows = raw.html.match(/<td class="day">/g)?.length ?? 0;
    // ein Tag mit Ereignissen + Gesamt (statt aller Tage des Zeitraums)
    expect(rows).toBe(2);
    expect(raw.html).toContain('<tr class="total"><td class="day">Gesamt</td>');
    expect(raw.html).toContain("6,7&nbsp;%");
    expect(raw.html).toContain("12&nbsp;s");
    expect(raw.html).not.toMatch(/\d %/);
    const en1 = buildIspLog({ events: tricky, truncated: false, summary: [], hourly: [], from: FROM, to: TO, netId: "net-a", contract: defaultIspLog(), lang: "en", timeZone: TZ, now: TO });
    expect(en1.html).toContain('<td class="day">Total</td>');
  });

  it("Ausreißer: Einzahl für n = 1", () => {
    const tr = translator("en");
    expect(spikeText({ isp: 1 }, tr)).toBe("1 spike – likely home network/Wi-Fi/PC: 0 · line/provider: 1 · internet: 0 · unclear: 0");
    expect(spikeText({ isp: 1, unknown: 1 }, tr)).toContain("2 spikes – of which likely");
    expect(spikeText({ home: 1 }, translator("de"))).toBe("1 Ausreißer – vermutlich Heimnetz/WLAN/PC: 1 · Anschluss/Anbieter: 0 · Internet: 0 · unklar: 0");
  });

  it("die Wörter „Beweis“/„proof“ kommen nicht vor", () => {
    for (const lang of ["de", "en"] as const) {
      const r = build({ events: tricky, lang, truncated: true });
      expect(r.html).not.toMatch(/beweis|proof/i);
      expect(r.csv).not.toMatch(/beweis|proof/i);
    }
    expect(JSON.stringify(de.ispLog)).not.toMatch(/beweis|proof/i);
    expect(JSON.stringify(en.ispLog)).not.toMatch(/beweis|proof/i);
  });

  it("kein MAC-, IPv4- oder SSID-Muster und keine Netz-Kennung im Ergebnis", () => {
    const h = Date.UTC(2026, 9, 24, 18);
    const secret = {
      ssid: "FRITZ!Box 7590 KX",
      bssid: "a4:2b:b0:11:22:33",
      snap: { conn: "wifi", vpn: false, hops: [[1, 1.2, "lan"]], gw: 1.1, gwB: 0.9, tgt: 30, rssi: -60, sig: 70, rx: 1, tx: 0.1, cpu: 10, ip: "192.168.178.1" },
    };
    const events = [
      outage(h, "internet", 5, { targetLabel: "192.168.178.20", netId: "7c41e09b2d5f", detail: { checks: { link: true, gw: true, ext: false }, ...secret } as never }),
      ev({ kind: "slow", t: h + 60_000, endT: h + 120_000, value: 150, targetLabel: "a4:2b:b0:11:22:33", netId: "7c41e09b2d5f", detail: { threshold: 100, minutes: 1, ...secret } as never }),
      ev({ kind: "speedtest", t: h + HOUR, value: 300, targetKey: null, targetLabel: null, method: null, netId: "7c41e09b2d5f", detail: { downloadMbps: 300, uploadMbps: 30, server: "FRA", ...secret } as never }),
    ];
    const hourly = [hourRow(h, { netId: "7c41e09b2d5f", targetKey: "custom-10.0.0.8", label: "10.0.0.8" })];
    for (const lang of ["de", "en"] as const) {
      const r = build({ events, hourly, netId: "7c41e09b2d5f", lang });
      for (const out of [r.html, r.csv]) {
        expect(out).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
        expect(out).not.toMatch(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
        expect(out).not.toContain("FRITZ");
        expect(out).not.toContain("7c41e09b2d5f");
        expect(out).not.toMatch(/ssid/i);
      }
      expect(r.html).toContain((lang === "de" ? de : en).timeline.card.customTarget);
    }
  });

  it("Hinweis „nicht alle Ereignisse geladen“ und Kappung der HTML-Liste", () => {
    expect(build({ events: tricky, truncated: true }).html).toContain("Es wurden nicht alle Ereignisse geladen.");
    expect(build({ events: tricky }).html).not.toContain("nicht alle Ereignisse");
    const many = Array.from({ length: HTML_MAX_ROWS + 5 }, (_, i) => ev({ kind: "loss", t: FROM + i * 60_000, endT: FROM + (i + 1) * 60_000, value: 6, detail: { lost: 4, n: 60 } }));
    const r = build({ events: many });
    expect(r.html).toContain("… und 5 weitere – alle stehen in der CSV.");
    expect(r.csv.trimEnd().split("\r\n").length).toBe(HTML_MAX_ROWS + 5 + 1);
    expect((r.html.match(/<tr>/g) ?? []).length).toBeLessThanOrEqual(HTML_MAX_ROWS + 1 + r.days.length + 10);
  });
});

describe("Texte", () => {
  it("dynamische Schlüssel ispLog.kind.*, ispLog.scope.*, ispLog.conn.* in de und en", () => {
    for (const lang of ["de", "en"] as const) {
      const tr = translator(lang);
      for (const k of EVENT_KINDS) expect(tr(`ispLog.kind.${k}`)).not.toBe(`ispLog.kind.${k}`);
      for (const s of OUTAGE_SCOPES) expect(tr(`ispLog.scope.${s}`)).not.toBe(`ispLog.scope.${s}`);
      for (const c of [...CONNECTION_KINDS, "unknown"]) expect(tr(`ispLog.conn.${c}`)).not.toBe(`ispLog.conn.${c}`);
      for (const r of ["speedtest", "wifiScan"]) expect(tr(`ispLog.quietReason.${r}`)).not.toBe(`ispLog.quietReason.${r}`);
      for (const k of ["date", "internet", "other", "loss", "slow", "spikes", "hours", "speed"]) expect(tr(`ispLog.days.${k}`)).not.toBe(`ispLog.days.${k}`);
      for (const k of ["time", "end", "kind", "scope", "target", "connection", "value"]) expect(tr(`ispLog.list.${k}`)).not.toBe(`ispLog.list.${k}`);
      for (const k of ["icmp", "tcp", "tcp443"]) expect(tr(`ispLog.method.${k}`)).not.toBe(`ispLog.method.${k}`);
      for (const k of ["home", "target", "pc", "unknown"]) expect(tr(`ispLog.days.otherPart.${k}`, { n: 1 })).toContain("1");
      for (let w = 0; w < 7; w++) expect(tr(`calendar.weekday.${w}`)).not.toBe(`calendar.weekday.${w}`);
    }
    expect(translator("en")("ispLog.kind.outage")).toBe("Outage");
  });
});

describe("Demo-Backend", () => {
  const now = Date.now();
  const from = now - 30 * DAY;
  const call = async (cmd: string, a: Record<string, unknown>) => isplogMock[cmd](a);

  it("30 Tage: 4 Aussetzer, 9 Verlust-Fenster, 12 langsame Minuten, 40 Ausreißer, 6 Speedtests", async () => {
    const page = (await call("net_events_list", { from, to: now, limit: 20000 })) as { events: NetEvent[]; truncated: boolean };
    const of = (k: string) => page.events.filter((e) => e.kind === k);
    expect(page.truncated).toBe(false);
    expect(of("outage").map((e) => e.scope).sort()).toEqual(["homeNetwork", "internet", "internet", "pc"]);
    expect(of("loss")).toHaveLength(9);
    expect(of("slow").reduce((a, e) => a + ((e.detail as { minutes: number }).minutes ?? 0), 0)).toBe(12);
    expect(of("spike")).toHaveLength(40);
    expect(new Set(of("spike").map((e) => e.cause))).toEqual(new Set(LAG_CAUSES));
    expect(of("speedtest")).toHaveLength(6);
    for (const s of of("speedtest")) expect(s.value).toBeGreaterThanOrEqual(410), expect(s.value).toBeLessThanOrEqual(470);
    expect(page.events.every((e) => e.netId === DEMO_NET_ID && e.t <= now)).toBe(true);
    // Zählungen ohne Grenze
    const summary = (await call("net_events_summary", { from, to: now })) as EventSummaryRow[];
    expect(summary.filter((r) => r.kind === "spike").reduce((a, r) => a + r.countSum, 0)).toBe(40);
    expect(summarize(page.events)).toEqual(summary);
    // Filter, Grenze, Zeitraum, Bereich
    const only = (await call("net_events_list", { from, to: now, kinds: ["outage", "nope"], limit: 2 })) as { events: NetEvent[]; truncated: boolean };
    expect(only.events.map((e) => e.kind)).toEqual(["outage", "outage"]);
    expect(only.truncated).toBe(true);
    expect(((await call("net_events_list", { from, to: now, kinds: ["nope"] })) as { events: NetEvent[] }).events).toEqual([]);
    expect(((await call("net_events_list", { from, to: now, netId: "andere" })) as { events: NetEvent[] }).events).toEqual([]);
    await expect(call("net_events_list", { from: now, to: from })).rejects.toThrow("Ungültiger Zeitraum.");
    await expect(call("net_history_clear", { scope: "x" })).rejects.toThrow("Unbekannter Bereich.");
  });

  it("Bericht aus den Demo-Daten: Vertragsprozent bei 500 Mbit/s, Netz per Kabel", () => {
    const events = demoIspEvents(now).filter((e) => e.kind !== "spike" && e.t >= from);
    const summary = summarize(demoIspEvents(now).filter((e) => e.t >= from));
    const hourly = demoHourlyRows(from, now, { now });
    const r = buildIspLog({ events, truncated: false, summary, hourly, from, to: now, netId: DEMO_NET_ID, contract: { ...defaultIspLog(), contractDownMbps: 500 }, lang: "de", timeZone: TZ, now });
    expect(r.totals.internetOutages).toBe(2);
    expect(r.totals.otherOutages).toBe(2);
    expect(r.totals.lossWindows).toBe(9);
    expect(r.totals.slowMinutes).toBe(12);
    expect(r.totals.speedtests).toBe(6);
    expect(Object.values(r.totals.spikesByCause).reduce((a, n) => a + (n ?? 0), 0)).toBe(40);
    expect(r.header.hours).toBeGreaterThan(20);
    expect(r.header.targets[0]).toMatchObject({ key: "aws-eu-central-1", methodText: "TCP:443" });
    const pcts = r.rows.filter((x) => x.kind === "speedtest").map((x) => Number(/(\d+) % der eingetragenen/.exec(x.text)?.[1]));
    expect(pcts.every((p) => p >= 82 && p <= 94)).toBe(true);
    // Alle Ereignisse liegen in gemessenen Stunden
    const measured = new Set(hourly.map((h) => h.hourStart));
    expect(events.filter((e) => e.kind !== "quiet").every((e) => measured.has(Math.floor(e.t / HOUR) * HOUR))).toBe(true);
  });
});
