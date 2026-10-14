/**
 * Demo-Backend: Pulsar-Kalender (`net_history_hourly`). Vertrag: docs/API.md, „Pulsar-Kalender“ (Demo).
 *
 * Die Demo-Zeilen sind eine reine Funktion von (lokalem Wochentag, Stunde, Seed 1337) – unabhängig
 * vom Tag, an dem die Demo läuft: 60 Tage für `aws-eu-central-1` in einem Netz per Kabel (abends
 * deutlich höherer Ping und mehr Ausreißer, nachts Lücken, werktags mittags nur selten gemessen) und
 * wenige Tage für `valve-cs2-fra`. So zeigt die Demo stabil eine Empfehlung (Di 17–19 Uhr am
 * ruhigsten, Fr 20–22 Uhr eher meiden) und beim zweiten Ziel „zu wenig Daten“.
 *
 * `demoHourlyRows` benutzt auch die Demo des Anbieter-Protokolls (F7).
 */
import { defaultTimeZone, localParts } from "../localtime";
import type { HourlyRow } from "../types";
import type { MockHandlers } from "./core";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 400 * DAY_MS;
const SEED = 1337;

/** Netz der Demo (Hash wie `net_id`, 12 Hex-Zeichen) */
export const DEMO_NET_ID = "7c41e09b2d5f";
/** Hauptziel der Demo (60 Tage Verlauf) */
export const DEMO_MAIN = { key: "aws-eu-central-1", label: "Frankfurt (AWS)", kind: "region", method: "tcp" } as const;
/** Zweites Ziel der Demo (nur 3 Tage → „zu wenig Daten“) */
export const DEMO_SECOND = { key: "valve-cs2-fra", label: "CS2 Frankfurt (Valve)", kind: "server", method: "icmp" } as const;
/** So viele Tage reicht der Demo-Verlauf des Hauptziels zurück */
export const DEMO_DAYS = 60;

/** Deterministischer Wert 0–1 aus ganzen Zahlen (kein gemeinsamer Zufallszustand) */
function hash(...parts: number[]): number {
  let h = SEED ^ 0x9e3779b9;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

export interface DemoHourShape {
  avg: number;
  loss: number;
  spikeRate: number;
}

/** Wie das Hauptziel zu (Wochentag Montag = 0, Stunde) aussieht – `null` = nie gemessen. */
export function demoShape(weekday: number, hour: number): DemoHourShape | null {
  const weekend = weekday >= 5;
  const wobble = (hash(weekday, hour, 1) - 0.5) * 3; // ±1,5 ms
  // Nachts Lücken (nur in der Nacht auf Sa/So kurz nach Mitternacht)
  if (hour < 7) return hour === 0 && weekend ? { avg: 31 + wobble, loss: 0.002, spikeRate: 0.01 } : null;
  if (!weekend && hour < 12) return null;
  if (weekend && hour < 10) return null;
  // Ruhigster Block: Dienstag 17–19 Uhr
  if (weekday === 1 && (hour === 17 || hour === 18)) return { avg: 16.5 + wobble / 3, loss: 0, spikeRate: 0.004 };
  // Abends deutlich höher, Freitag und Samstag am stärksten
  if (hour >= 19 && hour <= 22) {
    const peak = hour === 20 || hour === 21 ? 8 : 0;
    const fri = weekday === 4;
    const sat = weekday === 5;
    const avg = 38 + peak + (fri ? 12 : sat ? 6 : 0) + wobble;
    const loss = fri && hour === 21 ? 0.012 : fri || sat ? 0.004 : 0.002;
    const spikeRate = fri ? 0.05 : sat ? 0.035 : 0.028;
    return { avg, loss, spikeRate };
  }
  if (hour === 23) return { avg: 30 + wobble, loss: 0.002, spikeRate: 0.012 };
  return { avg: (weekend ? 22.5 : 23.5) + wobble, loss: 0, spikeRate: 0.006 };
}

/** Werktags 12–16 Uhr nur in jeder dritten Woche gemessen (zeigt „wenig Daten“) */
const sparse = (weekday: number, hour: number) => weekday < 5 && hour >= 12 && hour <= 16;

function row(target: typeof DEMO_MAIN | typeof DEMO_SECOND, hourStart: number, coveredMs: number, s: DemoHourShape): HourlyRow {
  const n = Math.round(coveredMs / 1000);
  const lost = Math.round(n * s.loss);
  const answers = n - lost;
  const nJitter = Math.max(answers - 1, 0);
  return {
    hourStart,
    targetKey: target.key,
    netId: DEMO_NET_ID,
    connection: "ethernet",
    kind: target.kind,
    label: target.label,
    method: target.method,
    n,
    lost,
    sumRtt: answers * s.avg,
    sumJitter: nJitter * s.avg * 0.08,
    nJitter,
    maxRtt: answers > 0 ? Math.round((s.avg * 2.6 + 20) * 10) / 10 : null,
    spikes: Math.round(answers * s.spikeRate),
    coveredMs,
  };
}

/** Tagesnummer eines lokalen Kalendertags (unabhängig von der Uhrzeit) */
const dayNumber = (p: { year: number; month: number; day: number }) => Math.round(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);

/**
 * Demo-Stunden-Summen für `from <= hourStart <= to` (nur abgeschlossene Stunden vor `now`), nach
 * `hourStart` sortiert. Gleiche Eingaben → gleiche Zeilen.
 */
export function demoHourlyRows(from: number, to: number, opts: { now?: number; timeZone?: string } = {}): HourlyRow[] {
  const now = opts.now ?? Date.now();
  const tz = opts.timeZone ?? defaultTimeZone();
  const today = dayNumber(localParts(now, tz));
  const start = Math.ceil(Math.max(from, now - (DEMO_DAYS + 1) * DAY_MS) / HOUR_MS) * HOUR_MS;
  const end = Math.min(to, now - HOUR_MS);
  const out: HourlyRow[] = [];
  for (let hs = start; hs <= end; hs += HOUR_MS) {
    const p = localParts(hs, tz);
    const day = dayNumber(p);
    const ago = today - day;
    if (ago > DEMO_DAYS || ago < 0) continue;
    const shape = demoShape(p.weekday, p.hour);
    if (shape && (!sparse(p.weekday, p.hour) || Math.floor(day / 7) % 3 === 0)) {
      // 42–60 min echte Messzeit; kurz nach Mitternacht nur 18 min (keine Messstunde)
      const share = p.hour === 0 ? 0.3 : 0.7 + 0.3 * hash(day, p.hour, 2);
      out.push(row(DEMO_MAIN, hs, Math.round(HOUR_MS * share), shape));
    }
    // Zweites Ziel: nur an den letzten 3 Tagen abends
    if (ago <= 2 && p.hour >= 19 && p.hour <= 22) {
      out.push(row(DEMO_SECOND, hs, Math.round(HOUR_MS * (0.75 + 0.2 * hash(day, p.hour, 3))), { avg: 14 + 4 * hash(p.weekday, p.hour, 4), loss: 0, spikeRate: 0.01 }));
    }
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export const calendarMock: MockHandlers = {
  net_history_hourly: (a) => {
    const from = num(a.from);
    const to = num(a.to);
    if (from === null || to === null || from > to || to - from > MAX_RANGE_MS) throw new Error("Ungültiger Zeitraum.");
    const targetKey = str(a.targetKey);
    const netId = str(a.netId);
    return demoHourlyRows(from, to).filter((r) => (targetKey === null || r.targetKey === targetKey) && (netId === null || r.netId === netId));
  },
};
