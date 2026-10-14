/**
 * Demo-Backend: Match-Zeitleiste (`net_session_timeline`). Vertrag: docs/API.md, „Match-Zeitleiste“ (Demo).
 *
 * Deterministische Rohdaten je Sitzung (eigener Hash, kein Verbrauch des gemeinsamen Zufalls): 1 s Takt,
 * ein Zielwechsel nach 40 s (Region → Spielserver), 3 Ausreißer mit den Ursachen `router`, `isp` und
 * `unknown`, ein kurzer Aussetzer, CPU 20–70 %, Datenverkehr rx/tx. Gibt es zur Sitzung einen Demo-Bericht,
 * folgt die Kurve dessen verdichtetem Verlauf – Kopf und Zeitleiste passen so zusammen.
 * Unbekannte Sitzung → „Für diese Sitzung gibt es keine Messwerte.“
 */
import type { LagCause, NetEvent, Reason, Session, SessionReport, SessionTimeline, SpikeDetail, TimelinePoint, TimelineTarget } from "../types";
import type { MockHandlers } from "./core";

const NO_SAMPLES = "Für diese Sitzung gibt es keine Messwerte.";
/** Netz der Demo (gleiche Kennung wie im Kalender) */
const DEMO_NET_ID = "7c41e09b2d5f";
/** Rohdaten höchstens so viele Punkte (wie im Backend: darüber wird zusammengefasst) */
const MAX_POINTS = 43_200;
/** Zielwechsel nach so vielen Sekunden */
const SWITCH_AFTER_S = 40;

const REGION: TimelineTarget = { key: "aws-eu-central-1", label: "Frankfurt (AWS)", method: "tcp" };
const SERVER: TimelineTarget = { key: "valve-cs2-fra", label: "CS2 Frankfurt (Valve)", method: "icmp" };

