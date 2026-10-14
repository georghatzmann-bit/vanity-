import { describe, expect, it } from "vitest";
import { de } from "../locales/de";
import { en } from "../locales/en";
import { countSpikes, spikeLimit } from "./grade";
import { demoSessionTimeline } from "./mock/timeline";
import {
  ZOOMS,
  axisTicks,
  causeCounts,
  contentWidth,
  estimateInterval,
  eventBands,
  formatElapsed,
  headerModel,
  nearestIndex,
  niceCeil,
  reportFromTimeline,
  rollingJitter,
  scrollForCenter,
  spikeMarks,
  visibleRange,
} from "./timeline";
import { OUTAGE_SCOPES, type NetEvent, type SessionReport, type SessionTimeline, type TimelinePoint } from "./types";

const tr = (dict: unknown) => (key: string, vars?: Record<string, string | number>) => {
  let cur: unknown = dict;
  for (const p of key.split(".")) cur = (cur as Record<string, unknown>)?.[p];
  if (typeof cur !== "string") throw new Error(`Text fehlt: ${key}`);
  return cur.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));
};
const deT = tr(de);
const enT = tr(en);

const T0 = 1_760_000_000_000;
const pt = (i: number, rtt: number | null): TimelinePoint => [T0 + i * 1000, rtt, 30, 2, 0.5];

function ev(partial: Partial<NetEvent> & Pick<NetEvent, "kind" | "t">): NetEvent {
  return { id: 1, endT: null, targetKey: "aws-eu-central-1", targetLabel: "Frankfurt (AWS)", method: "tcp", netId: "", connection: "ethernet", value: null, cause: null, scope: null, sessionId: 7, detail: null, ...partial };
}

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    id: "rep-1",
    gameId: "g1",
    gameName: "Counter-Strike 2",
    start: T0,
    end: T0 + 600_000,
    targetLabel: "Frankfurt (AWS)",
    avgPing: 24,
    minPing: 18,
    maxPing: 190,
    jitter: 3.2,
    loss: 0.004,
    spikes: 4,
    timeline: [],
    boosted: true,
    grade: "A",
    sessionId: 7,
    ...over,
  };
}

function timeline(points: TimelinePoint[], events: NetEvent[] = []): SessionTimeline {
  return { sessionId: 7, gameId: "g1", start: T0, end: T0 + 600_000, targets: [{ key: "aws-eu-central-1", label: "Frankfurt (AWS)", method: "tcp" }], targetChanges: [], merged: 1, points, events };
}

describe("gleitende Schwankung", () => {
  it("Mittel von |Δrtt| über die letzten 10 Antworten, Verlust = null", () => {
    const pts = [pt(0, 10), pt(1, 20), pt(2, null), pt(3, 15)];
    expect(rollingJitter(pts)).toEqual([null, 10, null, 7.5]);
  });
  it("Fenster rollt: nach 10 Antworten fällt die älteste Differenz heraus", () => {
    // erste Differenz 100, danach nur noch 0
    const vals = [0, 100, ...Array(12).fill(100)];
    const j = rollingJitter(vals.map((v, i) => pt(i, v)));
    expect(j[1]).toBe(100);
    expect(j[9]).toBeCloseTo(100 / 9);
    // Antwort 11 (Index 10): Fenster 1..10 enthält nur noch Differenzen 0
    expect(j[10]).toBe(0);
    expect(j[13]).toBe(0);
  });
  it("kleineres Fenster", () => {
    const j = rollingJitter([pt(0, 10), pt(1, 30), pt(2, 30)], 2);
    expect(j).toEqual([null, 20, 0]);
  });
});

describe("Zoom", () => {
  it("ganze Runde = sichtbare Breite; 5 min/1 min = Spanne × Breite", () => {
    expect(ZOOMS).toEqual(["all", "5m", "1m"]);
    expect(contentWidth(3_600_000, 800, "all")).toBe(800);
    expect(contentWidth(3_600_000, 800, "5m")).toBe(800 * 12);
    expect(contentWidth(3_600_000, 800, "1m")).toBe(800 * 60);
    // kürzer als die Spanne → passt ganz hinein
    expect(contentWidth(40_000, 800, "1m")).toBe(800);
  });
  it("sichtbarer Zeitraum und Mitte halten", () => {
    const cw = contentWidth(600_000, 600, "1m"); // 6000 px
    expect(visibleRange(T0, T0 + 600_000, 0, 600, cw)).toEqual([T0, T0 + 60_000]);
    expect(visibleRange(T0, T0 + 600_000, 3000, 600, cw)).toEqual([T0 + 300_000, T0 + 360_000]);
    const left = scrollForCenter(T0, T0 + 600_000, T0 + 330_000, 600, cw);
    expect(left).toBeCloseTo(3000, 6);
    const [a, b] = visibleRange(T0, T0 + 600_000, left, 600, cw);
    expect((a + b) / 2).toBeCloseTo(T0 + 330_000, 0);
    // am Rand begrenzt
    expect(scrollForCenter(T0, T0 + 600_000, T0, 600, cw)).toBe(0);
    expect(scrollForCenter(T0, T0 + 600_000, T0 + 600_000, 600, cw)).toBe(5400);
  });
  it("Zeitachse und Hilfen", () => {
    expect(axisTicks(T0, T0, T0 + 60_000, 800 / 60_000)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);
    expect(axisTicks(T0, T0 + 61_000, T0 + 3_600_000, 800 / 3_600_000)[0]).toBe(600_000);
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
    expect(niceCeil(37)).toBe(50);
    expect(niceCeil(101)).toBe(200);
    expect(niceCeil(0, 5)).toBe(5);
    expect(estimateInterval([pt(0, 1), pt(1, 1), pt(2, 1)])).toBe(1000);
    expect(nearestIndex([pt(0, 1), pt(1, 1), pt(2, 1)], T0 + 1400)).toBe(1);
    expect(nearestIndex([pt(0, 1), pt(1, 1), pt(2, 1)], T0 + 1600)).toBe(2);
    expect(nearestIndex([], T0)).toBe(-1);
  });
});

