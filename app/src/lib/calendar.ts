/**
 * Pulsar-Kalender: Heatmap Wochentag × Stunde aus den Stunden-Summen (`net_history_hourly`) und – nur
 * bei genug Daten und deutlichem Unterschied – die bisher ruhigste Zeit. Reine Rechnung in Ortszeit.
 * Vertrag: docs/API.md, „Pulsar-Kalender“.
 *
 * Ehrlich: Das sind bisherige Messungen, keine Vorhersage. Verschiedene Ziele und Netze werden nie
 * gemischt; WLAN, Kabel und VPN lassen sich über den Verbindungsfilter trennen.
 */
import { gradeValue, pingGrade } from "./grade";
import { defaultTimeZone, localParts } from "./localtime";
import type { CalendarAdvice, CalendarBlock, CalendarCell, CalendarConnectionFilter, CalendarRange, ConnectionKind, Grade, HourlyRow, TargetKind } from "./types";

/** Eine Messstunde hat mindestens so viel echte Messzeit (30 min). */
export const MEASURED_HOUR_MS = 30 * 60_000;
/** Ab dieser Ausreißerquote (Ausreißer je Antwort) gibt es eine Note Abzug. */
export const SPIKE_PENALTY_RATE = 0.02;
/** Mindestbasis für eine Empfehlung: Stunden Messzeit … */
export const MIN_HOURS = 20;
/** … an so vielen Tagen … */
export const MIN_DAYS = 7;
/** … und so viele gültige Fächer. */
export const MIN_VALID_CELLS = 12;
/** Ein Fach ist gültig ab so vielen Messstunden … */
export const VALID_MIN_HOURS = 2;
/** … an so vielen verschiedenen Tagen. */
export const VALID_MIN_DAYS = 2;
/** Empfehlbar ab so vielen Tagen. */
export const RECOMMEND_MIN_DAYS = 3;
/** Mindestunterschied neben der Notenstufe: Ø-Ping (ms) … */
export const MIN_DIFF_MS = 10;
/** … oder Verlust bzw. Ausreißerquote (Anteil, 1 Prozentpunkt). */
export const MIN_DIFF_RATE = 0.01;
/** Zeiträume (Tage) und Standard */
export const CALENDAR_RANGES: CalendarRange[] = [30, 90, 365];
export const DEFAULT_RANGE: CalendarRange = 90;
export const DAY_MS = 86_400_000;

const GRADES: Grade[] = ["A+", "A", "B", "C", "D", "F"];
const gradeIndex = (g: Grade | null) => (g === null ? GRADES.length : GRADES.indexOf(g));

/** Note mit Abzug für viele Ausreißer (F bleibt F). */
export function cellGrade(avg: number | null, jitter: number | null, loss: number, spikeRate: number): Grade | null {
  const g = pingGrade(avg, jitter, loss);
  if (g === null || spikeRate <= SPIKE_PENALTY_RATE) return g;
  return GRADES[Math.min(GRADES.indexOf(g) + 1, GRADES.length - 1)];
}

// ---------------------------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------------------------

export interface CalendarFilter {
  targetKey: string | null;
  netId: string | null;
  connection: CalendarConnectionFilter;
}

/** Passt die Verbindungsart zum Filter? (Standard „alle außer VPN“) */
export function connectionMatches(c: ConnectionKind, filter: CalendarConnectionFilter): boolean {
  if (filter === "ethernet") return c === "ethernet";
  if (filter === "wifi") return c === "wifi";
  return c !== "vpn";
}

/** Nur ein Ziel, ein Netz und die gewählte Verbindungsart (nie gemischt). */
export function filterRows(rows: HourlyRow[], f: CalendarFilter): HourlyRow[] {
  return rows.filter((r) => (f.targetKey === null || r.targetKey === f.targetKey) && (f.netId === null || r.netId === f.netId) && connectionMatches(r.connection, f.connection));
}

export interface TargetOption {
  key: string;
  label: string;
  kind: TargetKind;
  coveredMs: number;
}

