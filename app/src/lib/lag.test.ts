import { afterEach, describe, expect, it, vi } from "vitest";
import { de } from "../locales/de";
import { en } from "../locales/en";
import { isLiveSpike } from "./grade";
import { causeLabel, causeLine, causeNote, countsFromEvents, countsFromSummary, latestRecent, upsertLagEvent, visibleReasons, zoneText } from "./lag";
import { causeSummary } from "./lagtext";
import { lagMock } from "./mock/lag";
import { mockListen, runPingTick } from "./mock/core";
import { LAG_CAUSES, REASONS, type EventSummaryRow, type LagEvent, type PingTarget } from "./types";

const tr = (dict: unknown) => (key: string, vars?: Record<string, string | number>) => {
  let cur: unknown = dict;
  for (const p of key.split(".")) cur = (cur as Record<string, unknown>)?.[p];
  if (typeof cur !== "string") throw new Error(`Text fehlt: ${key}`);
  return cur.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));
};
const deT = tr(de);
const enT = tr(en);

function ev(at: number, cause: LagEvent["cause"], count = 1, targetId = "aws-eu-central-1"): LagEvent {
  return {
    at,
    cause,
    cpuHigh: false,
    reasons: ["pathOk", "cpuHigh"],
    snapshot: { at, connection: "ethernet", viaVpn: false, targetMs: null, targetLost: null, hops: [], gatewayMs: null, gatewayBaseMs: null, wifi: null, wifiState: null, signalBase: null, rxMbps: null, txMbps: null, trafficBaseMbps: null, refDownMbps: null, refUpMbps: null, cpu: null, tookMs: 0 },
    targetId,
    targetLabel: "Frankfurt",
    targetKind: "region",
    rtt: 180,
    baseline: 20,
    limit: 60,
    count,
    sessionId: null,
  };
}

describe("Texte des Lag-Detektivs (dynamische Schlüssel)", () => {
  it("jede Ursache und jeder Grund hat einen Text in de und en", () => {
    for (const c of LAG_CAUSES) for (const t of [deT, enT]) expect(t(`lag.cause.${c}`)).toBeTruthy();
    for (const r of REASONS) {
      expect(deT(`lag.reason.${r}`).length).toBeGreaterThan(10);
      expect(enT(`lag.reason.${r}`).length).toBeGreaterThan(10);
    }
    for (const z of ["lan", "isp", "ispCgnat", "internet", "target"]) for (const t of [deT, enT]) expect(t(`lag.zone.${z}`)).toBeTruthy();
    for (const k of ["wifi", "ethernet", "other", "none", "vpn"]) for (const t of [deT, enT]) expect(t(`lag.connection.${k}`)).toBeTruthy();
  });

  it("Ursachen immer als Einschätzung („vermutlich“), nie als Versprechen", () => {
    expect(causeLine("wifi", "region", deT)).toBe("vermutlich WLAN");
    expect(causeLine("unknown", "region", deT)).toBe("Ursache unklar");
    expect(causeLine("isp", null, enT)).toBe("likely Line/provider");
    const all = JSON.stringify([de.lag, en.lag]).toLowerCase();
    for (const bad of ["weniger ping", "less ping", "garantiert", "guaranteed", "beweis", "proof"]) expect(all).not.toContain(bad);
  });

  it("Internet bekommt nur bei Spielservern den Zusatz „Spielserver-Netz“, Anbieter den festen Untertitel", () => {
    expect(causeLabel("internet", "server", deT)).toBe("Internet (hinter dem Anbieter) – Spielserver-Netz");
    expect(causeLabel("internet", "region", deT)).toBe("Internet (hinter dem Anbieter)");
    expect(causeNote("isp", deT)).toBe("auch möglich: Leitung durch andere Geräte im Haushalt ausgelastet");
    expect(causeNote("wifi", deT)).toBeNull();
  });

  it("causeSummary: Gesamtzahl und „unklar“ aus Live-Ereignissen", () => {
    const list = [ev(1, "wifi", 3), ev(2, "isp"), ev(3, "unknown")];
    expect(causeSummary(countsFromEvents(list), deT)).toBe("5 Ausreißer untersucht – vermutlich: 3× WLAN, 1× Anschluss/Anbieter; 1× unklar");
    expect(causeSummary(countsFromEvents([]), enT)).toBe("No spikes examined");
  });

  it("Zone als Text, stumme Station = „keine Antwort“", () => {
    expect(zoneText({ zone: "isp", cgnat: true, rtt: 5, address: "100.64.1.1" }, deT)).toBe("Anbieter (CGNAT)");
    expect(zoneText({ zone: null, cgnat: false, rtt: null, address: null }, deT)).toBe("keine Antwort");
    expect(zoneText({ zone: "lan", cgnat: false, rtt: 1, address: "192.168.178.1" }, enT)).toBe("Home network");
  });
});

