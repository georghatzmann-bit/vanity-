/**
 * Demo-Backend: Anbieter-Protokoll (`net_events_list`, `net_events_summary`, `net_history_clear`,
 * Protokollierung der Demo-Speedtests über `onSpeedtest`). Vertrag: docs/API.md, „Anbieter-Protokoll“ (Demo).
 *
 * 30 Tage feste Ereignisse, abgeleitet aus (Tage zurück, lokale Stunde, Seed 1337) – unabhängig vom
 * Tag, an dem die Demo läuft: im Demo-Netz per Kabel 4 Aussetzer (2 `internet`, 1 `homeNetwork`,
 * 1 `pc`), 9 Verlust-Fenster, 12 langsame Minuten, 40 Ausreißer (gemischte Ursachen inkl. `unknown`)
 * und 6 Speedtests mit 410–470 Mbit/s (passend zur Demo-Einstellung `ispLog.contractDownMbps = 500`).
 * Alle Ereignisse liegen abends (17–22 Uhr), also in Stunden, die der Kalender-Generator
 * (`demoHourlyRows`) als gemessen führt. `net_history_clear` merkt sich den Zeitpunkt in
 * localStorage – ältere Demo-Ereignisse gelten danach als gelöscht.
 */
import { zoned } from "../isplog";
import { defaultTimeZone, localParts } from "../localtime";
import type { ConnectionKind, EventKind, EventSummaryRow, LagCause, NetEvent, OutageScope, SpeedResult } from "../types";
import { DEMO_MAIN, DEMO_NET_ID, demoShape } from "./calendar";
import { onSpeedtest, type MockHandlers } from "./core";

const SEED = 1337;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 400 * DAY_MS;
const KINDS: EventKind[] = ["outage", "loss", "slow", "spike", "speedtest", "quiet"];
/** localStorage: Zeitpunkt von „Messverlauf löschen“ bzw. protokollierte Demo-Speedtests */
const CLEARED_KEY = "pulsar.demo.history.clearedAt";
const LOGGED_KEY = "pulsar.demo.isplog.speedtests";

