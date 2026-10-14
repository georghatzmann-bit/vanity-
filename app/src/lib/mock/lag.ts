/**
 * Demo-Backend: Lag-Detektiv (`net_lag_recent`, `net_if_counters`, `net_lag_snapshot`, Demo-`net://lag`).
 *
 * Deterministisch: Der Demo-Monitor erzeugt **genau alle 30 Takte** einen Ausreißer im `net://ping`
 * und 1 s später `net://lag`. Die Ursachen wechseln reihum `router`, `isp` (mit `lineBusyPossible`),
 * `localTraffic`, `internet`, `unknown` (`spikeGone`) – alle mit `connection = "ethernet"`. Mit
 * `__pulsarWifiPrimary` (WLAN als Hauptverbindung) ersetzt `wifi` die Ursache `router`. Die Werte
 * kommen aus festen Tabellen (kein Verbrauch des gemeinsamen Zufalls), damit alle anderen
 * Demo-Werte unverändert bleiben.
 */
import type { IfCounters, LagCause, LagCheck, LagEvent, LagSnapshot, PingTarget, QuickHop, Reason, TargetKind } from "../types";
import { demoFlag, emit, onPingTick, type MockHandlers } from "./core";

/** Ausreißer alle so viele Takte */
export const DEMO_SPIKE_EVERY = 30;
/** `net://lag` so lange nach dem Ausreißer (ms) */
export const DEMO_LAG_DELAY_MS = 1000;

const ETHERNET_ID = "{3F2504E0-4F89-11D3-9A0C-0305E82C3301}";
const WLAN_ID = "{8B5C7A10-2C3D-4E5F-9A0B-1C2D3E4F5A6B}";
const GATEWAY = "192.168.178.1";

const wifiPrimary = () => demoFlag("__pulsarWifiPrimary");

const targetKind = (id: string): TargetKind => (id.startsWith("aws-") ? "region" : id.startsWith("valve-") || id.startsWith("riot-") ? "server" : "other");

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Teilroute der Demo (wie die Demo-Routen-Analyse: Fritzbox, CGNAT, Telekom) */
function hops(ttl1: number, ttl2: number, ttl3: number): QuickHop[] {
  return [
    { ttl: 1, address: GATEWAY, rtt: ttl1, zone: "lan", cgnat: false, baseMs: 1.1 },
    { ttl: 2, address: "100.64.12.1", rtt: ttl2, zone: "isp", cgnat: true, baseMs: 6.1 },
    { ttl: 3, address: "62.155.240.129", rtt: ttl3, zone: "isp", cgnat: false, baseMs: 7.0 },
  ];
}

interface Variant {
  cause: LagCause;
  reasons: Reason[];
  rtt: number;
  snapshot: Omit<LagSnapshot, "at">;
}

const quietBase: Omit<LagSnapshot, "at"> = {
  connection: "ethernet",
  viaVpn: false,
  targetMs: 160,
  targetLost: 0,
  hops: hops(1.2, 6.4, 7.3),
  gatewayMs: 1.2,
  gatewayBaseMs: 1.1,
  wifi: null,
  wifiState: null,
  signalBase: null,
  rxMbps: 2.8,
  txMbps: 0.4,
  trafficBaseMbps: 3.1,
  refDownMbps: 500,
  refUpMbps: null,
  cpu: 23,
  tookMs: 712,
};

/** Die fünf Demo-Ursachen reihum (Kabel) */
const VARIANTS: Variant[] = [
  { cause: "router", reasons: ["gatewaySlow"], rtt: 182, snapshot: { ...quietBase, targetMs: 171, gatewayMs: 38.4, hops: hops(37.9, 44.8, 46.1), tookMs: 744 } },
  { cause: "isp", reasons: ["ispHopSlow", "lineBusyPossible"], rtt: 168, snapshot: { ...quietBase, targetMs: 158, hops: hops(1.3, 58.2, 61.5), tookMs: 803 } },
  { cause: "localTraffic", reasons: ["trafficHigh"], rtt: 149, snapshot: { ...quietBase, targetMs: 137, rxMbps: 386.4, txMbps: 12.1, hops: hops(1.4, 24.9, 26.0), cpu: 41, tookMs: 768 } },
  { cause: "internet", reasons: ["pathOk"], rtt: 176, snapshot: { ...quietBase, targetMs: 163, tookMs: 655 } },
  { cause: "unknown", reasons: ["spikeGone"], rtt: 157, snapshot: { ...quietBase, targetMs: 24, tookMs: 631 } },
];

/** Mit `__pulsarWifiPrimary`: WLAN statt Router (2,4 GHz, Signal eingebrochen) */
const WIFI_VARIANT: Variant = {
  cause: "wifi",
  reasons: ["gatewaySlow", "rssiLow", "signalDrop"],
  rtt: 188,
  snapshot: {
    ...quietBase,
    connection: "wifi",
    targetMs: 174,
    gatewayMs: 31.6,
    gatewayBaseMs: 2.4,
    hops: hops(31.2, 39.7, 41.0).map((h) => (h.ttl === 1 ? { ...h, baseMs: 2.3 } : h)),
    wifi: { signal: 52, rssi: -71, band: "2.4" },
    wifiState: "ok",
    signalBase: 80,
    tookMs: 812,
  },
};