/** Ziele nach Messzeit (meiste zuerst); Name = zuletzt geschriebener. */
export function targetOptions(rows: HourlyRow[]): TargetOption[] {
  const map = new Map<string, TargetOption & { last: number }>();
  for (const r of rows) {
    const o = map.get(r.targetKey) ?? { key: r.targetKey, label: r.label, kind: r.kind, coveredMs: 0, last: -Infinity };
    o.coveredMs += r.coveredMs;
    if (r.hourStart >= o.last) {
      o.last = r.hourStart;
      o.label = r.label || r.targetKey;
      o.kind = r.kind;
    }
    map.set(r.targetKey, o);
  }
  return [...map.values()].sort((a, b) => b.coveredMs - a.coveredMs || a.key.localeCompare(b.key)).map(({ last: _last, ...o }) => o);
}

export interface NetOption {
  netId: string;
  /** „Netz 1, 2 …“ nach Messzeit über alle Ziele (0 = unbekanntes Netz) */
  index: number;
  /** Messzeit (beim gewählten Ziel, sonst gesamt) */
  coveredMs: number;
  /** erste und letzte Stunde mit Messung */
  from: number;
  to: number;
}

/**
 * Netze mit Messungen (für `targetKey`, falls angegeben), nach Messzeit. Die Nummer bleibt gleich,
 * egal welches Ziel gewählt ist (sie zählt über alle Ziele). Pulsar speichert keinen Netznamen.
 */
export function netOptions(rows: HourlyRow[], targetKey: string | null = null): NetOption[] {
  const total = new Map<string, number>();
  for (const r of rows) total.set(r.netId, (total.get(r.netId) ?? 0) + r.coveredMs);
  const numbered = [...total.entries()].filter(([id]) => id !== "").sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const index = new Map(numbered.map(([id], i) => [id, i + 1]));
  const map = new Map<string, NetOption>();
  for (const r of rows) {
    if (targetKey !== null && r.targetKey !== targetKey) continue;
    const o = map.get(r.netId) ?? { netId: r.netId, index: index.get(r.netId) ?? 0, coveredMs: 0, from: r.hourStart, to: r.hourStart };
    o.coveredMs += r.coveredMs;
    o.from = Math.min(o.from, r.hourStart);
    o.to = Math.max(o.to, r.hourStart);
    map.set(r.netId, o);
  }
  return [...map.values()].sort((a, b) => b.coveredMs - a.coveredMs || a.index - b.index);
}

/** Standardfilter: Ziel und Netz mit der meisten Messzeit, alle Verbindungsarten außer VPN. */
export function defaultFilter(rows: HourlyRow[]): CalendarFilter {
  const relevant = rows.filter((r) => connectionMatches(r.connection, "noVpn"));
  const base = relevant.length ? relevant : rows;
  const targetKey = targetOptions(base)[0]?.key ?? null;
  const netId = netOptions(base, targetKey)[0]?.netId ?? null;
  return { targetKey, netId, connection: "noVpn" };
}

/** Gewählten Filter behalten, wenn Ziel/Netz noch vorkommen, sonst auf den Standard zurück. */
export function reconcileFilter(rows: HourlyRow[], f: CalendarFilter): CalendarFilter {
  const def = defaultFilter(rows);
  const targets = targetOptions(rows);
  const targetKey = targets.some((o) => o.key === f.targetKey) ? f.targetKey : def.targetKey;
  const nets = netOptions(rows, targetKey);
  const netId = nets.some((o) => o.netId === f.netId) ? f.netId : (nets[0]?.netId ?? null);
  return { targetKey, netId, connection: f.connection };
}

// ---------------------------------------------------------------------------------------------
// Fächer
// ---------------------------------------------------------------------------------------------

interface Sums {
  n: number;
  lost: number;
  sumRtt: number;
  sumJitter: number;
  nJitter: number;
  spikes: number;
  covered: number;
}
const emptySums = (): Sums => ({ n: 0, lost: 0, sumRtt: 0, sumJitter: 0, nJitter: 0, spikes: 0, covered: 0 });
function addSums(s: Sums, r: { n: number; lost: number; sumRtt: number; sumJitter: number; nJitter: number; spikes: number; covered: number }) {
  s.n += r.n;
  s.lost += r.lost;
  s.sumRtt += r.sumRtt;
  s.sumJitter += r.sumJitter;
  s.nJitter += r.nJitter;
  s.spikes += r.spikes;
  s.covered += r.covered;
}