/** Deterministischer Wert 0–1 aus ganzen Zahlen (kein gemeinsamer Zufallszustand) */
function hash(...parts: number[]): number {
  let h = SEED ^ 0x2545f491;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

/** Zeitpunkt „vor `ago` Tagen um hh:mm:ss Ortszeit“ */
function at(now: number, tz: string, ago: number, hour: number, minute: number, second = 0): number {
  const base = now - ago * DAY_MS;
  const z = zoned(base, tz);
  const midnight = base - ((z.hour * 60 + z.minute) * 60 + z.second) * 1000 - (base % 1000);
  return midnight + ((hour * 60 + minute) * 60 + second) * 1000;
}

/** Abends 17–22 Uhr misst der Kalender-Generator immer – sonst auf 20 Uhr ausweichen */
function measuredHour(now: number, tz: string, ago: number, hour: number): number {
  const p = localParts(now - ago * DAY_MS, tz);
  return demoShape(p.weekday, hour) ? hour : 20;
}

interface Spec {
  ago: number;
  hour: number;
  minute: number;
}
const OUTAGES: (Spec & { s: number; scope: OutageScope; checks: { link: boolean | null; gw: boolean | null; ext: boolean | null } })[] = [
  { ago: 3, hour: 21, minute: 14, s: 48, scope: "internet", checks: { link: true, gw: true, ext: false } },
  { ago: 7, hour: 19, minute: 5, s: 12, scope: "homeNetwork", checks: { link: true, gw: false, ext: false } },
  { ago: 11, hour: 20, minute: 37, s: 95, scope: "internet", checks: { link: true, gw: true, ext: false } },
  { ago: 18, hour: 22, minute: 41, s: 26, scope: "pc", checks: { link: false, gw: null, ext: null } },
];
const LOSSES: (Spec & { lost: number; n: number })[] = [
  { ago: 2, hour: 21, minute: 3, lost: 4, n: 60 },
  { ago: 3, hour: 20, minute: 48, lost: 3, n: 60 },
  { ago: 6, hour: 21, minute: 22, lost: 5, n: 60 },
  { ago: 9, hour: 21, minute: 9, lost: 7, n: 60 },
  { ago: 10, hour: 20, minute: 15, lost: 4, n: 58 },
  { ago: 13, hour: 21, minute: 41, lost: 6, n: 60 },
  { ago: 17, hour: 20, minute: 30, lost: 4, n: 60 },
  { ago: 20, hour: 21, minute: 52, lost: 9, n: 60 },
  { ago: 24, hour: 19, minute: 33, lost: 4, n: 59 },
];
/** zusammen 12 langsame Minuten */
const SLOWS: (Spec & { minutes: number; ms: number })[] = [
  { ago: 4, hour: 20, minute: 10, minutes: 3, ms: 142 },
  { ago: 9, hour: 21, minute: 2, minutes: 2, ms: 131 },
  { ago: 14, hour: 20, minute: 45, minutes: 4, ms: 168 },
  { ago: 21, hour: 21, minute: 30, minutes: 1, ms: 118 },
  { ago: 27, hour: 19, minute: 50, minutes: 2, ms: 125 },
];
const SPEEDTESTS: (Spec & { down: number; up: number })[] = [
  { ago: 1, hour: 18, minute: 12, down: 468.4, up: 47.9 },
  { ago: 5, hour: 19, minute: 41, down: 441.7, up: 45.2 },
  { ago: 8, hour: 21, minute: 6, down: 412.3, up: 41.8 },
  { ago: 12, hour: 18, minute: 55, down: 455.0, up: 48.6 },
  { ago: 19, hour: 20, minute: 20, down: 429.6, up: 43.1 },
  { ago: 26, hour: 17, minute: 34, down: 462.8, up: 46.4 },
];
/** 40 Ausreißer: Ursachen gemischt (inkl. unklar) */
const SPIKE_CAUSES: LagCause[] = [...Array(6).fill("wifi"), ...Array(4).fill("router"), ...Array(5).fill("localTraffic"), ...Array(9).fill("isp"), ...Array(7).fill("internet"), ...Array(9).fill("unknown")];

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
function readNumber(key: string): number {
  try {
    const v = Number(storage()?.getItem(key) ?? "");
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
function readLogged(): SpeedResult[] {
  try {
    const raw = storage()?.getItem(LOGGED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as SpeedResult[]).filter((r) => r && typeof r.at === "number" && typeof r.downloadMbps === "number") : [];
  } catch {
    return [];
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch {
    // Demo ohne Speicher (z. B. privater Modus): nur nicht merken
  }
}

function base(kind: EventKind, t: number): NetEvent {
  const measured = kind !== "speedtest" && kind !== "quiet";
  return {
    id: 0,
    t,
    endT: null,
    kind,
    targetKey: measured ? DEMO_MAIN.key : null,
    targetLabel: measured ? DEMO_MAIN.label : null,
    method: measured ? DEMO_MAIN.method : null,
    netId: DEMO_NET_ID,
    connection: "ethernet",
    value: null,
    cause: null,
    scope: null,
    sessionId: null,
    detail: null,
  };
}

function speedEvents(t: number, r: Pick<SpeedResult, "downloadMbps" | "uploadMbps"> & Partial<SpeedResult>, connection: ConnectionKind): NetEvent[] {
  const result: SpeedResult = {
    downloadMbps: r.downloadMbps,
    uploadMbps: r.uploadMbps,
    idleLatencyMs: r.idleLatencyMs ?? 9.6,
    idleJitterMs: r.idleJitterMs ?? 1.1,
    loadedLatencyDownMs: r.loadedLatencyDownMs ?? 31.5,
    loadedLatencyUpMs: r.loadedLatencyUpMs ?? 44.2,
    bufferbloatMs: r.bufferbloatMs ?? 34.6,
    grade: r.grade ?? "B",
    server: r.server ?? "FRA",
    at: t,
  };
  const quiet: NetEvent = { ...base("quiet", t - 14_000), endT: t, connection: null, detail: { reason: "speedtest" } };
  const st: NetEvent = { ...base("speedtest", t), value: Math.round(r.downloadMbps * 10) / 10, detail: { ...result, connection, localMbps: 0.4 } };
  return [quiet, st];
}

/** Alle Demo-Ereignisse bis `now` (nach Zeit sortiert, mit laufender Nummer). */
export function demoIspEvents(now: number = Date.now(), timeZone: string = defaultTimeZone()): NetEvent[] {
  const tz = timeZone;
  const out: NetEvent[] = [];
  for (const o of OUTAGES) {
    const t = at(now, tz, o.ago, measuredHour(now, tz, o.ago, o.hour), o.minute, 7);
    out.push({ ...base("outage", t), endT: t + o.s * 1000, value: o.s, scope: o.scope, detail: { checks: o.checks } });
  }
  for (const l of LOSSES) {
    const end = at(now, tz, l.ago, measuredHour(now, tz, l.ago, l.hour), l.minute);
    out.push({ ...base("loss", end - MIN_MS), endT: end, value: Math.round((l.lost / l.n) * 1000) / 10, detail: { lost: l.lost, n: l.n } });
  }
  for (const s of SLOWS) {
    const t = at(now, tz, s.ago, measuredHour(now, tz, s.ago, s.hour), s.minute);
    out.push({ ...base("slow", t), endT: t + s.minutes * MIN_MS, value: s.ms, detail: { threshold: 100, minutes: s.minutes } });
  }
  for (const s of SPEEDTESTS) {
    out.push(...speedEvents(at(now, tz, s.ago, measuredHour(now, tz, s.ago, s.hour), s.minute, 30), { downloadMbps: s.down, uploadMbps: s.up }, "ethernet"));
  }
  SPIKE_CAUSES.forEach((cause, i) => {
    const ago = 1 + Math.floor(hash(i, 1) * 29);
    const hour = 17 + Math.floor(hash(i, 2) * 6);
    const t = at(now, tz, ago, measuredHour(now, tz, ago, hour), Math.floor(hash(i, 3) * 60), Math.floor(hash(i, 4) * 60));
    const rtt = Math.round(120 + hash(i, 5) * 160);
    out.push({ ...base("spike", t), value: rtt, cause, detail: { count: 1, baseline: 24, limit: 72, cpuHigh: cause === "localTraffic" && i % 2 === 0, reasons: [] } });
  });
  // Im Demo protokollierte Speedtests (aus dem Netzwerk-Tab)
  for (const r of readLogged()) out.push(...speedEvents(r.at, r, "ethernet"));
  const cleared = readNumber(CLEARED_KEY);
  return out
    .filter((e) => e.t <= now && e.t >= cleared)
    .sort((a, b) => a.t - b.t || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
    .map((e, i) => ({ ...e, id: i + 1 }));
}

/** Zählungen je UTC-Stunde wie `net_events_summary` */
export function summarize(events: NetEvent[]): EventSummaryRow[] {
  const map = new Map<string, EventSummaryRow>();
  for (const e of events) {
    const hourStart = Math.floor(e.t / HOUR_MS) * HOUR_MS;
    const key = [hourStart, e.kind, e.cause, e.scope, e.connection, e.netId].join("|");
    const row = map.get(key) ?? { hourStart, kind: e.kind, cause: e.cause, scope: e.scope, connection: e.connection, netId: e.netId, rows: 0, countSum: 0, durationS: 0 };
    const count = (e.detail as { count?: unknown } | null)?.count;
    row.rows += 1;
    row.countSum += typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 1;
    row.durationS += e.endT !== null && e.endT > e.t ? (e.endT - e.t) / 1000 : 0;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.hourStart - b.hourStart || a.kind.localeCompare(b.kind));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function range(a: Record<string, unknown>): { from: number; to: number } {
  const from = num(a.from);
  const to = num(a.to);
  if (from === null || to === null || from > to || to - from > MAX_RANGE_MS) throw new Error("Ungültiger Zeitraum.");
  return { from, to };
}

// Demo-Speedtests protokollieren (wie `net_speedtest` im Backend; höchstens 50 behalten)
onSpeedtest((result) => {
  if (!Number.isFinite(result.downloadMbps)) return;
  const list = [...readLogged(), { ...result, at: Number.isFinite(result.at) ? result.at : Date.now() }].slice(-50);
  write(LOGGED_KEY, JSON.stringify(list));
});

export const isplogMock: MockHandlers = {
  net_events_list: (a) => {
    const { from, to } = range(a);
    const kinds = Array.isArray(a.kinds) ? (a.kinds as unknown[]).filter((k): k is EventKind => KINDS.includes(k as EventKind)) : null;
    if (Array.isArray(a.kinds) && !kinds?.length) return { events: [], truncated: false };
    const netId = str(a.netId);
    const limit = Math.min(Math.max(Math.round(num(a.limit) ?? 5000), 1), 20_000);
    const hits = demoIspEvents().filter((e) => e.t >= from && e.t <= to && (!kinds || kinds.includes(e.kind)) && (netId === null || e.netId === netId));
    return { events: hits.slice(-limit), truncated: hits.length > limit };
  },
  net_events_summary: (a) => {
    const { from, to } = range(a);
    const netId = str(a.netId);
    return summarize(demoIspEvents().filter((e) => e.t >= from && e.t <= to && (netId === null || e.netId === netId)));
  },
  net_history_clear: (a) => {
    const scope = str(a.scope);
    if (scope !== "events" && scope !== "all") throw new Error("Unbekannter Bereich.");
    const n = demoIspEvents().length;
    write(CLEARED_KEY, String(Date.now()));
    write(LOGGED_KEY, null);
    return n;
  },
};
