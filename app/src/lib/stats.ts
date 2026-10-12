import { dayKey, startOfDay, startOfMonth, startOfWeek } from "./format";
import type { Game, PlayStats, Session } from "./types";

const DAY = 86400000;

export interface DayBucket {
  key: string;
  start: number;
  seconds: number;
}

/** Spielzeit pro Tag für die letzten `days` Tage (inklusive heute) */
export function perDay(sessions: Session[], days: number, now = Date.now()): DayBucket[] {
  const today = startOfDay(now);
  const buckets: DayBucket[] = [];
  const idx = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(today);
    start.setDate(start.getDate() - i);
    const b = { key: dayKey(start.getTime()), start: start.getTime(), seconds: 0 };
    buckets.push(b);
    idx.set(b.key, b);
  }
  for (const s of sessions) {
    const b = idx.get(dayKey(s.start));
    if (b) b.seconds += s.seconds;
  }
  return buckets;
}

/** Spielzeit pro Woche (Montag bis Sonntag) für die letzten `weeks` Wochen */
export function perWeek(sessions: Session[], weeks: number, now = Date.now()): DayBucket[] {
  const thisWeek = startOfWeek(now);
  const buckets: DayBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - i * 7);
    buckets.push({ key: dayKey(d.getTime()), start: d.getTime(), seconds: 0 });
  }
  for (const s of sessions) {
    const ws = startOfWeek(s.start);
    const b = buckets.find((x) => x.start === ws);
    if (b) b.seconds += s.seconds;
  }
  return buckets;
}

/** Verteilung über die Stunden des Tages (0..23) */
export function perHour(sessions: Session[]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const s of sessions) {
    // Sitzung auf die Stunden verteilen, die sie überdeckt
    let t = s.start;
    const end = Math.max(s.end, s.start + s.seconds * 1000);
    while (t < end) {
      const d = new Date(t);
      const next = new Date(d);
      next.setMinutes(60, 0, 0);
      const slice = Math.min(end, next.getTime()) - t;
      hours[d.getHours()] += slice / 1000;
      t = next.getTime();
    }
  }
  return hours;
}

/** Tageswerte für die Kalender-Heatmap eines Jahres (Schlüssel "YYYY-MM-DD") */
export function heatmap(sessions: Session[], from: number, to: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) {
    if (s.start < from || s.start >= to) continue;
    const k = dayKey(s.start);
    m.set(k, (m.get(k) ?? 0) + s.seconds);
  }
  return m;
}

export function sumBetween(sessions: Session[], from: number, to = Infinity): number {
  let total = 0;
  for (const s of sessions) if (s.start >= from && s.start < to) total += s.seconds;
  return total;
}

export function weekSeconds(sessions: Session[], now = Date.now()) {
  return sumBetween(sessions, startOfWeek(now));
}
export function monthSeconds(sessions: Session[], now = Date.now()) {
  return sumBetween(sessions, startOfMonth(now));
}
export function todaySeconds(sessions: Session[], now = Date.now()) {
  return sumBetween(sessions, startOfDay(now));
}

/** Aktuelle und längste Serie (Tage in Folge mit Spielzeit) */
export function streaks(sessions: Session[], now = Date.now()): { current: number; best: number } {
  const days = new Set(sessions.filter((s) => s.seconds >= 60).map((s) => dayKey(s.start)));
  if (days.size === 0) return { current: 0, best: 0 };
  const sorted = [...days].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + "T12:00:00").getTime();
    const cur = new Date(sorted[i] + "T12:00:00").getTime();
    if (Math.round((cur - prev) / DAY) === 1) run++;
    else run = 1;
    best = Math.max(best, run);
  }
  // aktuelle Serie: endet heute oder gestern
  let current = 0;
  const d = new Date(startOfDay(now));
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d.getTime()))) {
    current++;
    d.setDate(d.getDate() - 1);
  }
  return { current, best };
}

export interface TopGame {
  gameId: string;
  seconds: number;
}

export function topGames(sessions: Session[], limit = 8): TopGame[] {
  const m = new Map<string, number>();
  for (const s of sessions) m.set(s.gameId, (m.get(s.gameId) ?? 0) + s.seconds);
  return [...m.entries()]
    .map(([gameId, seconds]) => ({ gameId, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

export interface YearReview {
  year: number;
  seconds: number;
  sessions: number;
  topGameId?: string;
  topGameSeconds: number;
  bestMonth?: number;
  bestMonthSeconds: number;
  newGames: number;
  longestSession: number;
  daysPlayed: number;
}

export function yearReview(sessions: Session[], year: number): YearReview {
  const from = new Date(year, 0, 1).getTime();
  const to = new Date(year + 1, 0, 1).getTime();
  const inYear = sessions.filter((s) => s.start >= from && s.start < to);
  const months = new Array<number>(12).fill(0);
  const firstSeen = new Map<string, number>();
  for (const s of sessions) {
    const f = firstSeen.get(s.gameId);
    if (f === undefined || s.start < f) firstSeen.set(s.gameId, s.start);
  }
  for (const s of inYear) months[new Date(s.start).getMonth()] += s.seconds;
  const top = topGames(inYear, 1)[0];
  const bestMonthSeconds = Math.max(...months);
  return {
    year,
    seconds: inYear.reduce((a, s) => a + s.seconds, 0),
    sessions: inYear.length,
    topGameId: top?.gameId,
    topGameSeconds: top?.seconds ?? 0,
    bestMonth: bestMonthSeconds > 0 ? months.indexOf(bestMonthSeconds) : undefined,
    bestMonthSeconds,
    newGames: [...firstSeen.values()].filter((t) => t >= from && t < to).length,
    longestSession: inYear.reduce((a, s) => Math.max(a, s.seconds), 0),
    daysPlayed: new Set(inYear.map((s) => dayKey(s.start))).size,
  };
}

/** Backlog-Rechner: wie viele Wochen bis alle "Will ich spielen"-Spiele durch sind */
export function backlogEstimate(games: Game[], stats: Map<string, PlayStats>, sessions: Session[], now = Date.now()) {
  const backlog = games.filter((g) => g.kind === "game" && g.status === "want");
  const eightWeeks = sumBetween(sessions, now - 56 * DAY);
  const pacePerWeek = eightWeeks / 8;
  const doneLengths = games
    .filter((g) => g.status === "done")
    .map((g) => stats.get(g.id)?.totalSeconds ?? 0)
    .filter((s) => s > 3600)
    .sort((a, b) => a - b);
  const median = doneLengths.length ? doneLengths[Math.floor(doneLengths.length / 2)] : 18 * 3600;
  const remaining = backlog.reduce((acc, g) => acc + Math.max(median * 0.25, median - (stats.get(g.id)?.totalSeconds ?? 0)), 0);
  const weeks = pacePerWeek > 0 ? remaining / pacePerWeek : Infinity;
  return { count: backlog.length, pacePerWeek, weeks, avgLength: median };
}
