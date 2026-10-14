import { describe, expect, it } from "vitest";
import { de } from "../locales/de";
import { en } from "../locales/en";
import { CARD_CURVE_POINTS, CARD_H, CARD_MAX_DOTS, CARD_SCALE, CARD_W, cardModel, safeTargetName } from "./cardexport";
import { matchCardFileName } from "./exportfile";
import type { NetEvent, SessionReport, SessionTimeline, TimelinePoint } from "./types";

const tr = (dict: unknown) => (key: string, vars?: Record<string, string | number>) => {
  let cur: unknown = dict;
  for (const p of key.split(".")) cur = (cur as Record<string, unknown>)?.[p];
  if (typeof cur !== "string") throw new Error(`Text fehlt: ${key}`);
  return cur.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));
};
const deT = tr(de);
const enT = tr(en);

const T0 = 1_760_000_000_000;
const MAC = "a4:5e:60:12:34:56";
const SSID = "FRITZ!Box 7590 XY";
const GW = "192.168.178.1";
const HOP = "62.155.240.129";

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    id: "rep-1",
    gameId: "g1",
    gameName: "Counter-Strike 2",
    start: T0,
    end: T0 + 2_820_000,
    targetLabel: "CS2 Frankfurt (Valve)",
    avgPing: 23.4,
    minPing: 17,
    maxPing: 212,
    jitter: 2.8,
    loss: 0.003,
    spikes: 6,
    timeline: Array.from({ length: 600 }, (_, i) => [T0 + i * 4700, i === 100 ? null : 22 + (i % 5)] as [number, number | null]),
    boosted: true,
    grade: "A",
    sessionId: 9,
    ...over,
  };
}

const spike = (t: number, cause: NetEvent["cause"], count: number): NetEvent => ({
  id: t,
  t,
  endT: null,
  kind: "spike",
  targetKey: "valve-cs2-fra",
  targetLabel: "CS2 Frankfurt (Valve)",
  method: "icmp",
  netId: "7c41e09b2d5f",
  connection: "wifi",
  value: 180,
  cause,
  scope: null,
  sessionId: 9,
  // Testdaten mit Adressen/SSID im detail – dürfen nie auf der Karte landen
  detail: { count, baseline: 22, limit: 62, cpuHigh: false, reasons: [], snap: { conn: "wifi", vpn: false, hops: [[1, 2, "lan"]], gw: 2, gwB: 1.8, tgt: 170, rssi: -61, sig: 80, rx: 1, tx: 0.2, cpu: 30 }, ssid: SSID, bssid: MAC, gateway: GW, hop: HOP } as unknown as NetEvent["detail"],
});

function timeline(): SessionTimeline {
  const points: TimelinePoint[] = Array.from({ length: 2820 }, (_, i) => [T0 + i * 1000, i % 400 === 7 ? 190 : i === 1000 ? null : 22 + (i % 4), 30, 2, 0.4]);
  return {
    sessionId: 9,
    gameId: "g1",
    start: T0,
    end: T0 + 2_820_000,
    targets: [
      { key: "aws-eu-central-1", label: "Frankfurt (AWS)", method: "tcp" },
      { key: "valve-cs2-fra", label: "CS2 Frankfurt (Valve)", method: "icmp" },
    ],
    targetChanges: [{ t: T0 + 40_000, key: "valve-cs2-fra" }],
    merged: 1,
    points,
    events: [spike(T0 + 7000, "router", 2), spike(T0 + 407_000, "isp", 1), spike(T0 + 807_000, "unknown", 1)],
  };
}

