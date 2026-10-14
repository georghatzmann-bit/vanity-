/**
 * Match-Zeitleiste – reine Logik (Kopf, gleitende Schwankung, Zoom, Ausreißer-Markierungen, Bänder,
 * Zeitachse). Vertrag: docs/API.md, „Match-Zeitleiste“. Die Darstellung steckt in
 * components/reports/Timeline*.tsx, die Bildkarte in ./cardexport.ts.
 */
import { compressTimeline, countSpikes, pingGrade, spikeLimit, summarize } from "./grade";
import type { Grade, LagCause, NetEvent, PingSample, SessionReport, SessionTimeline, SpikeDetail, TimelinePoint, TimelineZoom } from "./types";

/** Gleitende Schwankung über die letzten so vielen Antworten */
export const JITTER_WINDOW = 10;

/** Sichtbare Spanne je Zoom-Stufe (ms); `null` = ganze Runde */
export const ZOOM_SPANS: Record<TimelineZoom, number | null> = { all: null, "5m": 5 * 60_000, "1m": 60_000 };
export const ZOOMS: TimelineZoom[] = ["all", "5m", "1m"];

/** Ereignisarten mit Zeitraum, die als Band gezeichnet werden */
export type BandKind = "outage" | "loss" | "slow" | "quiet";

export interface Band {
  kind: BandKind;
  from: number;
  to: number;
  event: NetEvent;
}

/** Ausreißer-Markierung auf der Ping-Spur */
export interface SpikeMark {
  t: number;
  rtt: number;
  /** Ursache nur, wenn die Markierung zu einem `spike`-Ereignis gehört (gleiche Sekunde ± 1 Takt) */
  cause: LagCause | null;
  event: NetEvent | null;
}