const variantFor = (index: number): Variant => {
  const v = VARIANTS[index % VARIANTS.length];
  if (v.cause === "router" && wifiPrimary()) return WIFI_VARIANT;
  if (!wifiPrimary()) return v;
  // WLAN als Hauptverbindung: alle Momentaufnahmen über WLAN (Signal normal)
  return { ...v, snapshot: { ...v.snapshot, connection: "wifi", wifi: { signal: 80, rssi: -60, band: "2.4" }, wifiState: "ok", signalBase: 80, gatewayBaseMs: 2.4 } };
};

function makeEvent(v: Variant, at: number, target: { id: string; label: string }, baseline: number, limit: number, rtt: number, count = 1): LagEvent {
  const snapshot: LagSnapshot = { ...v.snapshot, at };
  return {
    at,
    cause: v.cause,
    cpuHigh: false,
    reasons: v.reasons,
    snapshot,
    targetId: target.id,
    targetLabel: target.label,
    targetKind: targetKind(target.id),
    rtt,
    baseline,
    limit,
    count,
    sessionId: null,
  };
}

const FRANKFURT = { id: "aws-eu-central-1", label: "Frankfurt (AWS)" };

/** 4 feste, zur Demo-Verbindung passende Ereignisse (älter als die Cockpit-Anzeige) */
function fixedRecent(now: number): LagEvent[] {
  const at = (minAgo: number) => Math.floor((now - minAgo * 60_000) / 1000) * 1000;
  const list = [
    makeEvent(variantFor(1), at(4), FRANKFURT, 21, 61, 168, 2),
    makeEvent(variantFor(0), at(11), FRANKFURT, 22, 62, 182),
    makeEvent(variantFor(3), at(19), FRANKFURT, 21, 61, 176),
    makeEvent(variantFor(4), at(27), FRANKFURT, 23, 63, 157),
  ];
  return list;
}

// Live-Ereignisse des Demo-Monitors (neueste zuerst, höchstens 20 zusammen mit den festen)
let live: LagEvent[] = [];
let spikeIndex = 0;
let rttWindow: (number | null)[] = [];

onPingTick((sample, tick, target: PingTarget) => {
  if (tick === 0) rttWindow = [];
  let rtt = sample.rtt;
  if (tick % DEMO_SPIKE_EVERY === DEMO_SPIKE_EVERY - 1) {
    const ok = rttWindow.filter((v): v is number => v !== null).slice(-60);
    const baseline = median(ok) ?? 20;
    const limit = Math.max(2 * baseline, baseline + 40);
    const v = variantFor(spikeIndex++);
    rtt = Math.max(v.rtt, Math.ceil(limit) + 25);
    const ev = makeEvent(v, sample.t, { id: target.id, label: target.label }, Math.round(baseline * 10) / 10, Math.round(limit * 10) / 10, rtt);
    rttWindow = [...rttWindow, rtt].slice(-60);
    setTimeout(() => {
      live = [ev, ...live.filter((e) => !(e.at === ev.at && e.targetId === ev.targetId))].slice(0, 20);
      emit("net://lag", ev);
    }, DEMO_LAG_DELAY_MS);
    return { ...sample, rtt };
  }
  rttWindow = [...rttWindow, rtt].slice(-60);
});

const started = Date.now();

export const lagMock: MockHandlers = {
  net_lag_recent: () => [...live, ...fixedRecent(started)].sort((a, b) => b.at - a.at).slice(0, 20),
  net_if_counters: (): IfCounters => {
    const now = Date.now();
    const s = (now - started) / 1000;
    // ≈ 2–4 Mbit/s, sanft schwankend, Zähler steigen
    const rxMbps = 3 + Math.sin(s / 7);
    const txMbps = 0.4 + 0.1 * Math.sin(s / 5);
    return {
      adapterId: wifiPrimary() ? WLAN_ID : ETHERNET_ID,
      adapter: wifiPrimary() ? "WLAN" : "Ethernet",
      rxBytes: Math.round(8_412_000_000 + (s * 3 * 1_000_000) / 8),
      txBytes: Math.round(1_204_000_000 + (s * 0.4 * 1_000_000) / 8),
      at: now,
      rxMbps: Math.round(rxMbps * 10) / 10,
      txMbps: Math.round(txMbps * 10) / 10,
    };
  },
  net_lag_snapshot: (): LagCheck => {
    const at = Date.now();
    const v = variantFor(3);
    return { at, cause: "internet", cpuHigh: false, reasons: ["pathOk"], snapshot: { ...v.snapshot, at, targetMs: 23, tookMs: 688 } };
  },
};
