/**
 * Anbieter-Protokoll als Bericht (rein, ohne Ein-/Ausgabe): Tageswerte in Ortszeit, Ereignisliste,
 * druckbares HTML und CSV. Vertrag: docs/API.md, „Anbieter-Protokoll“.
 *
 * Ehrlich: Das Protokoll ist ein Indiz, kein Nachweis, und bewertet nichts juristisch. Nur Aussetzer,
 * bei denen auch zwei unabhängige Internet-Hosts nicht antworteten (`scope = internet`), heißen
 * „Aussetzer der Internetverbindung“. Ausreißer stehen nur gezählt (nach vermuteter Ursache) im
 * Bericht. Im Export stehen keine SSID, BSSID, MAC, Stations-IP und keine Netz-Kennung; ein
 * Zielname, der wie eine Adresse aussieht, wird zu „eigenes Ziel“.
 */
import { de } from "../locales/de";
import { en } from "../locales/en";
import { coveredHours, netOptions } from "./calendar";
import { safeTargetName } from "./cardexport";
import { localParts } from "./localtime";
import type {
  ConnectionKind,
  EventKind,
  EventSummaryRow,
  HourlyRow,
  IspLogDay,
  IspLogInput,
  IspLogRange,
  IspLogResult,
  IspLogRow,
  IspLogSettings,
  IspLogSpeed,
  IspLogTarget,
  Language,
  LagCause,
  NetEvent,
  OutageScope,
  PingMethod,
  SpikeGroup,
} from "./types";

/** Stand des Hinweises zur Breitbandmessung (bei Änderungen der Regeln anpassen) */
export const BNETZA_STAND = "2026-10";
/** Der einzige Link im Bericht */
export const BNETZA_URL = "https://breitbandmessung.de";
/** Höchstens so viele Zeilen hat die Ereignisliste im HTML (die CSV enthält alle) */
export const HTML_MAX_ROWS = 2000;
/** Zeiträume der Oberfläche (Tage) */
export const ISP_RANGES: IspLogRange[] = [7, 30, 90];
export const DEFAULT_ISP_RANGE: IspLogRange = 30;
/** Ereignisarten, die die Oberfläche lädt (Ausreißer zählt `net_events_summary`) */
export const ISP_LIST_KINDS: Exclude<EventKind, "spike">[] = ["outage", "loss", "slow", "speedtest", "quiet"];
/** So viele Ereignisse lädt die Oberfläche höchstens */
export const ISP_LIST_LIMIT = 20_000;
/** Messstunde: mindestens so viel echte Messzeit (ms) */
export const MEASURED_HOUR_MS = 30 * 60_000;

const DAY_MS = 86_400_000;
const SPIKE_GROUPS: SpikeGroup[] = ["home", "isp", "internet", "unknown"];
const OUTAGE_SCOPES: OutageScope[] = ["internet", "homeNetwork", "targetOnly", "pc", "unknown"];

// ---------------------------------------------------------------------------------------------
// Texte (Sprache des Berichts, unabhängig von der Oberfläche)
// ---------------------------------------------------------------------------------------------

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