interface Stats {
  avg: number | null;
  jitter: number | null;
  loss: number;
  spikeRate: number;
  grade: Grade | null;
}
function stats(s: Sums): Stats {
  const answers = s.n - s.lost;
  const avg = answers > 0 ? s.sumRtt / answers : null;
  const jitter = s.nJitter > 0 ? s.sumJitter / s.nJitter : null;
  const loss = s.n > 0 ? s.lost / s.n : 0;
  const spikeRate = answers > 0 ? s.spikes / answers : 0;
  return { avg, jitter, loss, spikeRate, grade: cellGrade(avg, jitter, loss, spikeRate) };
}

/** Index eines Fachs in der Liste (Montag 0 Uhr = 0 … Sonntag 23 Uhr = 167) */
export const cellIndex = (weekday: number, hour: number) => weekday * 24 + hour;

/** Interne Fachdaten (für Blöcke) */
interface CellAcc {
  sums: Sums;
  /** Tage mit einer Messstunde */
  days: Set<string>;
  measuredHours: number;
}

export interface CalendarBasis {
  /** Σ coveredMs */
  coveredMs: number;
  /** Stunden Messzeit, auf 0,1 gerundet */
  hours: number;
  /** verschiedene Kalendertage mit einer Messstunde */
  days: number;
}

/** Ein Block mit den Werten, die für den Mindestunterschied gebraucht werden */
export interface BlockStats extends CalendarBlock {
  /** Mittel der beiden `gradeValue` (Rangfolge) */
  score: number;
  /** Mittel der beiden Notenstufen (0 = A+ … 5 = F) */
  step: number;
  loss: number;
  spikeRate: number;
}

export interface CalendarModel {
  /** 168 Fächer, Index = `cellIndex(weekday, hour)` */
  cells: CalendarCell[];
  basis: CalendarBasis;
  validCells: number;
  advice: CalendarAdvice;
  /** Besten/schlechtesten Block gibt es (auch wenn kein deutlicher Unterschied) */
  blocks: { best: BlockStats; worst: BlockStats } | null;
}

/** Stunden Messzeit, auf 0,1 gerundet */
export const coveredHours = (ms: number) => Math.round(ms / 360_000) / 10;

/**
 * Heatmap und Empfehlung aus schon gefilterten Zeilen (ein Ziel, ein Netz, eine Verbindungsauswahl).
 * Zeilen derselben Stunde (z. B. Kabel und WLAN bei „alle außer VPN“) bilden eine Stundengruppe; eine
 * Messstunde ist eine Gruppe mit mindestens 30 min Messzeit.
 */
