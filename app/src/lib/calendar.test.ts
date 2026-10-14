import { describe, expect, it } from "vitest";
import { de } from "../locales/de";
import { en } from "../locales/en";
import {
  adviceTexts,
  basisText,
  calendarModel,
  cellGrade,
  cellIndex,
  defaultFilter,
  filterRows,
  MEASURED_HOUR_MS,
  netOptions,
  reconcileFilter,
  targetOptions,
  type Translate,
} from "./calendar";
import { DEMO_MAIN, DEMO_NET_ID, DEMO_SECOND, demoHourlyRows } from "./mock/calendar";
import type { ConnectionKind, HourlyRow } from "./types";

const BERLIN = "Europe/Berlin";
const H = 3_600_000;
const DAY = 86_400_000;

/** Montag, 5. Januar 2026 (Winterzeit, UTC+1) */
const MONDAY = Date.UTC(2026, 0, 5);
/** UTC-Stundenbeginn für Ortszeit Berlin: Woche `week`, Wochentag `wd` (Mo = 0), Stunde `hour` (bis Ende März UTC+1) */
const at = (week: number, wd: number, hour: number) => MONDAY + (week * 7 + wd) * DAY + (hour - 1) * H;

interface Shape {
  avg?: number;
  jitter?: number;
  loss?: number;
  spikeRate?: number;
  covered?: number;
  n?: number;
}
function mk(hourStart: number, s: Shape = {}, extra: Partial<HourlyRow> = {}): HourlyRow {
  const n = s.n ?? 1000;
  const lost = Math.round(n * (s.loss ?? 0));
  const answers = n - lost;
  const avg = s.avg ?? 25;
  return {
    hourStart,
    targetKey: "aws-eu-central-1",
    netId: "net-a",
    connection: "ethernet",
    kind: "region",
    label: "Frankfurt",
    method: "icmp",
    n,
    lost,
    sumRtt: answers * avg,
    sumJitter: (answers - 1) * (s.jitter ?? 1),
    nJitter: answers - 1,
    maxRtt: avg * 2,
    spikes: Math.round(answers * (s.spikeRate ?? 0)),
    coveredMs: s.covered ?? H,
    ...extra,
  };
}