function lookup(dict: unknown, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Übersetzer für eine feste Sprache (der Bericht hängt nicht an der Sprache der Oberfläche) */
export function translator(lang: Language): Translate {
  const dict = lang === "en" ? en : de;
  return (key, vars) => {
    const raw = lookup(dict, key) ?? lookup(de, key) ?? key;
    return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`)) : raw;
  };
}

const numberLocale = (lang: Language) => (lang === "de" ? "de-DE" : "en-GB");
/** Zahl in der Sprache des Berichts (höchstens `digits` Nachkommastellen) */
export const fmtNum = (v: number, digits: number, lang: Language) => v.toLocaleString(numberLocale(lang), { minimumFractionDigits: 0, maximumFractionDigits: digits });
const fmtHours = (h: number, lang: Language) => h.toLocaleString(numberLocale(lang), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtPct = (share: number, lang: Language) => fmtNum(Math.round(share * 100), 0, lang);

/** Dauer lesbar: „4 s“, „2 min 5 s“, „1 h 3 min“ */
export function durationText(seconds: number, tr: Translate): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return tr("ispLog.duration.s", { n: s });
  if (s < 3600) return tr("ispLog.duration.min", { m: Math.floor(s / 60), s: s % 60 });
  return tr("ispLog.duration.h", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
}

// ---------------------------------------------------------------------------------------------
// Ortszeit mit Minuten und Sekunden, Versatz zur UTC
// ---------------------------------------------------------------------------------------------

export interface ZonedTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Versatz zur UTC in Minuten (Berlin im Sommer: 120) */
  offsetMin: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = zonedFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
    zonedFormatters.set(timeZone, f);
  }
  return f;
}

/** Gültige Zeitzone oder „UTC“ (ein unbekannter Name darf den Bericht nie verhindern) */
export function safeTimeZone(timeZone: string): string {
  try {
    zonedFormatter(timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** Ortszeit von `ms` (UTC) in `timeZone` */
export function zoned(ms: number, timeZone: string): ZonedTime {
  const parts: Record<string, string> = {};
  for (const p of zonedFormatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const z = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return { ...z, offsetMin: Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** JJJJ-MM-TT des lokalen Kalendertags */
export function dayKey(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** „+02:00“ */
const isoOffset = (min: number) => `${min < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;

/** ISO 8601 in Ortszeit mit Versatz: „2026-10-12T21:04:05+02:00“ */
export function isoLocal(ms: number, timeZone: string): string {
  const z = zoned(ms, timeZone);
  return `${z.year}-${pad(z.month)}-${pad(z.day)}T${pad(z.hour)}:${pad(z.minute)}:${pad(z.second)}${isoOffset(z.offsetMin)}`;
}

/** ISO 8601 in UTC ohne Millisekunden: „2026-10-12T19:04:05Z“ */
export const isoUtc = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** „UTC+2“, „UTC+5:30“, „UTC-3“, „UTC“ */
export function offsetLabel(min: number): string {
  if (min === 0) return "UTC";
  const a = Math.abs(min);
  return `UTC${min < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ""}`;
}

/** „Europe/Berlin, UTC+2“ – bei „UTC“ nur einmal */
export const zoneText = (timeZone: string, offset: string) => (timeZone === offset ? timeZone : `${timeZone}, ${offset}`);

/** Versatz im Zeitraum; wechselt die Sommerzeit dazwischen: „UTC+2 / UTC+1“ */
export function rangeOffsetLabel(from: number, to: number, timeZone: string): string {
  const a = offsetLabel(zoned(from, timeZone).offsetMin);
  const b = offsetLabel(zoned(to, timeZone).offsetMin);
  return a === b ? a : `${a} / ${b}`;
}

/** Datum und Uhrzeit für Menschen: „12.10.2026 21:04“ bzw. „2026-10-12 21:04“ */
export function dateTimeText(ms: number, timeZone: string, lang: Language, seconds = false): string {
  const z = zoned(ms, timeZone);
  const time = `${pad(z.hour)}:${pad(z.minute)}${seconds ? `:${pad(z.second)}` : ""}`;
  return lang === "de" ? `${pad(z.day)}.${pad(z.month)}.${z.year} ${time}` : `${z.year}-${pad(z.month)}-${pad(z.day)} ${time}`;
}

/** Tag für Menschen aus JJJJ-MM-TT: „Mo 12.10.2026“ bzw. „Mon 2026-10-12“ */
export function dayText(date: string, tr: Translate, lang: Language): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const wd = tr(`calendar.weekday.${weekday}`);
  return lang === "de" ? `${wd} ${pad(d)}.${pad(m)}.${y}` : `${wd} ${date}`;
}

// ---------------------------------------------------------------------------------------------
// Netze und Zeitraum (Oberfläche)
// ---------------------------------------------------------------------------------------------

export interface IspNetChoice {
  netId: string;
  /** „Netz 1, 2 …“ wie im Kalender (nach Messzeit über alle Ziele); 0 = unbekanntes Netz */
  index: number;
  coveredMs: number;
}

/**
 * Netze im Zeitraum, nach Messzeit (Nummern wie im Kalender). Netze, die nur Ereignisse haben (ohne
 * Stunden-Summen), stehen dahinter.
 */
export function netChoices(hourly: HourlyRow[], summary: EventSummaryRow[]): IspNetChoice[] {
  const out: IspNetChoice[] = netOptions(hourly).map((o) => ({ netId: o.netId, index: o.index, coveredMs: o.coveredMs }));
  let next = out.reduce((m, o) => Math.max(m, o.index), 0);
  for (const r of summary) {
    if (out.some((o) => o.netId === r.netId)) continue;
    out.push({ netId: r.netId, index: r.netId === "" ? 0 : ++next, coveredMs: 0 });
  }
  return out;
}

/** Standard-Netz: das mit der meisten Messzeit im Zeitraum (`null` = keine Daten) */
export const defaultNetId = (hourly: HourlyRow[], summary: EventSummaryRow[]): string | null => netChoices(hourly, summary)[0]?.netId ?? null;

/** Zeitraum der letzten `days` Tage bis jetzt */
export const ispRange = (days: IspLogRange, now: number = Date.now()) => ({ from: now - days * DAY_MS, to: now });

/** Netzname „Netz 2“ bzw. „Netz unbekannt“ */
export const netName = (choice: Pick<IspNetChoice, "index"> | undefined, tr: Translate) => (choice && choice.index > 0 ? tr("ispLog.netName", { n: choice.index }) : tr("ispLog.netUnknown"));

// ---------------------------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------------------------

/** Zahlen aus dem ursprünglichen `detail` einer Zeile (für die CSV; Adressen gibt es dort nie) */
interface RowDetail {
  lost: number | null;
  n: number | null;
  down: number | null;
  up: number | null;
  server: string | null;
}
const rowDetails = new WeakMap<IspLogRow, RowDetail>();
const rowDetail = (r: IspLogRow): RowDetail => rowDetails.get(r) ?? { lost: null, n: null, down: null, up: null, server: null };

/** Ursache eines Ausreißers → Gruppe im Bericht */
export function spikeGroup(cause: LagCause | null): SpikeGroup {
  switch (cause) {
    case "wifi":
    case "router":
    case "localTraffic":
      return "home";
    case "isp":
      return "isp";
    case "internet":
      return "internet";
    default:
      return "unknown";
  }
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const detailNum = (e: NetEvent, key: string): number | null => finite((e.detail as Record<string, unknown> | null)?.[key]);
const detailStr = (e: NetEvent, key: string): string | null => {
  const v = (e.detail as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : null;
};

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Dauer eines Ereignisses in s (`value` bzw. Ende − Beginn) */
const durationS = (e: NetEvent) => finite(e.value) ?? (e.endT !== null && e.endT > e.t ? (e.endT - e.t) / 1000 : 0);

interface LossInfo {
  lost: number;
  n: number;
  pct: number;
}
function lossInfo(e: NetEvent): LossInfo | null {
  const lost = detailNum(e, "lost");
  const n = detailNum(e, "n");
  if (lost !== null && n !== null && n > 0) return { lost, n, pct: finite(e.value) ?? (lost / n) * 100 };
  const pct = finite(e.value);
  return pct === null ? null : { lost: 0, n: 0, pct };
}

const slowMinutesOf = (e: NetEvent) => detailNum(e, "minutes") ?? (e.endT !== null && e.endT > e.t ? Math.max(1, Math.round((e.endT - e.t) / 60_000)) : 1);

interface SpeedInfo {
  down: number;
  up: number | null;
  server: string | null;
}
function speedInfo(e: NetEvent): SpeedInfo | null {
  const down = detailNum(e, "downloadMbps") ?? finite(e.value);
  if (down === null) return null;
  return { down, up: detailNum(e, "uploadMbps"), server: detailStr(e, "server") };
}

const isRegion = (key: string) => key.startsWith("aws-");

function methodText(method: PingMethod | null, key: string | null, tr: Translate): string {
  if (method === "icmp") return tr("ispLog.method.icmp");
  if (method === "tcp") return key && isRegion(key) ? tr("ispLog.method.tcp443") : tr("ispLog.method.tcp");
  return "";
}

const connText = (c: ConnectionKind | null, tr: Translate) => tr(`ispLog.conn.${c ?? "unknown"}`);

function emptyDay(date: string): IspLogDay {
  return {
    date,
    internetOutages: 0,
    internetOutageS: 0,
    homeNetworkOutages: 0,
    targetOnlyOutages: 0,
    pcOutages: 0,
    unknownOutages: 0,
    lossWindows: 0,
    lossWorst: null,
    slowMinutes: 0,
    slowByTarget: [],
    spikesByCause: {},
    measuredHours: 0,
    coveredMs: 0,
    speedtests: 0,
    speed: null,
  };
}

function speedStats(list: SpeedInfo[]): IspLogSpeed | null {
  if (!list.length) return null;
  const down = list.map((s) => s.down);
  const up = list.map((s) => s.up).filter((v): v is number => v !== null);
  return { n: list.length, downMin: Math.min(...down), downMedian: median(down), upMin: up.length ? Math.min(...up) : NaN, upMedian: up.length ? median(up) : NaN };
}

const spikeTotal = (c: Partial<Record<SpikeGroup, number>>) => SPIKE_GROUPS.reduce((a, g) => a + (c[g] ?? 0), 0);

/** „12 Ausreißer – davon vermutlich Heimnetz/WLAN/PC: 3 · …“ bzw. „keine Ausreißer“ */
export function spikeText(c: Partial<Record<SpikeGroup, number>>, tr: Translate): string {
  const n = spikeTotal(c);
  if (!n) return tr("ispLog.spikesNone");
  return tr("ispLog.spikes", { n, home: c.home ?? 0, isp: c.isp ?? 0, internet: c.internet ?? 0, unknown: c.unknown ?? 0 });
}

/** „3 von 60 Paketen (5 %)“ */
export function lossText(l: LossInfo, tr: Translate, lang: Language): string {
  if (l.n > 0) return tr("ispLog.lossText", { lost: fmtNum(l.lost, 0, lang), n: fmtNum(l.n, 0, lang), pct: fmtNum(l.pct, 1, lang) });
  return `${fmtNum(l.pct, 1, lang)} %`;
}

/** „90 % der eingetragenen Maximal-Geschwindigkeit“ – nur mit Eintrag, nur als Zahl */
export function contractPctText(down: number, contract: IspLogSettings, tr: Translate, lang: Language): string | null {
  const max = finite(contract.contractDownMbps);
  if (max === null || max <= 0) return null;
  return tr("ispLog.contractPct", { pct: fmtNum(Math.round((down / max) * 100), 0, lang) });
}

function rowText(e: NetEvent, contract: IspLogSettings, tr: Translate, lang: Language): string {
  switch (e.kind) {
    case "outage":
      return tr("ispLog.detail.outage", { duration: durationText(durationS(e), tr) });
    case "loss": {
      const l = lossInfo(e);
      return l ? lossText(l, tr, lang) : "";
    }
    case "slow":
      return tr("ispLog.detail.slow", {
        ms: fmtNum(finite(e.value) ?? 0, 0, lang),
        threshold: fmtNum(detailNum(e, "threshold") ?? 0, 0, lang),
        minutes: fmtNum(slowMinutesOf(e), 0, lang),
      });
    case "speedtest": {
      const s = speedInfo(e);
      if (!s) return "";
      const base = tr("ispLog.detail.speedtest", { down: fmtNum(s.down, 1, lang), up: s.up === null ? "–" : fmtNum(s.up, 1, lang), server: s.server ?? "–" });
      const pct = contractPctText(s.down, contract, tr, lang);
      return pct ? `${base} · ${pct}` : base;
    }
    case "quiet": {
      const reason = detailStr(e, "reason");
      return tr("ispLog.detail.quiet", { reason: tr(`ispLog.quietReason.${reason === "wifiScan" ? "wifiScan" : "speedtest"}`) });
    }
    default:
      return "";
  }
}

/**
 * Bericht für **ein** Netz: Kopf, Tageswerte (Ortszeit), Ereignisliste, HTML und CSV.
 * Ereignisse, Zählungen und Stunden-Summen anderer Netze werden herausgefiltert (und gezählt).
 */
export function buildIspLog(input: IspLogInput): IspLogResult {
  const lang: Language = input.lang === "en" ? "en" : "de";
  const tr = translator(lang);
  const tz = safeTimeZone(input.timeZone);
  const { from, to, netId, contract } = input;
  const inRange = (t: number) => t >= from && t <= to;

  const hourly = input.hourly.filter((r) => r.netId === netId && inRange(r.hourStart));
  const summary = input.summary.filter((r) => r.netId === netId && inRange(r.hourStart));
  const events = input.events.filter((e) => e.netId === netId && e.kind !== "spike" && inRange(e.t)).sort((a, b) => a.t - b.t || a.id - b.id);
  const otherNets = new Set<string>();
  for (const r of input.hourly) if (r.netId !== netId) otherNets.add(r.netId);
  for (const r of input.summary) if (r.netId !== netId) otherNets.add(r.netId);
  for (const e of input.events) if (e.netId !== netId) otherNets.add(e.netId);

  const days = new Map<string, IspLogDay>();
  const day = (ms: number) => {
    const key = dayKey(ms, tz);
    let d = days.get(key);
    if (!d) days.set(key, (d = emptyDay(key)));
    return d;
  };

  // Messzeit, Messstunden, Anteile, Ziele
  let covered = 0;
  let wifi = 0;
  let vpn = 0;
  const groups = new Map<number, number>();
  const targets = new Map<string, IspLogTarget & { last: number }>();
  for (const r of hourly) {
    const ms = Math.max(0, finite(r.coveredMs) ?? 0);
    covered += ms;
    if (r.connection === "wifi") wifi += ms;
    if (r.connection === "vpn") vpn += ms;
    groups.set(r.hourStart, (groups.get(r.hourStart) ?? 0) + ms);
    day(r.hourStart).coveredMs += ms;
    const t = targets.get(r.targetKey);
    if (!t) targets.set(r.targetKey, { key: r.targetKey, label: r.label, method: r.method, methodText: "", coveredMs: ms, last: r.hourStart });
    else {
      t.coveredMs += ms;
      if (r.hourStart >= t.last) Object.assign(t, { label: r.label, method: r.method, last: r.hourStart });
    }
  }
  for (const [hs, ms] of groups) if (ms >= MEASURED_HOUR_MS) day(hs).measuredHours += 1;
  for (const e of events) {
    if (!e.targetKey || targets.has(e.targetKey) || !e.method) continue;
    targets.set(e.targetKey, { key: e.targetKey, label: e.targetLabel ?? e.targetKey, method: e.method, methodText: "", coveredMs: 0, last: e.t });
  }
  const targetList: IspLogTarget[] = [...targets.values()]
    .sort((a, b) => b.coveredMs - a.coveredMs || a.key.localeCompare(b.key))
    .map(({ last: _last, ...t }) => ({ ...t, label: safeTargetName(t.label, tr), methodText: methodText(t.method, t.key, tr) }));

  // Ereignisse
  const speedByDay = new Map<string, SpeedInfo[]>();
  const allSpeeds: SpeedInfo[] = [];
  const rows: IspLogRow[] = [];
  for (const e of events) {
    const d = day(e.t);
    switch (e.kind) {
      case "outage": {
        const scope: OutageScope = e.scope && OUTAGE_SCOPES.includes(e.scope) ? e.scope : "unknown";
        if (scope === "internet") {
          d.internetOutages += 1;
          d.internetOutageS += durationS(e);
        } else if (scope === "homeNetwork") d.homeNetworkOutages += 1;
        else if (scope === "targetOnly") d.targetOnlyOutages += 1;
        else if (scope === "pc") d.pcOutages += 1;
        else d.unknownOutages += 1;
        break;
      }
      case "loss": {
        d.lossWindows += 1;
        const l = lossInfo(e);
        if (l && (!d.lossWorst || l.pct > d.lossWorst.pct)) d.lossWorst = { lost: l.lost, n: l.n, pct: l.pct };
        break;
      }
      case "slow": {
        const minutes = slowMinutesOf(e);
        d.slowMinutes += minutes;
        const key = e.targetKey ?? "";
        const slot = d.slowByTarget.find((x) => x.key === key);
        if (slot) slot.minutes += minutes;
        else d.slowByTarget.push({ key, label: safeTargetName(e.targetLabel ?? key, tr), minutes });
        break;
      }
      case "speedtest": {
        const s = speedInfo(e);
        if (s) {
          d.speedtests += 1;
          const list = speedByDay.get(d.date) ?? [];
          list.push(s);
          speedByDay.set(d.date, list);
          allSpeeds.push(s);
        }
        break;
      }
      default:
        break;
    }
    if (e.kind === "spike") continue;
    const row: IspLogRow = {
      id: e.id,
      t: e.t,
      endT: e.endT,
      kind: e.kind,
      scope: e.kind === "outage" ? (e.scope ?? "unknown") : null,
      targetKey: e.targetKey,
      targetLabel: e.targetLabel === null ? null : safeTargetName(e.targetLabel, tr),
      method: e.method,
      connection: e.connection,
      value: finite(e.value),
      sessionId: e.sessionId,
      text: rowText(e, contract, tr, lang),
    };
    const loss = e.kind === "loss" ? lossInfo(e) : null;
    const speed = e.kind === "speedtest" ? speedInfo(e) : null;
    rowDetails.set(row, { lost: loss && loss.n > 0 ? loss.lost : null, n: loss && loss.n > 0 ? loss.n : null, down: speed?.down ?? null, up: speed?.up ?? null, server: speed?.server ?? null });
    rows.push(row);
  }
  for (const [date, list] of speedByDay) {
    const d = days.get(date);
    if (d) d.speed = speedStats(list);
  }

  // Ausreißer (nur gezählt, nach vermuteter Ursache)
  const spikesTotal: Partial<Record<SpikeGroup, number>> = {};
  for (const r of summary) {
    if (r.kind !== "spike") continue;
    const n = finite(r.countSum) !== null && r.countSum > 0 ? r.countSum : Math.max(0, finite(r.rows) ?? 0);
    if (!n) continue;
    const g = spikeGroup(r.cause);
    const d = day(r.hourStart);
    d.spikesByCause[g] = (d.spikesByCause[g] ?? 0) + n;
    spikesTotal[g] = (spikesTotal[g] ?? 0) + n;
  }
  for (const d of days.values()) d.slowByTarget.sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));

  const dayList = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const header: IspLogResult["header"] = {
    from,
    to,
    timeZone: tz,
    utcOffset: rangeOffsetLabel(from, to, tz),
    targets: targetList,
    hours: coveredHours(covered),
    days: dayList.filter((d) => d.coveredMs > 0).length,
    wifiShare: covered > 0 ? wifi / covered : 0,
    vpnShare: covered > 0 ? vpn / covered : 0,
    otherNets: otherNets.size,
    truncated: input.truncated,
  };
  const sum = (f: (d: IspLogDay) => number) => dayList.reduce((a, d) => a + f(d), 0);
  const totals: IspLogResult["totals"] = {
    internetOutages: sum((d) => d.internetOutages),
    internetOutageS: sum((d) => d.internetOutageS),
    otherOutages: sum((d) => d.homeNetworkOutages + d.targetOnlyOutages + d.pcOutages + d.unknownOutages),
    lossWindows: sum((d) => d.lossWindows),
    slowMinutes: sum((d) => d.slowMinutes),
    speedtests: allSpeeds.length,
    downMedian: allSpeeds.length ? median(allSpeeds.map((s) => s.down)) : null,
    spikesByCause: spikesTotal,
  };
  const choice = netChoices(input.hourly, input.summary).find((c) => c.netId === netId);
  const ctx: RenderCtx = { tr, lang, tz, contract, header, totals, days: dayList, rows, netName: netName(choice, tr), now: input.now ?? Date.now() };
  return { header, totals, days: dayList, rows, html: renderHtml(ctx), csv: renderCsv(ctx) };
}

// ---------------------------------------------------------------------------------------------
// Texte für Kopf und Tage (Oberfläche und HTML)
// ---------------------------------------------------------------------------------------------

/** „{hours} Stunden Messzeit an {days} Tagen“ */
export function basisText(h: Pick<IspLogResult["header"], "hours" | "days">, tr: Translate, lang: Language): string {
  const hours = fmtHours(h.hours, lang);
  return h.days === 1 ? tr("ispLog.basisOne", { hours }) : tr("ispLog.basis", { hours, days: h.days });
}

/** WLAN-Anteil ab 1 % (sonst `null`) */
export function wifiShareText(share: number, tr: Translate, lang: Language): string | null {
  return share >= 0.01 ? tr("ispLog.wifiShare", { pct: fmtPct(share, lang) }) : null;
}
export function vpnShareText(share: number, tr: Translate, lang: Language): string | null {
  // Auch ein kleiner Anteil wird genannt (mindestens „1 %“), damit markierte Einträge erklärt sind
  return share > 0 ? tr("ispLog.vpnShare", { pct: fmtPct(Math.max(share, 0.01), lang) }) : null;
}
export function otherNetsText(n: number, tr: Translate): string | null {
  if (n <= 0) return null;
  return n === 1 ? tr("ispLog.otherNetsOne") : tr("ispLog.otherNets", { n });
}

/** Andere Aussetzer eines Tages nach Umfang (nur vorkommende), sonst „0“ */
export function otherOutagesText(d: Pick<IspLogDay, "homeNetworkOutages" | "targetOnlyOutages" | "pcOutages" | "unknownOutages">, tr: Translate): string {
  const parts = (
    [
      ["home", d.homeNetworkOutages],
      ["target", d.targetOnlyOutages],
      ["pc", d.pcOutages],
      ["unknown", d.unknownOutages],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([k, n]) => tr(`ispLog.days.otherPart.${k}`, { n }));
  return parts.length ? parts.join(" · ") : "0";
}

export function speedLineText(s: IspLogSpeed, contract: IspLogSettings, tr: Translate, lang: Language): string {
  const n = (v: number) => (Number.isFinite(v) ? fmtNum(v, 1, lang) : "–");
  const line = tr("ispLog.days.speedLine", { n: s.n, downMin: n(s.downMin), downMed: n(s.downMedian), upMin: n(s.upMin), upMed: n(s.upMedian) });
  const pct = contractPctText(s.downMedian, contract, tr, lang);
  return pct ? `${line} · Median: ${pct}` : line;
}

// ---------------------------------------------------------------------------------------------
// HTML (eine Datei, druckbar, ohne Skripte und externe Quellen; einziger Link: breitbandmessung.de)
// ---------------------------------------------------------------------------------------------

interface RenderCtx {
  tr: Translate;
  lang: Language;
  tz: string;
  contract: IspLogSettings;
  header: IspLogResult["header"];
  totals: IspLogResult["totals"];
  days: IspLogDay[];
  rows: IspLogRow[];
  netName: string;
  now: number;
}

/** HTML-Text maskieren */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const CSS = `
*{box-sizing:border-box}
body{margin:0;padding:24px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#15171c;background:#fff}
main{max-width:1000px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:26px 0 8px;border-bottom:1px solid #d9dce3;padding-bottom:4px}
.sub{color:#5b6070;margin:0 0 16px}
table{width:100%;border-collapse:collapse;margin:6px 0}
th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid #e6e8ee}
th{background:#f3f4f7;font-weight:600;font-size:12px}
table.meta th{width:30%;background:transparent}
.note{border:2px solid #b4690e;background:#fff8ec;border-radius:8px;padding:12px 14px;margin:14px 0}
.note h2{border:0;margin:0 0 6px;padding:0;font-size:15px}
.note p{margin:6px 0}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:8px 0}
.kpi{border:1px solid #d9dce3;border-radius:8px;padding:8px 10px}
td.day{white-space:nowrap}
.kpi b{display:block;font-size:20px}
.muted{color:#5b6070}
.small{font-size:11.5px}
.internet{color:#b3261e;font-weight:600}
tr.vpn td{background:#f4f1ff}
a{color:#1a56c4}
@page{size:A4;margin:14mm}
@media print{body{padding:0;font-size:11px}h2{break-after:avoid}tr,.note,.kpi{break-inside:avoid}thead{display:table-header-group}}
`;

function renderHtml(c: RenderCtx): string {
  const { tr, lang, tz, header: h, totals, contract } = c;
  const e = escapeHtml;
  const none = tr("ispLog.report.none");
  const num = (v: number | null, digits = 0) => (v === null || !Number.isFinite(v) ? none : fmtNum(v, digits, lang));
  const metaRow = (k: string, v: string) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`;

  const targets = h.targets.length ? h.targets.map((t) => `${e(t.label)} (${e(t.methodText)})`).join("<br>") : none;
  const contractParts: string[] = [];
  if (contract.contractDownMbps !== null || contract.contractUpMbps !== null) {
    contractParts.push(`${e(tr("ispLog.report.contractMax"))}: ${e(tr("ispLog.report.contractValue", { down: num(contract.contractDownMbps), up: num(contract.contractUpMbps) }))}`);
  }
  if (contract.contractDownNormalMbps !== null) contractParts.push(`${e(tr("ispLog.report.contractNormal"))}: ${e(num(contract.contractDownNormalMbps))} Mbit/s`);
  if (contract.contractDownMinMbps !== null) contractParts.push(`${e(tr("ispLog.report.contractMin"))}: ${e(num(contract.contractDownMinMbps))} Mbit/s`);
  const notes = [wifiShareText(h.wifiShare, tr, lang), vpnShareText(h.vpnShare, tr, lang), otherNetsText(h.otherNets, tr), h.truncated ? tr("ispLog.truncated") : null, tr("ispLog.otherDevices")].filter((x): x is string => !!x);

  const meta = [
    metaRow(tr("ispLog.report.period"), `${e(dateTimeText(h.from, tz, lang))} – ${e(dateTimeText(h.to, tz, lang))}`),
    metaRow(tr("ispLog.report.timeZone"), e(zoneText(h.timeZone, h.utcOffset))),
    metaRow(tr("ispLog.report.net"), e(c.netName)),
    metaRow(tr("ispLog.report.targets"), targets),
    metaRow(tr("ispLog.report.basis"), e(basisText(h, tr, lang))),
    metaRow(tr("ispLog.report.contract"), contractParts.length ? contractParts.join("<br>") : e(tr("ispLog.report.contractNone"))),
    metaRow(tr("ispLog.report.note"), notes.map(e).join("<br>")),
  ].join("");

  const bnetza = `<section class="note"><h2>${e(tr("ispLog.bnetza.title"))}</h2><p>${e(tr("ispLog.bnetza.text", { stand: BNETZA_STAND }))}</p>${
    totals.internetOutages > 0 ? `<p><b>${e(tr("ispLog.bnetza.ticket"))}</b></p>` : ""
  }<p><a href="${BNETZA_URL}">${BNETZA_URL}</a></p></section>`;

  const kpi = (label: string, value: string, sub?: string) => `<div class="kpi"><span class="muted small">${e(label)}</span><b>${e(value)}</b>${sub ? `<span class="muted small">${e(sub)}</span>` : ""}</div>`;
  const kpis = `<div class="kpis">${[
    kpi(tr("ispLog.kpi.internet"), String(totals.internetOutages), tr("ispLog.kpi.internetSub", { duration: durationText(totals.internetOutageS, tr) })),
    kpi(tr("ispLog.kpi.other"), String(totals.otherOutages), tr("ispLog.kpi.otherSub")),
    kpi(tr("ispLog.kpi.loss"), String(totals.lossWindows), tr("ispLog.kpi.lossSub")),
    kpi(tr("ispLog.kpi.slow"), String(totals.slowMinutes), tr("ispLog.kpi.slowSub")),
    kpi(tr("ispLog.kpi.speedtests"), String(totals.speedtests), totals.downMedian === null ? tr("ispLog.kpi.speedtestsNone") : tr("ispLog.kpi.speedtestsSub", { down: fmtNum(totals.downMedian, 1, lang) })),
  ].join("")}</div><p>${e(spikeText(totals.spikesByCause, tr))}</p>`;

  const dayRows = c.days
    .map((d) => {
      const internet = d.internetOutages ? `<span class="internet">${d.internetOutages}</span> · ${e(durationText(d.internetOutageS, tr))}` : "0";
      const loss = d.lossWindows ? `${d.lossWindows}${d.lossWorst ? `<br><span class="small muted">max. ${e(lossText(d.lossWorst, tr, lang))}</span>` : ""}` : "0";
      const slow = d.slowMinutes ? `${d.slowMinutes}${d.slowByTarget.map((s) => `<br><span class="small muted">${e(tr("ispLog.days.perTarget", { label: s.label, n: s.minutes }))}</span>`).join("")}` : "0";
      const speed = d.speed ? e(speedLineText(d.speed, contract, tr, lang)) : "0";
      return `<tr><td class="day">${e(dayText(d.date, tr, lang))}</td><td>${internet}</td><td class="small">${e(otherOutagesText(d, tr))}</td><td>${loss}</td><td>${slow}</td><td class="small">${spikeTotal(d.spikesByCause) ? e(spikeText(d.spikesByCause, tr)) : "0"}</td><td>${d.measuredHours}</td><td class="small">${speed}</td></tr>`;
    })
    .join("");
  const dayTable = c.days.length
    ? `<table><thead><tr>${["date", "internet", "other", "loss", "slow", "spikes", "hours", "speed"].map((k) => `<th>${e(tr(`ispLog.days.${k}`))}</th>`).join("")}</tr></thead><tbody>${dayRows}</tbody></table><p class="small muted">${e(tr("ispLog.distanceNote"))}</p>`
    : `<p>${e(tr("ispLog.list.none"))}</p>`;

  const shown = c.rows.slice(0, HTML_MAX_ROWS);
  const listRows = shown
    .map((r) => {
      const scope = r.kind === "outage" && r.scope ? `<span class="${r.scope === "internet" ? "internet" : ""}">${e(tr(`ispLog.scope.${r.scope}`))}</span>` : "";
      const target = r.kind === "speedtest" || r.kind === "quiet" ? "" : e(r.targetLabel ?? "");
      const conn = r.kind === "quiet" ? "" : e(connText(r.connection, tr));
      return `<tr${r.connection === "vpn" ? ' class="vpn"' : ""}><td>${e(dateTimeText(r.t, tz, lang, true))}</td><td>${r.endT !== null ? e(dateTimeText(r.endT, tz, lang, true)) : ""}</td><td>${e(tr(`ispLog.kind.${r.kind}`))}</td><td>${scope}</td><td>${target}${target && r.method ? ` <span class="small muted">${e(methodText(r.method, r.targetKey, tr))}</span>` : ""}</td><td>${conn}</td><td>${e(r.text)}</td></tr>`;
    })
    .join("");
  const listTable = c.rows.length
    ? `<table><thead><tr>${["time", "end", "kind", "scope", "target", "connection", "value"].map((k) => `<th>${e(tr(`ispLog.list.${k}`))}</th>`).join("")}</tr></thead><tbody>${listRows}</tbody></table>${
        c.rows.length > HTML_MAX_ROWS ? `<p class="muted">${e(tr("ispLog.list.more", { n: c.rows.length - HTML_MAX_ROWS }))}</p>` : ""
      }`
    : `<p>${e(tr("ispLog.list.none"))}</p>`;

  const title = `${tr("ispLog.report.heading")} · ${dateTimeText(h.from, tz, lang)} – ${dateTimeText(h.to, tz, lang)}`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${e(tr("ispLog.report.heading"))}</h1>
<p class="sub">${e(dateTimeText(h.from, tz, lang))} – ${e(dateTimeText(h.to, tz, lang))} · ${e(zoneText(h.timeZone, h.utcOffset))}</p>
${bnetza}
<table class="meta"><tbody>${meta}</tbody></table>
<h2>${e(tr("ispLog.report.summary"))}</h2>
${kpis}
<h2>${e(tr("ispLog.days.title"))}</h2>
${dayTable}
<h2>${e(tr("ispLog.list.title"))}</h2>
${listTable}
<p class="small muted">${e(tr("ispLog.report.honest"))}</p>
<p class="small muted">${e(tr("ispLog.report.created", { date: dateTimeText(c.now, tz, lang) }))}</p>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// CSV (UTF-8, Trennzeichen „;“, Zahlen mit Punkt; die Datei-Ausgabe setzt das BOM davor)
// ---------------------------------------------------------------------------------------------

/** Feld maskieren: mit `;`, `"` oder Zeilenumbruch in Anführungszeichen (`"` verdoppelt) */
export function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Textfeld: zusätzlich kein Formelbeginn (=, +, -, @) für Tabellenprogramme */
const csvText = (value: string) => csvField(/^[=+\-@]/.test(value) ? `'${value}` : value);
const csvNum = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "" : String(Math.round(v * 10) / 10));

function renderCsv(c: RenderCtx): string {
  const { tr, tz } = c;
  const lines = [tr("ispLog.csv.header")];
  const line = (r: IspLogRow, art: string, value: number | null, unit: string, extra: { scope?: string; target?: string; lost?: number | null; n?: number | null } = {}) =>
    [
      isoLocal(r.t, tz),
      isoUtc(r.t),
      r.endT !== null ? isoLocal(r.endT, tz) : "",
      csvText(art),
      csvText(extra.scope ?? ""),
      csvText(extra.target ?? r.targetLabel ?? ""),
      csvText(methodText(r.method, r.targetKey, tr)),
      csvText(r.kind === "quiet" ? "" : connText(r.connection, tr)),
      csvNum(value),
      csvText(unit),
      csvNum(extra.lost),
      csvNum(extra.n),
      "",
      r.sessionId === null ? "" : String(r.sessionId),
    ].join(";");
  for (const r of c.rows) {
    switch (r.kind) {
      case "outage":
        lines.push(line(r, tr("ispLog.kind.outage"), r.value ?? (r.endT !== null ? (r.endT - r.t) / 1000 : null), "s", { scope: tr(`ispLog.scope.${r.scope ?? "unknown"}`) }));
        break;
      case "loss": {
        const d = rowDetail(r);
        lines.push(line(r, tr("ispLog.kind.loss"), r.value, "%", { lost: d.lost, n: d.n }));
        break;
      }
      case "slow":
        lines.push(line(r, tr("ispLog.kind.slow"), r.value, "ms"));
        break;
      case "speedtest": {
        const s = rowDetail(r);
        const target = s.server ? `Cloudflare ${s.server}` : "Cloudflare";
        lines.push(line(r, tr("ispLog.csv.speedDown"), s.down ?? r.value, "Mbit/s", { target }));
        if (s.up !== null) lines.push(line(r, tr("ispLog.csv.speedUp"), s.up, "Mbit/s", { target }));
        break;
      }
      case "quiet":
        lines.push(line(r, tr("ispLog.kind.quiet"), null, "", { scope: r.text }));
        break;
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