/** Deterministischer Wert 0–1 aus ganzen Zahlen */
function hash(...parts: number[]): number {
  let h = 0x2545f491;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Grundkurve aus dem verdichteten Bericht (lineare Interpolation; Verlust bleibt Verlust) */
function baseFrom(report: SessionReport | null, start: number, fallback: number): (t: number) => number | null {
  const tl = report?.timeline?.filter(([t]) => Number.isFinite(t)) ?? [];
  if (tl.length < 2) return () => fallback;
  const ok = tl.map(([, v]) => v).filter((v): v is number => v !== null);
  const avg = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : fallback;
  let j = 0;
  return (t: number) => {
    while (j < tl.length - 2 && tl[j + 1][0] <= t) j++;
    const [t0, v0] = tl[j];
    const [t1, v1] = tl[j + 1];
    if (t < start) return v0 ?? avg;
    if (v0 === null) return null;
    // einzelne Spitzen des Berichts nicht übernehmen (die Demo setzt eigene Ausreißer)
    const a = Math.min(v0, avg * 1.6);
    const b = Math.min(v1 ?? v0, avg * 1.6);
    const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    return a + (b - a) * f;
  };
}

interface DemoSpike {
  /** Anteil der Sitzung */
  at: number;
  cause: LagCause;
  reasons: Reason[];
  count: number;
  snap: NonNullable<SpikeDetail["snap"]>;
}

const SNAP_BASE: NonNullable<SpikeDetail["snap"]> = { conn: "ethernet", vpn: false, hops: [], gw: 1.2, gwB: 1.1, tgt: null, rssi: null, sig: null, rx: 3.2, tx: 0.6, cpu: 34 };

const DEMO_SPIKES: DemoSpike[] = [
  { at: 0.23, cause: "router", reasons: ["gatewaySlow"], count: 1, snap: { ...SNAP_BASE, gw: 38.4, hops: [[1, 37.9, "lan"], [2, 44.8, "isp"], [3, 46.1, "isp"]], tgt: 171 } },
  { at: 0.52, cause: "isp", reasons: ["ispHopSlow", "lineBusyPossible"], count: 1, snap: { ...SNAP_BASE, hops: [[1, 1.3, "lan"], [2, 58.2, "isp"], [3, 61.5, "isp"]], tgt: 158 } },
  { at: 0.79, cause: "unknown", reasons: ["spikeGone"], count: 1, snap: { ...SNAP_BASE, hops: [[1, 1.2, "lan"], [2, 6.4, "isp"], [3, 7.3, "isp"]], tgt: 24 } },
];
/** Kurzer Aussetzer: Anteil der Sitzung und Länge (s) */
const OUTAGE_AT = 0.64;
const OUTAGE_S = 6;

/** Zeitleiste einer Demo-Sitzung (rein, deterministisch) */
export function demoSessionTimeline(session: Session, report: SessionReport | null): SessionTimeline {
  const seconds = Math.max(1, Math.min(MAX_POINTS, Math.floor((session.end - session.start) / 1000)));
  const id = session.id;
  const fallback = 18 + hash(id, 1) * 24;
  const base = baseFrom(report, session.start, fallback);
  const second = report && report.targetLabel && report.targetLabel !== REGION.label ? { ...SERVER, label: report.targetLabel, key: report.targetLabel.includes("AWS") ? "aws-eu-west-3" : SERVER.key, method: report.targetLabel.includes("AWS") ? ("tcp" as const) : SERVER.method } : SERVER;
  const switchAt = session.start + SWITCH_AFTER_S * 1000;
  const spikeIdx = DEMO_SPIKES.map((s) => Math.max(SWITCH_AFTER_S + 5, Math.floor(seconds * s.at)));
  const outageFrom = Math.max(SWITCH_AFTER_S + 10, Math.floor(seconds * OUTAGE_AT));
  const points: TimelinePoint[] = [];
  for (let i = 0; i < seconds; i++) {
    const t = session.start + i * 1000;
    const b = base(t);
    // Region vor dem Zielwechsel etwas weiter weg als der Spielserver
    const shift = t < switchAt ? 6 : 0;
    let rtt: number | null = b === null ? null : b + shift + (hash(id, i, 2) - 0.5) * 5 + Math.sin(i / 37) * 1.6;
    const k = spikeIdx.indexOf(i);
    if (k >= 0 && rtt !== null) rtt = Math.max(rtt * 2.6, rtt + 85) + hash(id, k, 3) * 30;
    if (i >= outageFrom && i < outageFrom + OUTAGE_S) rtt = null;
    else if (k < 0 && rtt !== null && hash(id, i, 4) < 0.004) rtt = null;
    const cpu = Math.round(45 + Math.sin(i / 83) * 18 + (hash(id, i, 5) - 0.5) * 14);
    const rx = 2 + Math.abs(Math.sin(i / 151)) * 9 + hash(id, i, 6) * 3;
    const tx = 0.3 + hash(id, i, 7) * 0.9 + (Math.sin(i / 211) > 0.92 ? 6 : 0);
    points.push([t, rtt === null ? null : round1(Math.max(1, rtt)), Math.min(70, Math.max(20, cpu)), round1(rx), round1(tx)]);
  }

  const events: NetEvent[] = [];
  const ev = (partial: Partial<NetEvent> & Pick<NetEvent, "kind" | "t">): NetEvent => ({
    id: 0,
    endT: null,
    targetKey: second.key,
    targetLabel: second.label,
    method: second.method,
    netId: DEMO_NET_ID,
    connection: "ethernet",
    value: null,
    cause: null,
    scope: null,
    sessionId: id,
    detail: null,
    ...partial,
  });
  DEMO_SPIKES.forEach((s, k) => {
    const p = points[spikeIdx[k]];
    if (!p || p[1] === null) return;
    const ok = points.map((x) => x[1]).filter((v): v is number => v !== null);
    const sorted = [...ok].sort((a, b) => a - b);
    const baseline = round1(sorted[Math.floor(sorted.length / 2)] ?? 0);
    const detail: SpikeDetail = { count: s.count, baseline, limit: round1(Math.max(baseline * 2, baseline + 40)), cpuHigh: false, reasons: s.reasons, snap: { ...s.snap, cpu: p[2] } };
    events.push(ev({ kind: "spike", t: p[0], value: p[1], cause: s.cause, detail }));
  });
  if (outageFrom + OUTAGE_S <= seconds) {
    const t = session.start + outageFrom * 1000;
    events.push(ev({ kind: "outage", t, endT: t + (OUTAGE_S - 1) * 1000, value: OUTAGE_S, scope: "internet", detail: { checks: { link: true, gw: true, ext: false } } }));
  }
  events.sort((a, b) => a.t - b.t);
  events.forEach((e, i) => (e.id = id * 100 + i + 1));

  const hasSwitch = seconds > SWITCH_AFTER_S;
  return {
    sessionId: id,
    gameId: session.gameId,
    start: session.start,
    end: session.end,
    targets: hasSwitch ? [REGION, second] : [REGION],
    targetChanges: hasSwitch ? [{ t: switchAt, key: second.key }] : [],
    merged: 1,
    points,
    events,
  };
}

export const timelineMock: MockHandlers = {
  net_session_timeline: async (a) => {
    const sessionId = Number(a.sessionId);
    // Zugriff auf die Demo-Datenbank erst beim Aufruf (vermeidet einen Import-Kreis beim Laden)
    const { mockInvoke } = await import("../mock");
    const sessions = await mockInvoke<Session[]>("sessions_range", { from: 0, to: Number.MAX_SAFE_INTEGER });
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || session.end - session.start < 1000) throw new Error(NO_SAMPLES);
    const reports = await mockInvoke<SessionReport[]>("db_list", { table: "reports" });
    return demoSessionTimeline(session, reports.find((r) => r.sessionId === sessionId) ?? null);
  },
};