describe("cardModel", () => {
  it("Texte: Spiel, Note, Kennzahlen, Messziele, Fußzeile", () => {
    const m = cardModel(report(), timeline(), deT, { palette: { primary: "#f59e0b", secondary: "#ef4444", dark: "#111" } });
    expect(m.brand).toBe("PULSAR");
    expect(m.kicker).toBe("Match-Bericht");
    expect(m.title).toBe("Counter-Strike 2");
    expect(m.grade).toBe("A");
    expect(m.gradeLabel).toBe("Note");
    expect(m.stats.map((s) => s.label)).toEqual(["Ø-Ping", "Schwankung", "Verlust", "Ausreißer"]);
    expect(m.stats[3].value).toBe("6");
    expect(m.stats[0].value).toMatch(/^23 ms$/);
    expect(m.target).toBe("Frankfurt (AWS) → CS2 Frankfurt (Valve)");
    expect(m.footer).toBe("Ping von Pulsar zu Frankfurt (AWS) → CS2 Frankfurt (Valve) – nicht die Spielverbindung · Ursachen sind Einschätzungen");
    // „47 min“ statt „47m“
    expect(m.duration).not.toMatch(/\d+m$/);
    expect(m.limitText).toMatch(/^Ausreißer-Grenze \d+ ms$/);
    expect(m.outageText).toBe("Aussetzer");
    expect(m.palette?.primary).toBe("#f59e0b");
    expect(m.start).toBe(T0);
    expect(m.end).toBe(T0 + 2_820_000);
  });
  it("Ursachen mit causeSummary: Gesamtzahl und „unklar“, „n von m untersucht“", () => {
    const m = cardModel(report(), timeline(), deT);
    expect(m.causeText).toBe("4 Ausreißer untersucht – vermutlich: 2× Heimnetz/Router, 1× Anschluss/Anbieter, 1× unklar");
    expect(m.examinedText).toBe("4 von 6 Ausreißern untersucht");
    const en1 = cardModel(report(), timeline(), enT);
    expect(en1.causeText).toBe("4 spikes examined – likely: 2× home network/router, 1× line/provider, 1× unclear");
    expect(en1.footer).toBe("Ping measured by Pulsar to Frankfurt (AWS) → CS2 Frankfurt (Valve) – not the game connection · causes are estimates");
    // alle untersucht → keine doppelte Zeile rechts
    expect(cardModel(report({ spikes: 4 }), timeline(), deT).examinedText).toBe("");
    // ohne Ereignisse: „keine untersucht“
    expect(cardModel(report({ lagCauses: undefined }), null, deT).causeText).toBe("Keine Ausreißer untersucht");
  });
  it("Kurve höchstens 360 Punkte, Ausreißer-Punkte aus den Punkten über der Grenze, Verlust bleibt sichtbar", () => {
    const m = cardModel(report(), timeline(), deT);
    expect(m.curve.length).toBeLessThanOrEqual(CARD_CURVE_POINTS);
    expect(m.spikeDots.length).toBe(Math.ceil(2820 / 400));
    expect(m.spikeDots.every((d) => d.rtt === 190)).toBe(true);
    expect(m.limit).not.toBeNull();
    // ohne Zeitleiste: verdichtete Kurve des Berichts
    const fb = cardModel(report(), null, deT);
    expect(fb.curve.length).toBe(CARD_CURVE_POINTS);
    expect(fb.curve.some(([, v]) => v === null)).toBe(true);
    expect(fb.target).toBe("CS2 Frankfurt (Valve)");
    // viele Ausreißer → höchstens 80 Punkte
    const many = timeline();
    many.points = many.points.map((p, i) => [p[0], i % 7 === 0 ? 300 : 20, null, null, null]);
    expect(cardModel(report(), many, deT).spikeDots.length).toBeLessThanOrEqual(CARD_MAX_DOTS);
  });
  it("keine Adresse, MAC oder SSID im Modell – auch nicht, wenn das Messziel wie eine Adresse heißt", () => {
    const tl = timeline();
    tl.targets = [{ key: "custom-1", label: GW, method: "icmp" }, { key: "custom-2", label: "2001:db8::1", method: "icmp" }];
    const m = cardModel(report({ targetLabel: HOP }), tl, deT);
    const json = JSON.stringify(m);
    for (const bad of [GW, HOP, MAC, SSID, "2001:db8::1"]) expect(json).not.toContain(bad);
    expect(json).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(m.target).toBe("eigenes Ziel");
    expect(cardModel(report({ targetLabel: MAC }), null, enT).target).toBe("custom target");
  });
  it("safeTargetName", () => {
    expect(safeTargetName("Frankfurt (AWS)", deT)).toBe("Frankfurt (AWS)");
    expect(safeTargetName("10.0.0.1", deT)).toBe("eigenes Ziel");
    expect(safeTargetName("fe80::1:2", deT)).toBe("eigenes Ziel");
    expect(safeTargetName("  ", deT)).toBe("eigenes Ziel");
  });
  it("Größe und Dateiname", () => {
    expect([CARD_W, CARD_H, CARD_SCALE]).toEqual([1200, 630, 2]);
    expect(matchCardFileName("Counter-Strike 2", new Date(2026, 9, 14, 20, 5).getTime())).toBe("pulsar-match-counter-strike-2-2026-10-14-2005.png");
  });
});