export function calendarModel(rows: HourlyRow[], timeZone: string = defaultTimeZone()): CalendarModel {
  // Stundengruppen
  const groups = new Map<number, Sums>();
  for (const r of rows) {
    const g = groups.get(r.hourStart) ?? emptySums();
    addSums(g, { n: r.n, lost: r.lost, sumRtt: r.sumRtt, sumJitter: r.sumJitter, nJitter: r.nJitter, spikes: r.spikes, covered: r.coveredMs });
    groups.set(r.hourStart, g);
  }
  const acc: CellAcc[] = Array.from({ length: 168 }, () => ({ sums: emptySums(), days: new Set<string>(), measuredHours: 0 }));
  const allDays = new Set<string>();
  let covered = 0;
  for (const [hourStart, g] of groups) {
    const p = localParts(hourStart, timeZone);
    const cell = acc[cellIndex(p.weekday, p.hour)];
    addSums(cell.sums, g);
    covered += g.covered;
    if (g.covered >= MEASURED_HOUR_MS) {
      const day = `${p.year}-${p.month}-${p.day}`;
      cell.days.add(day);
      cell.measuredHours += 1;
      allDays.add(day);
    }
  }
  const cells: CalendarCell[] = acc.map((c, i) => {
    const s = stats(c.sums);
    const valid = c.measuredHours >= VALID_MIN_HOURS && c.days.size >= VALID_MIN_DAYS;
    return {
      weekday: Math.floor(i / 24),
      hour: i % 24,
      n: c.sums.n,
      lost: c.sums.lost,
      avg: s.avg,
      jitter: s.jitter,
      loss: s.loss,
      spikeRate: s.spikeRate,
      covered: c.sums.covered,
      days: c.days.size,
      grade: s.grade,
      valid,
      recommendable: valid && c.days.size >= RECOMMEND_MIN_DAYS,
    };
  });
  const basis: CalendarBasis = { coveredMs: covered, hours: coveredHours(covered), days: allDays.size };
  const validCells = cells.filter((c) => c.valid).length;
  const blocks = findBlocks(cells, acc);
  const enough = basis.hours >= MIN_HOURS && basis.days >= MIN_DAYS && validCells >= MIN_VALID_CELLS;
  let advice: CalendarAdvice;
  if (!enough || !blocks) advice = { kind: "tooLittle", hours: basis.hours, days: basis.days };
  else if (clearDifference(blocks.best, blocks.worst)) advice = { kind: "best", best: toBlock(blocks.best), worst: toBlock(blocks.worst) };
  else advice = { kind: "noDifference" };
  return { cells, basis, validCells, advice, blocks };
}

const toBlock = (b: BlockStats): CalendarBlock => ({ weekday: b.weekday, hour: b.hour, avg: b.avg, grade: b.grade, days: b.days });

/** Bester und schlechtester Block aus 2 aufeinanderfolgenden empfehlbaren Stunden am selben Wochentag. */
function findBlocks(cells: CalendarCell[], acc: CellAcc[]): { best: BlockStats; worst: BlockStats } | null {
  const list: BlockStats[] = [];
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 23; h++) {
      const a = cells[cellIndex(wd, h)];
      const b = cells[cellIndex(wd, h + 1)];
      if (!a.recommendable || !b.recommendable) continue;
      const sums = emptySums();
      addSums(sums, acc[cellIndex(wd, h)].sums);
      addSums(sums, acc[cellIndex(wd, h + 1)].sums);
      const s = stats(sums);
      list.push({
        weekday: wd,
        hour: h,
        avg: s.avg,
        grade: s.grade,
        days: Math.min(a.days, b.days),
        score: (gradeValue(a.grade) + gradeValue(b.grade)) / 2,
        step: (gradeIndex(a.grade) + gradeIndex(b.grade)) / 2,
        loss: s.loss,
        spikeRate: s.spikeRate,
      });
    }
  }
  if (!list.length) return null;
  const avgOf = (b: BlockStats) => b.avg ?? Infinity;
  // Liste ist schon nach (Wochentag, Stunde) geordnet → „früher“ = kleinerer Index, stabil sortiert
  const best = [...list].sort((x, y) => y.score - x.score || avgOf(x) - avgOf(y))[0];
  const worst = [...list].sort((x, y) => x.score - y.score || avgOf(y) - avgOf(x))[0];
  return { best, worst };
}

/** Mindestens eine Notenstufe **und** (Δ Ø-Ping ≥ 10 ms oder Δ Verlust ≥ 1 pp oder Δ Ausreißerquote ≥ 1 pp). */
export function clearDifference(best: BlockStats, worst: BlockStats): boolean {
  if (worst.step - best.step < 1) return false;
  const dAvg = best.avg !== null && worst.avg !== null ? worst.avg - best.avg : 0;
  // kleine Rundungsreste (z. B. 0,03 − 0,02) sollen 1 Prozentpunkt nicht verfehlen
  const eps = 1e-9;
  return dAvg >= MIN_DIFF_MS - eps || worst.loss - best.loss >= MIN_DIFF_RATE - eps || worst.spikeRate - best.spikeRate >= MIN_DIFF_RATE - eps;
}