describe("Ausreißer-Markierungen", () => {
  const base = Array.from({ length: 60 }, (_, i) => pt(i, 20 + (i % 3)));
  base[10] = pt(10, 150);
  base[30] = pt(30, 140);
  base[50] = pt(50, 170);
  base[20] = pt(20, null);
  it("alle Punkte über der Grenze aus countSpikes; Symbol nur mit spike-Ereignis (± 1 Takt)", () => {
    const events = [ev({ kind: "spike", t: T0 + 10_400, cause: "router" }), ev({ kind: "spike", t: T0 + 33_000, cause: "isp" }), ev({ kind: "outage", t: T0 + 50_000 })];
    const { limit, marks } = spikeMarks(base, events);
    expect(limit).toBe(spikeLimit(base.map((p) => p[1]).filter((v): v is number => v !== null)));
    expect(marks.map((m) => m.t)).toEqual([T0 + 10_000, T0 + 30_000, T0 + 50_000]);
    expect(marks.length).toBe(countSpikes(base.map((p) => p[1])));
    expect(marks[0].cause).toBe("router");
    // 3 s daneben (Takt 1 s → Toleranz 2 s): kein Symbol
    expect(marks[1].cause).toBeNull();
    // outage ist kein spike-Ereignis
    expect(marks[2].event).toBeNull();
  });
  it("Ereignis ohne Ursache zählt als „unklar“; keine Antworten → keine Grenze", () => {
    const { marks } = spikeMarks(base, [ev({ kind: "spike", t: T0 + 50_000 })]);
    expect(marks[2].cause).toBe("unknown");
    expect(spikeMarks([pt(0, null)], [])).toEqual({ limit: null, marks: [] });
  });
});

describe("headerModel", () => {
  const spikeEv = (t: number, cause: NetEvent["cause"], count?: number) => ev({ kind: "spike", t, cause, detail: count ? { count, baseline: 20, limit: 60, cpuHigh: false, reasons: [] } : null });
  it("Kopf = report.spikes, „n von m untersucht“ mit Σ count (höchstens spikes)", () => {
    const tl = timeline([pt(0, 20)], [spikeEv(T0 + 1000, "router", 2), spikeEv(T0 + 20_000, null), ev({ kind: "outage", t: T0 })]);
    const h = headerModel(report({ spikes: 4 }), tl);
    expect(h.spikes).toBe(4);
    expect(h.causes).toEqual({ router: 2, unknown: 1 });
    expect(h.examined).toBe(3);
    expect(deT("timeline.header.examined", { n: h.examined, m: h.spikes })).toBe("3 von 4 Ausreißern untersucht");
    // mehr untersucht als Ausreißer der ganzen Runde → gekappt
    expect(headerModel(report({ spikes: 2 }), tl).examined).toBe(2);
    expect(h.targets).toEqual(["Frankfurt (AWS)"]);
    expect(h.fromReport).toBe(true);
    expect(h.durationS).toBe(600);
  });
  it("ohne Zeitleiste: Ursachen aus report.lagCauses", () => {
    const h = headerModel(report({ spikes: 5, lagCauses: { wifi: 3, unknown: 1 } }), null);
    expect(h.causes).toEqual({ wifi: 3, unknown: 1 });
    expect(h.examined).toBe(4);
    expect(headerModel(report({ lagCauses: undefined }), null).examined).toBe(0);
  });
  it("Sitzung ohne Bericht: Kennzahlen aus den Punkten (summarize, countSpikes)", () => {
    const pts = Array.from({ length: 40 }, (_, i) => pt(i, i === 5 ? null : i === 20 ? 200 : 20));
    const tl = timeline(pts, [spikeEv(T0 + 20_000, "isp")]);
    const r = reportFromTimeline(tl, "Dota 2");
    expect(r.id).toBe("session-7");
    expect(r.sessionId).toBe(7);
    expect(r.spikes).toBe(1);
    expect(r.loss).toBeCloseTo(1 / 40);
    expect(r.minPing).toBe(20);
    expect(r.maxPing).toBe(200);
    const h = headerModel(r, tl);
    expect(h.fromReport).toBe(false);
    expect(h.gameName).toBe("Dota 2");
    expect(h.causes).toEqual({ isp: 1 });
    expect(causeCounts(tl.events)).toEqual({ isp: 1 });
  });
});

