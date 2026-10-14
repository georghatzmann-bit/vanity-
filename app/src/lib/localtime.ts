/**
 * Ortszeit-Bestandteile in einer bestimmten Zeitzone (für Kalender und Anbieter-Protokoll).
 * Wochentag Montag = 0 … Sonntag = 6 (wie `startOfWeek` in ./format.ts).
 */

export interface LocalParts {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  /** Montag = 0 … Sonntag = 6 */
  weekday: number;
  /** 0–23 */
  hour: number;
}

/** Zeitzone dieses Rechners (z. B. „Europe/Berlin“) */
export const defaultTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Ortszeit von `ms` (UTC) in `timeZone` (Standard: Zeitzone des Rechners) */
export function localParts(ms: number, timeZone: string = defaultTimeZone()): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    hour: Number(parts.hour) % 24,
  };
}