// ---------------------------------------------------------------------------------------------
// Zeitraum
// ---------------------------------------------------------------------------------------------

/** Zeitraum für `historyHourly` (letzte `days` Tage bis jetzt). */
export function rangeFor(days: CalendarRange, now: number = Date.now()): { from: number; to: number } {
  return { from: now - days * DAY_MS, to: now };
}

// ---------------------------------------------------------------------------------------------
// Texte (ehrlich: „bisher“, keine Vorhersage)
// ---------------------------------------------------------------------------------------------

/** Übersetzer wie `t` aus `lib/i18n.ts` */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;
export type CalendarLang = "de" | "en";

/** Zahl in der Sprache der Oberfläche (höchstens `digits` Nachkommastellen) */
export function formatNum(v: number, digits: number, lang: CalendarLang): string {
  return v.toLocaleString(lang === "de" ? "de-DE" : "en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** Stunden Messzeit: unter 10 h eine Nachkommastelle („2,5“, „1,0“), ab 10 h ganze Stunden („533“) */
export const formatHours = (hours: number, lang: CalendarLang) => {
  const digits = hours < 10 ? 1 : 0;
  return hours.toLocaleString(lang === "de" ? "de-DE" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

/** „Di 20–22 Uhr“ für einen Block bzw. (`span = 1`) „Di 20–21 Uhr“ für ein Fach */
export function whenText(weekday: number, hour: number, tr: Translate, span = 2): string {
  return tr("calendar.when", { day: tr(`calendar.weekday.${weekday}`), from: hour, to: hour + span });
}

/** „{hours} Stunden Messzeit an {days} Tagen“ */
export function basisText(basis: CalendarBasis, tr: Translate, lang: CalendarLang): string {
  const hours = formatHours(basis.hours, lang);
  return basis.days === 1 ? tr("calendar.basisOne", { hours }) : tr("calendar.basis", { hours, days: basis.days });
}

export interface AdviceTexts {
  kind: CalendarAdvice["kind"];
  /** Hauptsatz */
  title: string;
  /** Unterzeile */
  sub: string;
  /** Nur bei `best`: „Eher meiden: …“ */
  worst?: string;
}

function blockSentence(key: "calendar.best" | "calendar.worst", b: CalendarBlock, tr: Translate, lang: CalendarLang): string {
  return tr(key, {
    when: whenText(b.weekday, b.hour, tr),
    ms: b.avg === null ? "–" : formatNum(Math.round(b.avg), 0, lang),
    days: b.days,
    weekdays: tr(`calendar.weekdayPlural.${b.weekday}`),
  });
}

/** Die Sätze der Empfehlungskarte (ruhigste Zeit, kein deutlicher Unterschied, zu wenig Daten). */
export function adviceTexts(model: CalendarModel, tr: Translate, lang: CalendarLang): AdviceTexts {
  const a = model.advice;
  if (a.kind === "best") return { kind: a.kind, title: blockSentence("calendar.best", a.best, tr, lang), sub: tr("calendar.bestSub"), worst: blockSentence("calendar.worst", a.worst, tr, lang) };
  if (a.kind === "noDifference") return { kind: a.kind, title: tr("calendar.noDifference"), sub: tr("calendar.noDifferenceSub") };
  const hours = formatHours(a.hours, lang);
  const basisMet = a.hours >= MIN_HOURS && a.days >= MIN_DAYS && model.validCells >= MIN_VALID_CELLS;
  // Basis erfüllt, aber keine zwei aufeinanderfolgenden empfehlbaren Stunden
  if (basisMet) return { kind: a.kind, title: tr("calendar.noBlock"), sub: basisText(model.basis, tr, lang) };
  return {
    kind: a.kind,
    title: a.days === 1 ? tr("calendar.tooLittleOne", { hours }) : tr("calendar.tooLittle", { hours, days: a.days }),
    sub: tr("calendar.tooLittleNeed", { hours: MIN_HOURS, days: MIN_DAYS, cells: MIN_VALID_CELLS, valid: model.validCells }),
  };
}