/** Kopf der Detailseite und Inhalt der Bildkarte */
export interface HeaderModel {
  gameName: string;
  gameId: string | null;
  start: number;
  end: number;
  durationS: number;
  grade: Grade;
  avg: number | null;
  min: number | null;
  max: number | null;
  jitter: number | null;
  /** 0–1 */
  loss: number;
  /** Ausreißer der ganzen Runde (`report.spikes`) */
  spikes: number;
  /** Namen der Messziele (keine Adressen) */
  targets: string[];
  /** Ursachen der Momentaufnahmen (Σ `detail.count` je Ursache) */
  causes: Partial<Record<LagCause, number>>;
  /** untersuchte Ausreißer (Σ `detail.count`, höchstens `spikes`) */
  examined: number;
  /** Kopf aus einem gespeicherten Bericht (sonst aus den Messwerten berechnet) */
  fromReport: boolean;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Zählung eines Ereignisses (`detail.count`, sonst 1) */
export function eventCount(e: NetEvent): number {
  const n = (e.detail as Partial<SpikeDetail> | null)?.count;
  return finite(n) && n > 0 ? Math.round(n) : 1;
}

/** Ursachen-Zählung über die `spike`-Ereignisse (ohne Ursache zählt als „unklar“) */
export function causeCounts(events: readonly NetEvent[]): Partial<Record<LagCause, number>> {
  const out: Partial<Record<LagCause, number>> = {};
  for (const e of events) {
    if (e.kind !== "spike") continue;
    const c: LagCause = e.cause ?? "unknown";
    out[c] = (out[c] ?? 0) + eventCount(e);
  }
  return out;
}

const sumCounts = (c: Partial<Record<LagCause, number>>) => Object.values(c).reduce<number>((a, n) => a + (finite(n) && n > 0 ? n : 0), 0);

/** Punkte → Messwerte (für `summarize`) */
const asSamples = (points: readonly TimelinePoint[]): PingSample[] => points.map(([t, rtt]) => ({ targetId: "timeline", t, rtt }));

/**
 * Bericht aus einer Sitzung ohne gespeicherten Bericht (Einstieg über die Sitzungsliste): Kennzahlen mit
 * `summarize` über die Punkte, Ausreißer mit `countSpikes`, Kurve verdichtet wie bei echten Berichten.
 */
export function reportFromTimeline(tl: SessionTimeline, gameName: string): SessionReport {
  const st = summarize("timeline", asSamples(tl.points));
  const rtts = tl.points.map((p) => p[1]);
  return {
    id: `session-${tl.sessionId}`,
    gameId: tl.gameId || null,
    gameName,
    start: tl.start,
    end: tl.end,
    targetLabel: tl.targets[tl.targets.length - 1]?.label ?? "",
    avgPing: st.avg,
    minPing: st.min,
    maxPing: st.max,
    jitter: st.jitter,
    loss: st.loss,
    spikes: countSpikes(rtts),
    timeline: compressTimeline(tl.points.map((p) => [p[0], p[1]] as [number, number | null])),
    boosted: false,
    grade: pingGrade(st.avg, st.jitter, st.loss) ?? "F",
    sessionId: tl.sessionId,
  };
}

/**
 * Kopf (eindeutige Ausreißer-Zahlen): „Ausreißer“ = `report.spikes` (Regel über die ganze Runde); Ursachen aus
 * den `spike`-Ereignissen der Zeitleiste (sonst aus `report.lagCauses`); „{n} von {spikes} untersucht“ mit
 * `n` = Σ `detail.count`, höchstens `spikes`.
 */
export function headerModel(report: SessionReport, timeline: SessionTimeline | null): HeaderModel {
  const causes = timeline ? causeCounts(timeline.events) : { ...(report.lagCauses ?? {}) };
  const spikes = Math.max(0, Math.round(report.spikes || 0));
  const targets = timeline?.targets.length ? timeline.targets.map((x) => x.label) : report.targetLabel ? [report.targetLabel] : [];
  return {
    gameName: report.gameName,
    gameId: report.gameId,
    start: report.start,
    end: report.end,
    durationS: Math.max(0, Math.round((report.end - report.start) / 1000)),
    grade: report.grade,
    avg: report.avgPing,
    min: report.minPing,
    max: report.maxPing,
    jitter: report.jitter,
    loss: report.loss,
    spikes,
    targets: [...new Set(targets.filter(Boolean))],
    causes,
    examined: Math.min(sumCounts(causes), spikes),
    fromReport: !report.id.startsWith("session-"),
  };
}

/**
 * Gleitende Schwankung: je Punkt das Mittel von |Δrtt| aufeinanderfolgender Antworten unter den letzten
 * `window` Antworten (inklusive dieser). Verlust oder weniger als 2 Antworten → null.
 */
export function rollingJitter(points: readonly TimelinePoint[], window = JITTER_WINDOW): (number | null)[] {
  const out: (number | null)[] = [];
  const answers: number[] = [];
  const diffs: number[] = [];
  let sum = 0;
  for (const p of points) {
    const rtt = p[1];
    if (!finite(rtt)) {
      out.push(null);
      continue;
    }
    if (answers.length) {
      const d = Math.abs(rtt - answers[answers.length - 1]);
      diffs.push(d);
      sum += d;
    }
    answers.push(rtt);
    if (answers.length > window) {
      answers.shift();
      sum -= diffs.shift() ?? 0;
    }
    out.push(diffs.length ? Math.max(0, sum / diffs.length) : null);
  }
  return out;
}

/** Typischer Abstand der Punkte (Median, ms); weniger als 2 Punkte → 1000 */
export function estimateInterval(points: readonly TimelinePoint[]): number {
  if (points.length < 2) return 1000;
  const step = Math.max(1, Math.floor(points.length / 2000));
  const d: number[] = [];
  for (let i = step; i < points.length; i += step) {
    const dt = (points[i][0] - points[i - step][0]) / step;
    if (dt > 0) d.push(dt);
  }
  if (!d.length) return 1000;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/**
 * Ausreißer: **alle** Punkte über der Grenze aus `countSpikes` (über die Punkte der Zeitleiste); ein Ursachen-
 * Symbol nur an Punkten, die zu einem `spike`-Ereignis gehören (gleiche Sekunde ± 1 Takt, nächstes Ereignis).
 */
export function spikeMarks(points: readonly TimelinePoint[], events: readonly NetEvent[], intervalMs = estimateInterval(points)): { limit: number | null; marks: SpikeMark[] } {
  const ok = points.map((p) => p[1]).filter(finite);
  const limit = spikeLimit(ok);
  if (limit === null) return { limit, marks: [] };
  const spikes = events.filter((e) => e.kind === "spike").sort((a, b) => a.t - b.t);
  const tolerance = 1000 + Math.max(0, intervalMs);
  const marks: SpikeMark[] = [];
  for (const [t, rtt] of points) {
    if (!finite(rtt) || rtt <= limit) continue;
    let best: NetEvent | null = null;
    for (const e of spikes) {
      if (Math.abs(e.t - t) > tolerance) continue;
      if (!best || Math.abs(e.t - t) < Math.abs(best.t - t)) best = e;
    }
    marks.push({ t, rtt, cause: best ? (best.cause ?? "unknown") : null, event: best });
  }
  return { limit, marks };
}

/** Zeiträume (`outage`, `loss`, `slow`, `quiet`) als Bänder; ohne Ende mindestens ein Takt breit */
export function eventBands(events: readonly NetEvent[], intervalMs = 1000): Band[] {
  const out: Band[] = [];
  for (const e of events) {
    if (e.kind !== "outage" && e.kind !== "loss" && e.kind !== "slow" && e.kind !== "quiet") continue;
    const to = finite(e.endT) && e.endT > e.t ? e.endT : e.t + Math.max(1000, intervalMs);
    out.push({ kind: e.kind, from: e.t, to, event: e });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Breite des Inhalts (px) je Zoom: „ganze Runde“ = sichtbare Breite, sonst Spanne × Breite */
export function contentWidth(durationMs: number, viewportPx: number, zoom: TimelineZoom): number {
  const span = ZOOM_SPANS[zoom];
  const vp = Math.max(1, viewportPx);
  if (span === null || durationMs <= span) return vp;
  return Math.ceil((vp * durationMs) / span);
}

/** Sichtbarer Zeitraum für eine Scroll-Position */
export function visibleRange(start: number, end: number, scrollLeft: number, viewportPx: number, contentPx: number): [number, number] {
  const dur = Math.max(1, end - start);
  const msPerPx = dur / Math.max(1, contentPx);
  const from = start + Math.max(0, scrollLeft) * msPerPx;
  return [from, Math.min(end, from + viewportPx * msPerPx)];
}

/** Scroll-Position, die beim Zoomen die Zeit `centerT` in der Mitte hält */
export function scrollForCenter(start: number, end: number, centerT: number, viewportPx: number, contentPx: number): number {
  const dur = Math.max(1, end - start);
  const x = ((centerT - start) / dur) * contentPx - viewportPx / 2;
  return Math.max(0, Math.min(Math.max(0, contentPx - viewportPx), x));
}

/** Index des Punkts, der `t` am nächsten liegt (Punkte nach Zeit sortiert); keine Punkte → -1 */
export function nearestIndex(points: readonly TimelinePoint[], t: number): number {
  if (!points.length) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1][0] - t) <= Math.abs(points[lo][0] - t)) return lo - 1;
  return lo;
}

/** Erster Index mit `t >= from` (binäre Suche) */
export function lowerBound(points: readonly TimelinePoint[], from: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const TICK_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800].map((s) => s * 1000);

/** Teilstriche der Zeitachse (ms seit Rundenbeginn) mit mindestens `minPx` Abstand */
export function axisTicks(start: number, from: number, to: number, pxPerMs: number, minPx = 84): number[] {
  const step = TICK_STEPS.find((s) => s * pxPerMs >= minPx) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const first = Math.ceil((from - start) / step) * step;
  const out: number[] = [];
  for (let off = first; start + off <= to && out.length < 400; off += step) out.push(off);
  return out;
}

/** Spielzeit als „m:ss“ bzw. „h:mm:ss“ */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** „Schöne“ Obergrenze einer Skala (1/2/2,5/5 × 10^n), mindestens `min` */
export function niceCeil(v: number, min = 1): number {
  const x = Math.max(min, finite(v) ? v : min);
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

/** Obergrenze der Ping-Skala: 99. Perzentil bzw. Ausreißer-Grenze mit Luft (einzelne Riesenwerte stauchen die Kurve nicht) */
export function pingScaleMax(points: readonly TimelinePoint[], limit: number | null): number {
  const ok = points.map((p) => p[1]).filter(finite).sort((a, b) => a - b);
  if (!ok.length) return 100;
  const p99 = ok[Math.min(ok.length - 1, Math.floor(ok.length * 0.99))];
  return niceCeil(Math.max(p99 * 1.25, (limit ?? 0) * 1.15, 40), 40);
}