const lookup = (dict: unknown, key: string): string | undefined => {
  let cur: unknown = dict;
  for (const p of key.split(".")) {
    if (cur && typeof cur === "object" && p in (cur as object)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return typeof cur === "string" ? cur : undefined;
};
const translator =
  (dict: unknown): Translate =>
  (key, vars) =>
    (lookup(dict, key) ?? `«${key}»`).replace(/\{(\w+)\}/g, (_, k: string) => (vars && k in vars ? String(vars[k]) : `{${k}}`));
const tDe = translator(de);
const tEn = translator(en);

/**
 * Grund-Szenario mit genug Daten: Mo und Di je 16–21 Uhr (12 Fächer) in 3 Wochen (6 Tage, 36 h) plus
 * eine Stunde am Sonntag (7. Tag). Mo 16–18 ruhig (A+), Di 20–22 deutlich schlechter (B), sonst A.
 */
function scenario(opts: { mon16?: number; tue20?: Shape; others?: number; covered?: number; extraCovered?: number; dropTue16?: boolean; withSunday?: boolean } = {}): HourlyRow[] {
  const rows: HourlyRow[] = [];
  for (const wd of [0, 1]) {
    for (let h = 16; h <= 21; h++) {
      for (let w = 0; w < 3; w++) {
        if (opts.dropTue16 && wd === 1 && h === 16 && w > 0) continue;
        let s: Shape = { avg: opts.others ?? 25 };
        if (wd === 0 && (h === 16 || h === 17)) s = { avg: opts.mon16 ?? 15 };
        if (wd === 1 && (h === 20 || h === 21)) s = opts.tue20 ?? { avg: 50 };
        rows.push(mk(at(w, wd, h), { jitter: 1, ...s, covered: opts.covered ?? H }));
      }
    }
  }
  if (opts.withSunday !== false) rows.push(mk(at(0, 6, 12), { avg: 25, covered: opts.extraCovered ?? H }));
  return rows;
}

describe("Fächer in Ortszeit", () => {
  it("Wochentag und Stunde in Ortszeit (Montag = 0)", () => {
    // 19:00 UTC am Montag = 20 Uhr in Berlin
    const m = calendarModel([mk(Date.UTC(2026, 0, 5, 19))], BERLIN);
    const filled = m.cells.filter((c) => c.n > 0);
    expect(filled).toHaveLength(1);
    expect([filled[0].weekday, filled[0].hour]).toEqual([0, 20]);
    expect(m.cells[cellIndex(0, 20)]).toBe(filled[0]);
    // Sonntag 23:00 UTC = Montag 0 Uhr Ortszeit
    const m2 = calendarModel([mk(Date.UTC(2026, 0, 4, 23))], BERLIN);
    expect(m2.cells[cellIndex(0, 0)].n).toBe(1000);
    // dieselbe Zeile in UTC: Sonntag 23 Uhr
    expect(calendarModel([mk(Date.UTC(2026, 0, 4, 23))], "UTC").cells[cellIndex(6, 23)].n).toBe(1000);
  });

  it("Gewichtung über Rohsummen (nicht Mittel der Mittel)", () => {
    const rows = [mk(at(0, 0, 20), { avg: 10, n: 100 }), mk(at(1, 0, 20), { avg: 30, n: 300, loss: 0.1 })];
    const c = calendarModel(rows, BERLIN).cells[cellIndex(0, 20)];
    expect(c.n).toBe(400);
    expect(c.lost).toBe(30);
    // (100·10 + 270·30) / 370
    expect(c.avg).toBeCloseTo((100 * 10 + 270 * 30) / 370, 9);
    expect(c.loss).toBeCloseTo(30 / 400, 9);
    expect(c.jitter).toBeCloseTo(1, 9);
    expect(c.covered).toBe(2 * H);
  });

  it("Ausreißerquote über 2 % kostet eine Note, F bleibt F", () => {
    expect(cellGrade(15, 1, 0, 0.02)).toBe("A+");
    expect(cellGrade(15, 1, 0, 0.021)).toBe("A");
    expect(cellGrade(50, 1, 0, 0.05)).toBe("C");
    expect(cellGrade(250, 1, 0, 0.5)).toBe("F");
    expect(cellGrade(null, null, 1, 0.5)).toBeNull();
    const rows = [mk(at(0, 0, 20), { avg: 15, spikeRate: 0.03 })];
    expect(calendarModel(rows, BERLIN).cells[cellIndex(0, 20)].grade).toBe("A");
  });

  it("Messstunde ab 30:00 min (29:59 zählt nicht)", () => {
    const short = MEASURED_HOUR_MS - 1000;
    const thin = calendarModel([mk(at(0, 0, 20), { covered: short }), mk(at(1, 0, 20), { covered: short })], BERLIN);
    expect(thin.cells[cellIndex(0, 20)].days).toBe(0);
    expect(thin.cells[cellIndex(0, 20)].valid).toBe(false);
    expect(thin.basis.days).toBe(0);
    const ok = calendarModel([mk(at(0, 0, 20), { covered: MEASURED_HOUR_MS }), mk(at(1, 0, 20), { covered: MEASURED_HOUR_MS })], BERLIN);
    expect(ok.cells[cellIndex(0, 20)].days).toBe(2);
    expect(ok.cells[cellIndex(0, 20)].valid).toBe(true);
  });

  it("Stundengruppe: Kabel und WLAN derselben Stunde zählen zusammen als eine Messstunde", () => {
    const rows = [mk(at(0, 0, 20), { covered: 20 * 60_000 }), mk(at(0, 0, 20), { covered: 15 * 60_000 }, { connection: "wifi" })];
    expect(calendarModel(rows, BERLIN).basis.days).toBe(1);
  });

  it("gültig ab 2 Messstunden an 2 Tagen, empfehlbar ab 3 Tagen", () => {
    const one = calendarModel([mk(at(0, 0, 20))], BERLIN).cells[cellIndex(0, 20)];
    expect([one.valid, one.recommendable]).toEqual([false, false]);
    const two = calendarModel([mk(at(0, 0, 20)), mk(at(1, 0, 20))], BERLIN).cells[cellIndex(0, 20)];
    expect([two.valid, two.recommendable, two.days]).toEqual([true, false, 2]);
    const three = calendarModel([mk(at(0, 0, 20)), mk(at(1, 0, 20)), mk(at(2, 0, 20))], BERLIN).cells[cellIndex(0, 20)];
    expect([three.valid, three.recommendable, three.days]).toEqual([true, true, 3]);
  });

  it("2 Messstunden am selben Tag (Zeitumstellung, Stunde 2 doppelt) sind nicht gültig", () => {
    // 25.10.2026: 00:00 und 01:00 UTC sind beide 2 Uhr Ortszeit
    const rows = [mk(Date.UTC(2026, 9, 25, 0)), mk(Date.UTC(2026, 9, 25, 1))];
    const c = calendarModel(rows, BERLIN).cells[cellIndex(6, 2)];
    expect(c.n).toBe(2000);
    expect(c.days).toBe(1);
    expect(c.valid).toBe(false);
  });

  it("leere Fächer haben keine Note", () => {
    const m = calendarModel([], BERLIN);
    expect(m.cells).toHaveLength(168);
    expect(m.cells.every((c) => c.grade === null && !c.valid && c.avg === null)).toBe(true);
    expect(m.advice).toEqual({ kind: "tooLittle", hours: 0, days: 0 });
  });
});

describe("Empfehlung: Mindestbasis", () => {
  it("Grund-Szenario nennt die ruhigste und die schlechteste Zeit", () => {
    const m = calendarModel(scenario(), BERLIN);
    expect(m.basis).toEqual({ coveredMs: 37 * H, hours: 37, days: 7 });
    expect(m.validCells).toBe(12);
    expect(m.advice.kind).toBe("best");
    if (m.advice.kind !== "best") return;
    expect([m.advice.best.weekday, m.advice.best.hour, m.advice.best.days]).toEqual([0, 16, 3]);
    expect(m.advice.best.grade).toBe("A+");
    expect(m.advice.best.avg).toBeCloseTo(15, 9);
    expect([m.advice.worst.weekday, m.advice.worst.hour]).toEqual([1, 20]);
  });

  it("19,9 h → zu wenig, 20 h → Empfehlung", () => {
    // 36 Stunden zu je 1 900 000 ms (> 30 min) = 19 h, dazu der Sonntag
    const low = calendarModel(scenario({ covered: 1_900_000, extraCovered: 19.9 * H - 36 * 1_900_000 }), BERLIN);
    expect(low.basis.hours).toBe(19.9);
    expect(low.advice).toEqual({ kind: "tooLittle", hours: 19.9, days: 7 });
    const ok = calendarModel(scenario({ covered: 1_900_000, extraCovered: 20 * H - 36 * 1_900_000 }), BERLIN);
    expect(ok.basis.hours).toBe(20);
    expect(ok.advice.kind).toBe("best");
  });

  it("6 Tage → zu wenig, 7 Tage → Empfehlung", () => {
    const six = calendarModel(scenario({ withSunday: false }), BERLIN);
    expect(six.basis.days).toBe(6);
    expect(six.advice.kind).toBe("tooLittle");
    expect(calendarModel(scenario(), BERLIN).basis.days).toBe(7);
  });

  it("11 gültige Fächer → zu wenig, 12 → Empfehlung", () => {
    const eleven = calendarModel(scenario({ dropTue16: true }), BERLIN);
    expect(eleven.validCells).toBe(11);
    expect(eleven.advice.kind).toBe("tooLittle");
    expect(calendarModel(scenario(), BERLIN).validCells).toBe(12);
  });
});

describe("Empfehlung: Mindestunterschied und Gleichstand", () => {
  it("gleiche Note überall → kein deutlicher Unterschied", () => {
    const m = calendarModel(scenario({ mon16: 21, tue20: { avg: 34 }, others: 28 }), BERLIN);
    expect(m.advice).toEqual({ kind: "noDifference" });
  });

  it("eine Notenstufe, aber nur 9 ms → kein deutlicher Unterschied; 10 ms → Empfehlung", () => {
    const nine = calendarModel(scenario({ mon16: 30, tue20: { avg: 39 }, others: 32 }), BERLIN);
    expect(nine.blocks?.best.grade).toBe("A");
    expect(nine.blocks?.worst.grade).toBe("B");
    expect(nine.advice.kind).toBe("noDifference");
    const ten = calendarModel(scenario({ mon16: 30, tue20: { avg: 40 }, others: 32 }), BERLIN);
    expect(ten.advice.kind).toBe("best");
  });

  it("eine Notenstufe und 1 Prozentpunkt mehr Ausreißer reicht auch ohne 10 ms", () => {
    // 36 ms + 3 % Ausreißer: Note B → C; Ø-Abstand nur 6 ms
    const m = calendarModel(scenario({ mon16: 30, tue20: { avg: 36, spikeRate: 0.03 }, others: 32 }), BERLIN);
    expect(m.advice.kind).toBe("best");
  });

  it("Gleichstand: kleinerer Ø-Ping gewinnt, dann die frühere Zeit", () => {
    const rows = scenario();
    // Di 16–18 genauso gut (A+) wie Mo 16–18
    const tied = rows.map((r) => (r.hourStart % (7 * DAY) === at(0, 1, 16) % (7 * DAY) || r.hourStart % (7 * DAY) === at(0, 1, 17) % (7 * DAY) ? mk(r.hourStart, { avg: 15, jitter: 1 }) : r));
    const m = calendarModel(tied, BERLIN);
    expect(m.advice.kind === "best" && [m.advice.best.weekday, m.advice.best.hour]).toEqual([0, 16]);
    const better = rows.map((r) => (r.hourStart % (7 * DAY) === at(0, 1, 16) % (7 * DAY) || r.hourStart % (7 * DAY) === at(0, 1, 17) % (7 * DAY) ? mk(r.hourStart, { avg: 14, jitter: 1 }) : r));
    const m2 = calendarModel(better, BERLIN);
    expect(m2.advice.kind === "best" && [m2.advice.best.weekday, m2.advice.best.hour]).toEqual([1, 16]);
  });

  it("Blöcke nur am selben Wochentag (nicht über Mitternacht)", () => {
    const rows: HourlyRow[] = [];
    for (let w = 0; w < 3; w++) {
      rows.push(mk(at(w, 0, 23)), mk(at(w, 1, 0)));
    }
    expect(calendarModel(rows, BERLIN).blocks).toBeNull();
  });
});

describe("Filter: Ziel, Netz, Verbindungsart", () => {
  const conn = (c: ConnectionKind, extra: Partial<HourlyRow> = {}, covered = H) => mk(at(0, 0, 20), { covered }, { connection: c, ...extra });
  const rows = [
    conn("ethernet"),
    conn("wifi"),
    conn("vpn"),
    conn("other"),
    conn("ethernet", { netId: "net-b" }, 3 * H),
    conn("ethernet", { targetKey: "valve-cs2-fra", kind: "server", label: "CS2" }, 10 * H),
  ];

  it("Verbindungsart: Standard alle außer VPN, sonst nur Kabel bzw. nur WLAN", () => {
    const base = { targetKey: "aws-eu-central-1", netId: "net-a" };
    expect(filterRows(rows, { ...base, connection: "noVpn" }).map((r) => r.connection)).toEqual(["ethernet", "wifi", "other"]);
    expect(filterRows(rows, { ...base, connection: "ethernet" }).map((r) => r.connection)).toEqual(["ethernet"]);
    expect(filterRows(rows, { ...base, connection: "wifi" }).map((r) => r.connection)).toEqual(["wifi"]);
  });

  it("Ziele und Netze werden nie gemischt; Standard = meiste Messzeit", () => {
    expect(targetOptions(rows).map((o) => [o.key, o.coveredMs])).toEqual([
      ["valve-cs2-fra", 10 * H],
      ["aws-eu-central-1", 7 * H],
    ]);
    const f = defaultFilter(rows);
    expect(f).toEqual({ targetKey: "valve-cs2-fra", netId: "net-a", connection: "noVpn" });
    const aws = netOptions(rows, "aws-eu-central-1");
    // Nummer nach Messzeit über alle Ziele: net-a 14 h → Netz 1, net-b 3 h → Netz 2
    expect(aws.map((o) => [o.netId, o.index, o.coveredMs])).toEqual([
      ["net-a", 1, 4 * H],
      ["net-b", 2, 3 * H],
    ]);
    const only = filterRows(rows, { targetKey: "aws-eu-central-1", netId: "net-b", connection: "noVpn" });
    expect(only).toHaveLength(1);
  });

  it("unbekanntes Netz bekommt keine Nummer; VPN zählt nicht für den Standard", () => {
    const r = [mk(at(0, 0, 20), { covered: 9 * H }, { netId: "", connection: "vpn" }), mk(at(0, 0, 20), { covered: H }, { netId: "net-x" })];
    expect(netOptions(r).find((o) => o.netId === "")?.index).toBe(0);
    expect(defaultFilter(r).netId).toBe("net-x");
  });

  it("gewählter Filter bleibt, wenn es Ziel und Netz noch gibt", () => {
    expect(reconcileFilter(rows, { targetKey: "aws-eu-central-1", netId: "net-b", connection: "wifi" })).toEqual({ targetKey: "aws-eu-central-1", netId: "net-b", connection: "wifi" });
    expect(reconcileFilter(rows, { targetKey: "weg", netId: "net-b", connection: "ethernet" })).toEqual({ targetKey: "valve-cs2-fra", netId: "net-a", connection: "ethernet" });
    expect(reconcileFilter([], { targetKey: "x", netId: "y", connection: "noVpn" })).toEqual({ targetKey: null, netId: null, connection: "noVpn" });
  });
});

describe("Texte", () => {
  it("Empfehlung ehrlich formuliert (bisher, keine Vorhersage)", () => {
    const m = calendarModel(scenario(), BERLIN);
    const d = adviceTexts(m, tDe, "de");
    expect(d.title).toBe("Bisher am ruhigsten: Mo 16–18 Uhr (Ø 15 ms, an 3 Montagen gemessen)");
    expect(d.sub).toBe("bisher am ruhigsten gemessen – keine Vorhersage");
    expect(d.worst).toBe("Eher meiden: Di 20–22 Uhr (Ø 50 ms, an 3 Dienstagen gemessen)");
    const e = adviceTexts(m, tEn, "en");
    expect(e.title).toBe("Calmest so far: Mon 16:00–18:00 (avg 15 ms, measured on 3 Mondays)");
    expect(e.sub).toContain("not a forecast");
  });

  it("zu wenig Daten / kein deutlicher Unterschied / Datenbasis", () => {
    const few = calendarModel(scenario({ withSunday: false, covered: 1_900_000 }), BERLIN);
    expect(adviceTexts(few, tDe, "de").title).toBe("Zu wenig Daten für eine Empfehlung – bisher 19,0 Stunden Messzeit an 6 Tagen.");
    expect(adviceTexts(few, tEn, "en").title).toBe("Not enough data for a recommendation – so far 19.0 hours of measuring on 6 days.");
    const same = calendarModel(scenario({ mon16: 21, tue20: { avg: 34 }, others: 28 }), BERLIN);
    expect(adviceTexts(same, tDe, "de").title).toBe("Kein deutlicher Unterschied – zu jeder gemessenen Zeit ähnlich.");
    expect(basisText({ coveredMs: 0, hours: 12.3, days: 4 }, tDe, "de")).toBe("12,3 Stunden Messzeit an 4 Tagen");
    expect(basisText({ coveredMs: 0, hours: 1, days: 1 }, tDe, "de")).toBe("1,0 Stunden Messzeit an 1 Tag");
    expect(basisText({ coveredMs: 0, hours: 1, days: 1 }, tEn, "en")).toBe("1.0 hours of measuring on 1 day");
  });

  it("Basis erfüllt, aber kein Block aus 2 empfehlbaren Stunden → eigener ehrlicher Satz", () => {
    // 12 gültige Fächer mit je 3 Tagen, aber nie zwei Stunden hintereinander
    const rows: HourlyRow[] = [];
    for (const wd of [0, 1, 2]) for (const h of [8, 10, 12, 14]) for (let w = 0; w < 3; w++) rows.push(mk(at(w, wd, h)));
    const m = calendarModel(rows, BERLIN);
    expect(m.validCells).toBe(12);
    expect(m.advice.kind).toBe("tooLittle");
    expect(adviceTexts(m, tDe, "de").title).toContain("keine zwei aufeinanderfolgenden Stunden");
  });

  it("alle dynamischen Schlüssel (Wochentage, Verbindungsart, Zielart) gibt es in de und en", () => {
    const keys = [
      ...[0, 1, 2, 3, 4, 5, 6].flatMap((d) => [`calendar.weekday.${d}`, `calendar.weekdayPlural.${d}`]),
      ...["noVpn", "ethernet", "wifi"].map((c) => `calendar.conn.${c}`),
      ...["region", "server", "other"].map((k) => `calendar.kind.${k}`),
    ];
    for (const k of keys) {
      expect(lookup(de, k), k).toBeTypeOf("string");
      expect(lookup(en, k), k).toBeTypeOf("string");
    }
  });
});

describe("Demo-Daten", () => {
  it("ergeben stabil eine Empfehlung (Di 17–19 ruhig, Fr 20–22 eher meiden) – an jedem Tag", () => {
    // 21 verschiedene „heute“, über Sommer- und Winterzeit verteilt
    for (let i = 0; i < 21; i++) {
      const now = Date.UTC(2026, 0, 3, 9, 17) + i * 17 * DAY + i * 3_100_000;
      const rows = demoHourlyRows(now - 90 * DAY, now, { now, timeZone: BERLIN });
      expect(rows.length).toBeGreaterThan(300);
      const f = defaultFilter(rows);
      expect(f).toEqual({ targetKey: DEMO_MAIN.key, netId: DEMO_NET_ID, connection: "noVpn" });
      const m = calendarModel(filterRows(rows, f), BERLIN);
      expect(m.advice.kind, new Date(now).toISOString()).toBe("best");
      if (m.advice.kind !== "best") continue;
      expect([m.advice.best.weekday, m.advice.best.hour]).toEqual([1, 17]);
      expect([m.advice.worst.weekday, m.advice.worst.hour]).toEqual([4, 20]);
      // Zweites Ziel: nur 3 Tage → zu wenig Daten
      const second = calendarModel(filterRows(rows, { targetKey: DEMO_SECOND.key, netId: DEMO_NET_ID, connection: "noVpn" }), BERLIN);
      expect(second.advice.kind).toBe("tooLittle");
      expect(second.basis.days).toBeLessThanOrEqual(3);
    }
  });

  it("auch im 30-Tage-Zeitraum, mit Lücken nachts und dünnen Fächern mittags", () => {
    const now = Date.UTC(2026, 9, 14, 12, 0);
    const rows = demoHourlyRows(now - 30 * DAY, now, { now, timeZone: BERLIN });
    const m = calendarModel(filterRows(rows, defaultFilter(rows)), BERLIN);
    expect(m.advice.kind).toBe("best");
    expect(m.cells[cellIndex(2, 3)].n).toBe(0);
    expect(m.cells.some((c) => c.n > 0 && !c.valid)).toBe(true);
    // gleiche Eingaben → gleiche Zeilen
    expect(demoHourlyRows(now - 30 * DAY, now, { now, timeZone: BERLIN })).toEqual(rows);
    // nur abgeschlossene Stunden
    expect(rows.every((r) => r.hourStart + H <= now)).toBe(true);
  });

  it("rund 8 % der Messzeit per WLAN im selben Netz (Demo des Anbieter-Protokolls)", () => {
    for (let i = 0; i < 6; i++) {
      const now = Date.UTC(2026, 2, 1, 10, 0) + i * 41 * DAY;
      const rows = demoHourlyRows(now - 30 * DAY, now, { now, timeZone: BERLIN }).filter((r) => r.targetKey === DEMO_MAIN.key);
      const total = rows.reduce((a, r) => a + r.coveredMs, 0);
      const wifi = rows.filter((r) => r.connection === "wifi").reduce((a, r) => a + r.coveredMs, 0);
      expect(rows.every((r) => r.netId === DEMO_NET_ID && (r.connection === "wifi" || r.connection === "ethernet"))).toBe(true);
      expect(wifi / total).toBeGreaterThan(0.06);
      expect(wifi / total).toBeLessThan(0.11);
    }
  });
});