describe("Liste der letzten Ausreißer", () => {
  it("ersetzt per at + targetId, neueste zuerst, höchstens 20", () => {
    let list: LagEvent[] = [];
    for (let i = 0; i < 25; i++) list = upsertLagEvent(list, ev(i * 1000, "wifi"));
    expect(list).toHaveLength(20);
    expect(list[0].at).toBe(24_000);
    list = upsertLagEvent(list, ev(24_000, "wifi", 3));
    expect(list).toHaveLength(20);
    expect(list[0].count).toBe(3);
    // gleiche Zeit, anderes Ziel = eigenes Ereignis
    list = upsertLagEvent(list, ev(24_000, "isp", 1, "valve-x"));
    expect(list.filter((e) => e.at === 24_000)).toHaveLength(2);
  });

  it("Cockpit zeigt nur den letzten Ausreißer der letzten 60 s", () => {
    const list = [ev(10_000, "isp"), ev(50_000, "wifi")];
    expect(latestRecent(list, 60_000)?.cause).toBe("wifi");
    expect(latestRecent(list, 110_000)?.cause).toBe("wifi");
    expect(latestRecent(list, 110_001)).toBeNull();
    expect(latestRecent([], 1)).toBeNull();
  });

  it("cpuHigh steht nicht zwischen den Begründungen (eigener Hinweis)", () => {
    expect(visibleReasons(ev(1, "internet"))).toEqual(["pathOk"]);
  });

  it("Zählung aus net_events_summary: nur spike, countSum, fehlende Ursache = unklar", () => {
    const row = (kind: EventSummaryRow["kind"], cause: EventSummaryRow["cause"], countSum: number, rows = 1): EventSummaryRow => ({ hourStart: 0, kind, cause, scope: null, connection: "ethernet", netId: "", rows, countSum, durationS: 0 });
    const counts = countsFromSummary([row("spike", "wifi", 4, 2), row("spike", "wifi", 1), row("spike", null, 2), row("outage", null, 9), row("spike", "isp", 0, 3)]);
    expect(counts).toEqual({ wifi: 5, unknown: 2, isp: 3 });
  });
});

describe("Demo: genau alle 30 Takte ein Ausreißer, 1 s später net://lag", () => {
  afterEach(() => vi.useRealTimers());

  it("deterministisch, Ursachen reihum, Ausreißer erfüllt die Live-Regel", () => {
    vi.useFakeTimers();
    const target: PingTarget = { id: "aws-eu-central-1", label: "Frankfurt (AWS)", host: "x", method: "tcp" } as PingTarget;
    const got: LagEvent[] = [];
    const off = mockListen("net://lag", (p) => got.push(p as LagEvent));
    const window: (number | null)[] = [];
    const spikes: number[] = [];
    for (let tick = 0; tick < 150; tick++) {
      const s = runPingTick({ targetId: target.id, t: tick * 1000, rtt: 20 + (tick % 3) }, tick, target);
      window.push(s.rtt);
      if (s.rtt !== null && s.rtt > 100) {
        spikes.push(tick);
        expect(isLiveSpike(window.slice(-60))).toBe(true);
      }
    }
    expect(spikes).toEqual([29, 59, 89, 119, 149]);
    expect(got).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    off();
    expect(got.map((e) => e.cause)).toEqual(["router", "isp", "localTraffic", "internet", "unknown"]);
    expect(got.every((e) => e.snapshot.connection === "ethernet" && e.targetId === target.id && e.rtt > e.limit)).toBe(true);
    expect(got[1].reasons).toContain("lineBusyPossible");
    expect(got[4].reasons).toEqual(["spikeGone"]);
    // net_lag_recent: die neuen zuerst, dazu die festen, höchstens 20
    const recent = lagMock.net_lag_recent({}) as LagEvent[];
    expect(recent.length).toBeLessThanOrEqual(20);
    expect(recent).toHaveLength(9);
    expect(recent.filter((e) => e.at <= 149_000).map((e) => e.at)).toEqual([149_000, 119_000, 89_000, 59_000, 29_000]);
    expect(recent.every((e, i) => i === 0 || recent[i - 1].at >= e.at)).toBe(true);
    const snap = lagMock.net_lag_snapshot({}) as { cause: string };
    expect(snap.cause).toBe("internet");
  });
});