describe("Bänder", () => {
  it("outage/loss/slow/quiet mit Zeitraum, ohne Ende ein Takt; spike und speedtest nicht", () => {
    const bands = eventBands(
      [ev({ kind: "slow", t: T0 + 5000, endT: T0 + 65_000 }), ev({ kind: "outage", t: T0 + 1000, endT: null }), ev({ kind: "spike", t: T0 }), ev({ kind: "speedtest", t: T0 }), ev({ kind: "quiet", t: T0 + 70_000, endT: T0 + 90_000 })],
      1000,
    );
    expect(bands.map((b) => [b.kind, b.from - T0, b.to - T0])).toEqual([
      ["outage", 1000, 2000],
      ["slow", 5000, 65_000],
      ["quiet", 70_000, 90_000],
    ]);
  });
});

describe("Texte", () => {
  it("dynamische Schlüssel gibt es in de und en", () => {
    for (const z of ZOOMS) for (const t of [deT, enT]) expect(t(`timeline.zoom.${z}`)).toBeTruthy();
    for (const k of ["ping", "jitter", "loss", "spikes", "load"]) for (const t of [deT, enT]) expect(t(`timeline.track.${k}`)).toBeTruthy();
    for (const k of ["outage", "loss", "slow", "quiet"]) for (const t of [deT, enT]) expect(t(`timeline.band.${k}`)).toBeTruthy();
    for (const s of OUTAGE_SCOPES) for (const t of [deT, enT]) expect(t(`timeline.scope.${s}`)).toBeTruthy();
    expect(deT("timeline.onlyCompressed")).toBe("Für diesen Bericht gibt es nur die verdichtete Kurve.");
    expect(deT("timeline.band.quiet")).toBe("Pulsar-Speedtest/WLAN-Scan");
  });
});

describe("Demo-Zeitleiste", () => {
  const session = { id: 42, gameId: "g1", start: T0, end: T0 + 1800_000, seconds: 1800 };
  it("deterministisch: 1 s Takt, Zielwechsel nach 40 s, 3 Ausreißer (router, isp, unknown), ein Aussetzer", () => {
    const a = demoSessionTimeline(session, null);
    const b = demoSessionTimeline(session, null);
    expect(a).toEqual(b);
    expect(a.points.length).toBe(1800);
    expect(a.points[1][0] - a.points[0][0]).toBe(1000);
    expect(a.targetChanges).toEqual([{ t: T0 + 40_000, key: a.targets[1].key }]);
    const spikes = a.events.filter((e) => e.kind === "spike");
    expect(spikes.map((e) => e.cause)).toEqual(["router", "isp", "unknown"]);
    expect(a.events.filter((e) => e.kind === "outage")).toHaveLength(1);
    expect(a.points.every((p) => p[2] !== null && p[2] >= 20 && p[2] <= 70)).toBe(true);
    // die Ausreißer liegen über der Grenze und bekommen ein Symbol
    const { marks } = spikeMarks(a.points, a.events);
    expect(marks.filter((m) => m.cause).map((m) => m.cause)).toEqual(["router", "isp", "unknown"]);
    // keine Adressen in den Ereignissen
    expect(JSON.stringify(a.events)).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });
});

describe("Demo: Bericht passt zur Zeitleiste", () => {
  it("report.maxPing = höchster Punkt (±1 ms), report.spikes = Ausreißer der Zeitleiste", async () => {
    const { mockInvoke } = await import("./mock");
    const reports = await mockInvoke<SessionReport[]>("db_list", { table: "reports" });
    const withSession = reports.filter((r) => r.sessionId !== null && r.sessionId !== undefined).slice(-5);
    expect(withSession.length).toBeGreaterThan(0);
    for (const r of withSession) {
      const tl = await mockInvoke<SessionTimeline>("net_session_timeline", { sessionId: r.sessionId });
      const ok = tl.points.map((p) => p[1]).filter((v): v is number => v !== null);
      const max = ok.reduce((a, v) => Math.max(a, v), -Infinity);
      expect(Math.abs(max - (r.maxPing ?? 0))).toBeLessThanOrEqual(1);
      expect(r.spikes).toBe(tl.events.filter((e) => e.kind === "spike").length);
    }
  });
});
