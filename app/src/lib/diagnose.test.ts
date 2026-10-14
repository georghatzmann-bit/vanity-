import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { de } from "../locales/de";
import { en } from "../locales/en";
import {
  FIX_COUNT,
  LINKS,
  MAX_FINDINGS,
  SPEEDTEST_DOWN_S,
  SPEEDTEST_MAX_MB,
  SPEEDTEST_UP_S,
  diagnose,
  findingNotes,
  findingText,
  fixTexts,
  mergeStats,
  parseLast,
  routeJump,
  routerTarget,
  speedtestBudgetMb,
  speedtestMaxMb,
  stripInput,
  trafficMbps,
} from "./diagnose";
import {
  DIAGNOSE_STEPS,
  FINDING_IDS,
  type AdapterInfo,
  type DiagnoseInput,
  type DiagnoseStep,
  type Finding,
  type FindingId,
  type IfCounters,
  type LagCheck,
  type PingStats,
  type PingTarget,
  type SpeedResult,
  type TraceHop,
  type WifiNetwork,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------------------------

const GW = "192.168.178.1";

const ethernet: AdapterInfo = { id: "eth", name: "Ethernet", description: "Intel", kind: "ethernet", up: true, speedMbps: 1000, ipv4: ["192.168.178.42"], gateway: GW, dns: [GW], primary: true };
const wlan: AdapterInfo = { ...ethernet, id: "wlan", name: "WLAN", kind: "wifi", speedMbps: 287 };

/** Messwerte mit `lost` Verlusten von `n` */
function stats(avg: number | null, jitter: number | null, lost: number, n: number): PingStats {
  return { targetId: "x", last: avg, avg: lost >= n ? null : avg, min: avg, max: avg, jitter: lost >= n ? null : jitter, loss: n ? lost / n : 0, samples: n };
}

const goodSpeed: SpeedResult = { downloadMbps: 450, uploadMbps: 45, idleLatencyMs: 9.6, idleJitterMs: 1, loadedLatencyDownMs: 31, loadedLatencyUpMs: 44, bufferbloatMs: 34.6, grade: "B", server: "FRA", at: 0 };

const counters = (mbps: number): [IfCounters, IfCounters] => [
  { adapterId: "eth", adapter: "Ethernet", rxBytes: 1_000_000, txBytes: 0, at: 0, rxMbps: null, txMbps: null },
  { adapterId: "eth", adapter: "Ethernet", rxBytes: 1_000_000 + (mbps * 1e6 * 2) / 8, txBytes: 0, at: 2000, rxMbps: null, txMbps: null },
];

const allDone = (): DiagnoseStep[] => DIAGNOSE_STEPS.map((id) => ({ id, status: "done" as const }));

/** Unauffällige Prüfung per Kabel → `allGood` */
function base(over: Partial<DiagnoseInput> = {}): DiagnoseInput {
  return {
    steps: allDone(),
    adapters: [ethernet],
    wifiState: { state: "notConnected", wifi: null },
    wifiScan: null,
    metered: false,
    router: stats(0.9, 0.3, 0, 20),
    snapshot: null,
    target: { id: "aws-eu-central-1", label: "Frankfurt", method: "tcp" },
    server: stats(21, 1.5, 0, 50),
    regions: [{ id: "aws-eu-central-1", name: "Frankfurt", stats: stats(21, 1, 0, 4) }],
    trace: null,
    system: { cpu: 20, ramUsed: 1, ramTotal: 2, gpu: null, cpuName: null, gpuName: null, uptimeSeconds: null },
    counters: counters(1),
    speed: goodSpeed,
    contractDownMbps: null,
    ...over,
  };
}

/** WLAN als Hauptverbindung */
function wifiInput(rssi: number | null, signal: number, band: "2.4" | "5" = "5", channel = 44, over: Partial<DiagnoseInput> = {}): DiagnoseInput {
  return base({
    adapters: [wlan],
    wifiState: { state: "connected", wifi: { ssid: "Heim", signal, rssi, band, channel, phy: "Wi-Fi 6", rxMbps: 287, txMbps: 287 } },
    ...over,
  });
}

const ids = (input: DiagnoseInput) => diagnose(input, 1).findings.map((f) => f.id);
const has = (input: DiagnoseInput, id: FindingId) => diagnose(input, 1).findings.some((f) => f.id === id);
const find = (input: DiagnoseInput, id: FindingId) => diagnose(input, 1).findings.find((f) => f.id === id);

function net(ssid: string, bssid: string, band: "2.4" | "5" | "6", channel: number, rssi: number, connected = false): WifiNetwork {
  return { ssid, bssid, rssi, signal: Math.max(0, Math.min(100, 2 * (rssi + 100))), channel, band, centerKhz: 0, widthMhz: 20, phy: "", secured: true, connected, ageS: 1 };
}

const hop = (n: number, address: string | null, rtt: number | null, zone: TraceHop["zone"] = "internet"): TraceHop => ({ hop: n, address, hostname: null, rtts: [rtt, rtt === null ? null : rtt + 1, rtt === null ? null : rtt + 2], zone });

// ---------------------------------------------------------------------------------------------
// Regeln
// ---------------------------------------------------------------------------------------------

describe("Grundfall", () => {
  it("unauffällig per Kabel → allGood", () => {
    const r = diagnose(base(), 1);
    expect(r.verdict).toBe("allGood");
    expect(r.findings.map((f) => f.id)).toEqual(["allGood"]);
    expect(r.steps.map((s) => s.id)).toEqual([...DIAGNOSE_STEPS]);
  });
});

describe("noLink / offline", () => {
  it("keine Hauptverbindung oder kein Gateway", () => {
    expect(diagnose(base({ adapters: [] }), 1).verdict).toBe("noLink");
    expect(diagnose(base({ adapters: [{ ...ethernet, gateway: null }] }), 1).verdict).toBe("noLink");
    expect(diagnose(base({ adapters: [{ ...ethernet, primary: false }] }), 1).verdict).toBe("noLink");
    // Adapter nicht gelesen → keine Aussage über die Verbindung
    expect(has(base({ adapters: null }), "noLink")).toBe(false);
  });

  it("Router antwortet, dahinter nichts", () => {
    const dead = stats(null, null, 50, 50);
    const input = base({ server: dead, regions: [{ id: "a", name: "A", stats: stats(null, null, 4, 4) }], speed: null });
    const r = diagnose(input, 1);
    expect(r.verdict).toBe("offline");
    expect(r.findings.some((f) => f.id === "serverLoss")).toBe(false);
    // eine Region antwortet → nicht offline
    expect(has({ ...input, regions: [{ id: "a", name: "A", stats: stats(30, 1, 0, 4) }] }, "offline")).toBe(false);
    // Speedtest klappt → nicht offline
    expect(has({ ...input, speed: goodSpeed }, "offline")).toBe(false);
  });
});

describe("localTraffic (vor dem Speedtest, 5 Mbit/s bzw. 30 %)", () => {
  it("Schwelle 5 Mbit/s", () => {
    expect(has(base({ counters: counters(5) }), "localTraffic")).toBe(false);
    const f = find(base({ counters: counters(5.1) }), "localTraffic");
    expect(f?.severity).toBe("high");
    expect(f?.values.mbps).toBe(5.1);
  });
  it("mehr als 30 % des gemessenen Downloads", () => {
    const slow = { ...goodSpeed, downloadMbps: 10 };
    expect(has(base({ counters: counters(3), speed: slow }), "localTraffic")).toBe(false);
    expect(has(base({ counters: counters(3.1), speed: slow }), "localTraffic")).toBe(true);
  });
  it("Zähler zurückgesetzt oder anderer Adapter → nicht messbar", () => {
    const [a, b] = counters(50);
    expect(trafficMbps([b, a])).toBeNull();
    expect(trafficMbps([a, { ...b, adapterId: "other" }])).toBeNull();
    expect(trafficMbps([a, null])).toBeNull();
    expect(trafficMbps([a, b])?.total).toBeCloseTo(50, 5);
  });
});

describe("bufferbloat", () => {
  it("ab 60 ms mittel, ab 200 ms hoch", () => {
    expect(has(base({ speed: { ...goodSpeed, bufferbloatMs: 59.9 } }), "bufferbloat")).toBe(false);
    expect(find(base({ speed: { ...goodSpeed, bufferbloatMs: 60 } }), "bufferbloat")?.severity).toBe("medium");
    expect(find(base({ speed: { ...goodSpeed, bufferbloatMs: 199 } }), "bufferbloat")?.severity).toBe("medium");
    expect(find(base({ speed: { ...goodSpeed, bufferbloatMs: 200 } }), "bufferbloat")?.severity).toBe("high");
  });
});

describe("WLAN", () => {
  it("wifiWeak: −70 / −70,1 dBm, Signal 50 / 49, hoch unter −75", () => {
    expect(has(wifiInput(-70, 60), "wifiWeak")).toBe(false);
    expect(find(wifiInput(-70.1, 60), "wifiWeak")?.severity).toBe("medium");
    expect(find(wifiInput(-75, 60), "wifiWeak")?.severity).toBe("medium");
    expect(find(wifiInput(-75.1, 60), "wifiWeak")?.severity).toBe("high");
    expect(has(wifiInput(-60, 50), "wifiWeak")).toBe(false);
    expect(has(wifiInput(-60, 49), "wifiWeak")).toBe(true);
    // ohne RSSI: Textvariante mit Signal
    expect(find(wifiInput(null, 40), "wifiWeak")?.values.variant).toBe("signal");
  });

  it("WLAN-Befunde nur, wenn das WLAN die Hauptverbindung ist", () => {
    const weakButWired = base({ wifiState: { state: "connected", wifi: { ssid: "Heim", signal: 20, rssi: -85, band: "2.4", channel: 6, phy: "", rxMbps: 1, txMbps: 1 } } });
    expect(ids(weakButWired)).toEqual(["allGood"]);
  });

  it("wifiBand24 mit und ohne sichtbares eigenes 5-GHz-Netz", () => {
    const own24 = net("Heim", "3c:a6:2f:5b:71:8d", "2.4", 6, -60, true);
    const scan = (networks: WifiNetwork[]) => ({ wifiScan: { at: 0, fresh: false, interfaces: 1, networks } });
    // gleiche SSID auf 5 GHz mit −66 dBm → wifiBand24
    const visible = wifiInput(-60, 80, "2.4", 6, scan([own24, net("Heim", "3c:a6:2f:5b:71:8e", "5", 44, -66)]));
    expect(find(visible, "wifiBand24")?.values.rssi).toBe(-66);
    expect(has(visible, "wifiBand24Maybe")).toBe(false);
    // anderer Netzname, aber gleicher Funkteil (sameRadio) → zählt als eigenes Netz
    expect(has(wifiInput(-60, 80, "2.4", 6, scan([own24, net("Heim-5G", "3c:a6:2f:5b:71:8e", "5", 44, -66)])), "wifiBand24")).toBe(true);
    // eigenes 5-GHz-Netz zu schwach (−70,1) → weder Befund noch „falls“
    const weak = wifiInput(-60, 80, "2.4", 6, scan([own24, net("Heim", "3c:a6:2f:5b:71:8e", "5", 44, -70.1)]));
    expect(has(weak, "wifiBand24")).toBe(false);
    expect(has(weak, "wifiBand24Maybe")).toBe(false);
    // nicht sichtbar bzw. Scan nicht möglich → nur Hinweis
    expect(find(wifiInput(-60, 80, "2.4", 6, scan([own24, net("Nachbar", "aa:bb:cc:dd:ee:ff", "5", 44, -50)])), "wifiBand24Maybe")?.severity).toBe("info");
    expect(has(wifiInput(-60, 80, "2.4", 6), "wifiBand24Maybe")).toBe(true);
    // 5 GHz verbunden → keiner der beiden
    expect(has(wifiInput(-60, 80, "5", 44), "wifiBand24Maybe")).toBe(false);
  });

  it("wifiChannel bei deutlich besserem Kanal", () => {
    const own = net("Heim", "3c:a6:2f:5b:71:8d", "2.4", 6, -60, true);
    const crowd = [-55, -58, -62, -64].map((r, i) => net(`N${i}`, `aa:00:00:00:00:0${i}`, "2.4", 6, r));
    const input = wifiInput(-60, 80, "2.4", 6, { wifiScan: { at: 0, fresh: true, interfaces: 1, networks: [own, ...crowd] } });
    const f = find(input, "wifiChannel");
    expect(f?.severity).toBe("medium");
    expect(f?.values.current).toBe(6);
    expect([1, 11]).toContain(f?.values.recommended);
    // freier Kanal → kein Befund
    expect(has(wifiInput(-60, 80, "2.4", 6, { wifiScan: { at: 0, fresh: true, interfaces: 1, networks: [own] } }), "wifiChannel")).toBe(false);
  });

  it("wifiLocked: Hinweis; Scan gesperrt → wifiWeak bleibt möglich", () => {
    const locked = base({ adapters: [wlan], wifiState: { state: "locked", wifi: null } });
    expect(find(locked, "wifiLocked")?.severity).toBe("info");
    // nur der Scan scheitert (wifiScan = null), der Zustand ist lesbar
    const scanFailed = wifiInput(-74, 52, "5", 44, { wifiScan: null });
    expect(has(scanFailed, "wifiWeak")).toBe(true);
    expect(has(scanFailed, "wifiLocked")).toBe(false);
    // gesperrt, aber die Momentaufnahme kennt das Signal → wifiWeak trotzdem
    const snap = { at: 0, cause: "unknown", cpuHigh: false, reasons: [], snapshot: { wifi: { signal: 40, rssi: -78, band: "5" }, viaVpn: false, hops: [] } } as unknown as LagCheck;
    expect(has({ ...locked, snapshot: snap }, "wifiWeak")).toBe(true);
  });
});

describe("Router", () => {
  it("1 bzw. 2 von 20 verloren", () => {
    expect(has(base({ router: stats(0.9, 0.3, 1, 20) }), "routerSlow")).toBe(false);
    expect(find(base({ router: stats(0.9, 0.3, 2, 20) }), "routerSlow")?.severity).toBe("high");
  });
  it("Ø über 10 ms per Kabel bzw. 20 ms per WLAN, Schwankung über 10 ms, hoch über 50 ms", () => {
    expect(has(base({ router: stats(10, 1, 0, 20) }), "routerSlow")).toBe(false);
    expect(find(base({ router: stats(10.1, 1, 0, 20) }), "routerSlow")?.severity).toBe("medium");
    expect(has(wifiInput(-55, 90, "5", 44, { router: stats(20, 1, 0, 20) }), "routerSlow")).toBe(false);
    expect(has(wifiInput(-55, 90, "5", 44, { router: stats(20.1, 1, 0, 20) }), "routerSlow")).toBe(true);
    expect(has(base({ router: stats(2, 10, 0, 20) }), "routerSlow")).toBe(false);
    expect(has(base({ router: stats(2, 10.1, 0, 20) }), "routerSlow")).toBe(true);
    expect(find(base({ router: stats(50.1, 1, 0, 20) }), "routerSlow")?.severity).toBe("high");
  });
  it("antwortet nicht → nur Hinweis, verdict allGood", () => {
    const r = diagnose(base({ router: stats(null, null, 20, 20) }), 1);
    expect(r.verdict).toBe("allGood");
    expect(r.findings.map((f) => f.id)).toEqual(["routerNoAnswer", "allGood"]);
  });
  it("Router-Ziel mit label (PingTarget)", () => {
    const target = routerTarget(GW) satisfies PingTarget;
    expect(target).toEqual({ id: "gateway", label: "Router", host: GW, method: "icmp" });
  });
});

describe("Server", () => {
  it("serverLoss: 1 bzw. 2 von 50, hoch ab 5 %", () => {
    expect(has(base({ server: stats(21, 1, 1, 50) }), "serverLoss")).toBe(false);
    const f = find(base({ server: stats(21, 1, 2, 50) }), "serverLoss");
    expect(f?.severity).toBe("medium");
    expect(f?.values).toMatchObject({ lost: 2, n: 50 });
    expect(find(base({ server: stats(21, 1, 3, 50) }), "serverLoss")?.severity).toBe("high");
  });
  it("serverLoss nur bei ruhigem Router; Router nicht bewertbar → Textvariante", () => {
    expect(has(base({ server: stats(21, 1, 3, 50), router: stats(1, 0.3, 1, 20) }), "serverLoss")).toBe(false);
    expect(find(base({ server: stats(21, 1, 3, 50), router: stats(null, null, 20, 20) }), "serverLoss")?.values.variant).toBe("noRouter");
    expect(find(base({ server: stats(21, 1, 3, 50), router: null }), "serverLoss")?.values.variant).toBe("noRouter");
  });
  it("jitterHigh: 12 ms aus ≥ 50 Messungen, Router-Schwankung unter 5 ms", () => {
    expect(has(base({ server: stats(21, 11.9, 0, 50) }), "jitterHigh")).toBe(false);
    expect(find(base({ server: stats(21, 12, 0, 50) }), "jitterHigh")?.severity).toBe("medium");
    expect(has(base({ server: stats(21, 12, 0, 49) }), "jitterHigh")).toBe(false);
    expect(has(base({ server: stats(21, 12, 0, 50), router: stats(1, 5, 0, 20) }), "jitterHigh")).toBe(false);
    expect(find(base({ server: stats(21, 12, 0, 50), router: stats(null, null, 20, 20) }), "jitterHigh")?.values.variant).toBe("noRouter");
  });
  it("ICMP-Ziel → Zusatz „Manche Server drosseln Ping-Antworten“", () => {
    const f = find(base({ server: stats(21, 12, 0, 50), target: { id: "valve-fra", label: "Valve FRA", method: "icmp" } }), "jitterHigh");
    expect(f && findingNotes(f)).toContain("icmpThrottle");
    const tcp = find(base({ server: stats(21, 12, 0, 50) }), "jitterHigh");
    expect(tcp && findingNotes(tcp)).not.toContain("icmpThrottle");
  });
  it("serverFar: Ø über 80 ms und eine Region ≥ 30 ms schneller", () => {
    const regions = (avg: number) => [{ id: "fra", name: "Frankfurt", stats: stats(avg, 1, 0, 4) }];
    expect(has(base({ server: stats(80, 1, 0, 50), regions: regions(20) }), "serverFar")).toBe(false);
    expect(find(base({ server: stats(81, 1, 0, 50), regions: regions(51) }), "serverFar")?.values).toEqual({ region: "Frankfurt", ms: 51, cur: 81 });
    expect(has(base({ server: stats(81, 1, 0, 50), regions: regions(52) }), "serverFar")).toBe(false);
  });
  it("mergeStats gewichtet nach Messungen", () => {
    const m = mergeStats([stats(10, 2, 0, 20), stats(20, 4, 2, 20), stats(30, 6, 0, 10)]);
    expect(m?.samples).toBe(50);
    expect(m?.loss).toBeCloseTo(2 / 50, 10);
    // Ø nach Antworten: (10·20 + 20·18 + 30·10) / 48
    expect(m?.avg).toBeCloseTo((10 * 20 + 20 * 18 + 30 * 10) / 48, 10);
    expect(mergeStats([])).toBeNull();
  });
});

describe("routeJump", () => {
  it("bleibt erhöht → Anbieter (+ Schwere ab 60 ms)", () => {
    const hops = [hop(1, GW, 1, "lan"), hop(2, "62.155.240.129", 40), hop(3, "62.155.240.130", 42), hop(4, "80.157.204.182", 43), hop(5, "3.123.1.77", 44, "target")];
    expect(routeJump(hops, GW)).toEqual({ jump: "isp", hop: 2, jumpMs: 39 });
    expect(find(base({ trace: { target: "x", address: null, hops, reached: true } }), "ispPath")?.severity).toBe("medium");
    const big = hops.map((h) => (h.hop > 1 ? { ...h, rtts: h.rtts.map((v) => (v === null ? null : v + 30)) } : h));
    expect(find(base({ trace: { target: "x", address: null, hops: big, reached: true } }), "ispPath")?.severity).toBe("high");
  });
  it("nur ein Ausreißer-Hop → none", () => {
    const hops = [hop(1, GW, 1, "lan"), hop(2, "62.155.240.129", 6), hop(3, "62.155.240.130", 80), hop(4, "80.157.204.182", 9), hop(5, "52.93.35.126", 10), hop(6, "3.123.1.77", 11, "target")];
    expect(routeJump(hops, GW).jump).toBe("none");
  });
  it("zu wenige Folgestationen → none", () => {
    const hops = [hop(1, GW, 1, "lan"), hop(2, "62.155.240.129", 6), hop(3, "62.155.240.130", 7), hop(4, "80.157.204.182", 50), hop(5, "3.123.1.77", 51, "target")];
    expect(routeJump(hops, GW).jump).toBe("none");
  });
  it("Sprung im Internet bzw. am Ziel", () => {
    const pub = ["62.155.240.129", "62.155.240.130", "62.155.240.131"];
    const hops = [hop(1, GW, 1, "lan"), ...pub.map((a, i) => hop(i + 2, a, 6 + i)), hop(5, "80.157.204.182", 45), hop(6, "52.93.35.126", 46), hop(7, "3.123.1.77", 47, "target")];
    expect(routeJump(hops, GW).jump).toBe("internet");
    expect(find(base({ trace: { target: "x", address: null, hops, reached: true } }), "internetPath")?.values.target).toBe("Frankfurt");
  });
  it("nicht messbar ohne Antworten außer im Heimnetz", () => {
    expect(routeJump([hop(1, GW, 1, "lan"), hop(2, null, null), hop(3, null, null)], GW).jump).toBe("notMeasurable");
    expect(routeJump([], GW).jump).toBe("notMeasurable");
  });
  it("CGNAT bei TTL 2 = Anbieter (Zonenregel der Teilroute, nicht die alte Zone)", () => {
    const hops = [hop(1, GW, 1, "lan"), hop(2, "100.64.12.1", 40, "lan"), hop(3, "62.155.240.129", 41, "lan"), hop(4, "3.123.1.77", 42, "target")];
    expect(routeJump(hops, GW).jump).toBe("isp");
  });
  it("Sprung hinter doppeltem NAT = Heimnetz", () => {
    const hops = [hop(1, "192.168.0.1", 1, "lan"), hop(2, "192.168.178.1", 40, "isp"), hop(3, "62.155.240.129", 42), hop(4, "3.123.1.77", 43, "target")];
    expect(routeJump(hops, "192.168.0.1").jump).toBe("home");
    expect(find(base({ adapters: [{ ...ethernet, gateway: "192.168.0.1" }], trace: { target: "x", address: null, hops, reached: true } }), "homeRouterJump")?.severity).toBe("medium");
  });
});

describe("slowLine", () => {
  const slow = (mbps: number) => ({ ...goodSpeed, downloadMbps: mbps });
  it("mit Eintrag: unter 50 % → mittel", () => {
    expect(has(base({ contractDownMbps: 500, speed: slow(250) }), "slowLine")).toBe(false);
    expect(find(base({ contractDownMbps: 500, speed: slow(249) }), "slowLine")).toMatchObject({ severity: "medium", values: { pct: 50, mbps: 249 } });
  });
  it("per WLAN gemessen bzw. bei Datenverkehr → nur Hinweis", () => {
    expect(find(wifiInput(-55, 90, "5", 44, { contractDownMbps: 500, speed: slow(100) }), "slowLine")).toMatchObject({ severity: "info", values: { variant: "wifi" } });
    expect(find(base({ contractDownMbps: 500, speed: slow(100), counters: counters(6) }), "slowLine")).toMatchObject({ severity: "info", values: { variant: "busy" } });
  });
  it("ohne Eintrag: unter 10 Mbit/s → Hinweis", () => {
    expect(has(base({ speed: slow(10) }), "slowLine")).toBe(false);
    expect(find(base({ speed: slow(9.9) }), "slowLine")).toMatchObject({ severity: "info", values: { variant: "noContract" } });
  });
});

describe("cpuHigh, vpnActive", () => {
  it("CPU ab 90 %", () => {
    const sys = (cpu: number) => ({ cpu, ramUsed: 1, ramTotal: 2, gpu: null, cpuName: null, gpuName: null, uptimeSeconds: null });
    expect(has(base({ system: sys(89) }), "cpuHigh")).toBe(false);
    expect(find(base({ system: sys(90) }), "cpuHigh")?.severity).toBe("medium");
  });
  it("VPN aus der Momentaufnahme", () => {
    const snap = { at: 0, cause: "unknown", cpuHigh: false, reasons: [], snapshot: { viaVpn: true, wifi: null, hops: [] } } as unknown as LagCheck;
    const r = diagnose(base({ snapshot: snap }), 1);
    expect(r.findings.map((f) => f.id)).toEqual(["vpnActive", "allGood"]);
  });
});

describe("incomplete", () => {
  const withSteps = (failed: Partial<Record<(typeof DIAGNOSE_STEPS)[number], DiagnoseStep["status"]>>) => allDone().map((s) => (failed[s.id] ? { ...s, status: failed[s.id]! } : s));
  it("1 fehlgeschlagen → nein, 2 → ja; off zählt nicht", () => {
    expect(has(base({ steps: withSteps({ route: "failed" }) }), "incomplete")).toBe(false);
    const r = diagnose(base({ steps: withSteps({ route: "failed", server: "skipped" }) }), 1);
    expect(r.verdict).toBe("incomplete");
    expect(r.findings.map((f) => f.id)).toEqual(["incomplete"]);
    expect(r.findings[0].values.steps).toBe("server,route");
    expect(has(base({ steps: withSteps({ route: "failed", speed: "off" }) }), "incomplete")).toBe(false);
    // connection/local zählen nicht
    expect(has(base({ steps: withSteps({ connection: "failed", local: "failed" }) }), "incomplete")).toBe(false);
  });
  it("mit einem mittleren Befund bleibt dieser das verdict", () => {
    const r = diagnose(base({ steps: withSteps({ route: "failed", server: "failed" }), speed: { ...goodSpeed, bufferbloatMs: 80 } }), 1);
    expect(r.verdict).toBe("bufferbloat");
    expect(r.findings.map((f) => f.id)).toEqual(["bufferbloat", "incomplete"]);
  });
});

describe("Sortierung, verdict, höchstens 4", () => {
  it("hoch vor mittel vor Hinweis, bei gleicher Schwere wie in der Tabelle", () => {
    const input = wifiInput(-72, 60, "5", 44, { speed: { ...goodSpeed, bufferbloatMs: 80 }, counters: counters(10) });
    const r = diagnose(input, 1);
    expect(r.findings.map((f) => f.id)).toEqual(["localTraffic", "bufferbloat", "wifiWeak"]);
    expect(r.verdict).toBe("localTraffic");
  });
  it("höchstens 4 Befunde, verdict immer dabei", () => {
    const snap = { at: 0, cause: "unknown", cpuHigh: false, reasons: [], snapshot: { viaVpn: true, wifi: null, hops: [] } } as unknown as LagCheck;
    const sys = { cpu: 95, ramUsed: 1, ramTotal: 2, gpu: null, cpuName: null, gpuName: null, uptimeSeconds: null };
    const input = wifiInput(-80, 30, "2.4", 6, { speed: { ...goodSpeed, bufferbloatMs: 250 }, counters: counters(20), system: sys, snapshot: snap, router: stats(30, 12, 3, 20) });
    const r = diagnose(input, 1);
    expect(r.findings.length).toBe(MAX_FINDINGS);
    expect(r.findings[0].id).toBe(r.verdict);
    // nur Hinweise: allGood wird nicht herausgekürzt
    const infos = base({ adapters: [wlan], wifiState: { state: "locked", wifi: null }, snapshot: snap, router: stats(null, null, 20, 20), contractDownMbps: 500, speed: { ...goodSpeed, downloadMbps: 100 }, counters: counters(4) });
    const r2 = diagnose(infos, 1);
    expect(r2.verdict).toBe("allGood");
    expect(r2.findings.length).toBe(MAX_FINDINGS);
    expect(r2.findings.map((f) => f.id)).toContain("allGood");
  });
  it("diagnose.last ohne input, tolerant lesbar", () => {
    const r = diagnose(base({ speed: { ...goodSpeed, bufferbloatMs: 80 } }), 123);
    const last = stripInput(r);
    expect("input" in last).toBe(false);
    expect(parseLast(JSON.parse(JSON.stringify(last)))).toEqual(last);
    expect(parseLast({ at: 1, verdict: "kaputt", findings: [] })).toBeNull();
    expect(parseLast(null)).toBeNull();
    expect(parseLast({ ...last, findings: [...last.findings, { id: "gibtsnicht", severity: "high", values: {} }] })?.findings.length).toBe(last.findings.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Speedtest-Verbrauch
// ---------------------------------------------------------------------------------------------

describe("Speedtest-Verbrauch", () => {
  it("Laufzeiten stimmen mit speed.rs überein", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../../src-tauri/src/net/speed.rs"), "utf8");
    expect(src).toMatch(new RegExp(`DOWNLOAD_DURATION: Duration = Duration::from_secs\\(${SPEEDTEST_DOWN_S}\\)`));
    expect(src).toMatch(new RegExp(`UPLOAD_DURATION: Duration = Duration::from_secs\\(${SPEEDTEST_UP_S}\\)`));
  });
  it("Obergrenze aus der Leitung", () => {
    // 100 Mbit/s ↓, 40 ↑: (100·8 + 40·6)/8 · 1,05 = 136,5 → 140 MB
    expect(speedtestMaxMb(100, 40)).toBe(140);
    expect(SPEEDTEST_MAX_MB).toBe(speedtestMaxMb(1000, 1000));
    // Vertrag vor Adapter, Adapter vor 1 Gbit/s
    expect(speedtestBudgetMb({ down: 100, up: 40 }, 2500)).toBe(140);
    expect(speedtestBudgetMb({ down: null, up: null }, 100)).toBe(speedtestMaxMb(100, 100));
    // ohne eingetragenen Upload höchstens der Download-Wert (nicht die Adaptergeschwindigkeit)
    expect(speedtestBudgetMb({ down: 500, up: null }, 2500)).toBe(speedtestMaxMb(500, 500));
    expect(speedtestBudgetMb({ down: 500, up: null }, 287)).toBe(speedtestMaxMb(500, 287));
    expect(speedtestBudgetMb({ down: null, up: null }, null)).toBe(SPEEDTEST_MAX_MB);
  });
});

// ---------------------------------------------------------------------------------------------
// Texte (dynamische Schlüssel)
// ---------------------------------------------------------------------------------------------

function lookup(dict: unknown, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof cur === "string" ? cur : undefined;
}

describe("Texte de/en", () => {
  for (const [lang, dict] of [
    ["de", de],
    ["en", en],
  ] as const) {
    const tr = (key: string, vars?: Record<string, string | number>) => {
      const raw = lookup(dict, key);
      if (raw === undefined) throw new Error(`${lang}: fehlt ${key}`);
      return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`)) : raw;
    };
    const fmt = (n: number) => String(n);

    it(`${lang}: jeder Befund hat Text und 2–4 Schritte`, () => {
      for (const id of FINDING_IDS) {
        expect(lookup(dict, `diagnose.finding.${id}`), `${lang} finding.${id}`).toBeTruthy();
        expect(FIX_COUNT[id]).toBeGreaterThanOrEqual(2);
        expect(FIX_COUNT[id]).toBeLessThanOrEqual(4);
        for (let n = 1; n <= FIX_COUNT[id]; n++) expect(lookup(dict, `diagnose.fix.${id}.${n}`), `${lang} fix.${id}.${n}`).toBeTruthy();
        expect(lookup(dict, `diagnose.fix.${id}.${FIX_COUNT[id] + 1}`), `${lang} fix.${id} zu viele`).toBeUndefined();
      }
      expect(lookup(dict, "diagnose.fix.routerSlow.2wifi")).toBeTruthy();
    });

    it(`${lang}: Varianten, Hinweise, Verweise, Schritte, Zustände`, () => {
      for (const v of ["wifiWeak.signal", "serverLoss.noRouter", "jitterHigh.noRouter", "slowLine.wifi", "slowLine.busy", "slowLine.noContract"]) expect(lookup(dict, `diagnose.variant.${v}`), v).toBeTruthy();
      for (const n of ["icmpThrottle", "notGuaranteed", "gamePath"]) expect(lookup(dict, `diagnose.note.${n}`)).toBeTruthy();
      for (const l of Object.values(LINKS).flat()) expect(lookup(dict, `diagnose.link.${l.label}`), l.label).toBeTruthy();
      for (const s of DIAGNOSE_STEPS) {
        expect(lookup(dict, `diagnose.step.${s}.name`)).toBeTruthy();
        expect(lookup(dict, `diagnose.step.${s}.desc`)).toBeTruthy();
      }
      for (const st of ["pending", "running", "done", "skipped", "failed", "off", "cancelled"]) expect(lookup(dict, `diagnose.status.${st}`)).toBeTruthy();
      for (const sev of ["high", "medium", "info", "ok"]) expect(lookup(dict, `diagnose.severity.${sev}`)).toBeTruthy();
      for (const p of ["latency", "download", "upload", "done"]) expect(lookup(dict, `diagnose.detail.phase.${p}`)).toBeTruthy();
    });

    it(`${lang}: alle Platzhalter werden ersetzt`, () => {
      const samples: Finding[] = [
        { id: "localTraffic", severity: "high", values: { mbps: 7.5 } },
        { id: "bufferbloat", severity: "medium", values: { ms: 78 } },
        { id: "wifiWeak", severity: "medium", values: { rssi: -72, signal: 52 } },
        { id: "wifiWeak", severity: "medium", values: { signal: 40, variant: "signal" } },
        { id: "wifiBand24", severity: "medium", values: { rssi: -66, band: "5" } },
        { id: "wifiChannel", severity: "medium", values: { current: 6, recommended: 1, band: "2.4" } },
        { id: "routerSlow", severity: "high", values: { ms: 12, jitter: 3, lost: 2, n: 20, via: "wifi" } },
        { id: "serverLoss", severity: "medium", values: { lost: 2, n: 50, icmp: 0 } },
        { id: "serverLoss", severity: "medium", values: { lost: 2, n: 50, icmp: 1, variant: "noRouter" } },
        { id: "ispPath", severity: "medium", values: { ms: 40, hop: 2 } },
        { id: "internetPath", severity: "medium", values: { ms: 40, hop: 5, target: "Frankfurt" } },
        { id: "serverFar", severity: "medium", values: { region: "Paris", ms: 20, cur: 90 } },
        { id: "jitterHigh", severity: "medium", values: { ms: 13, icmp: 0 } },
        { id: "jitterHigh", severity: "medium", values: { ms: 13, icmp: 0, variant: "noRouter" } },
        { id: "slowLine", severity: "medium", values: { pct: 40, mbps: 200, contract: 500 } },
        { id: "slowLine", severity: "info", values: { pct: 40, mbps: 200, contract: 500, variant: "wifi" } },
        { id: "slowLine", severity: "info", values: { pct: 40, mbps: 200, contract: 500, variant: "busy" } },
        { id: "slowLine", severity: "info", values: { mbps: 8, variant: "noContract" } },
        { id: "cpuHigh", severity: "medium", values: { pct: 95 } },
        { id: "incomplete", severity: "info", values: { steps: "server,route" } },
        ...(["noLink", "offline", "homeRouterJump", "vpnActive", "wifiLocked", "routerNoAnswer", "wifiBand24Maybe", "allGood"] as const).map((id): Finding => ({ id, severity: "info", values: {} })),
      ];
      for (const f of samples) {
        const text = findingText(f, tr, fmt);
        expect(text, `${lang} ${f.id}`).not.toMatch(/\{\w+\}/);
        for (const step of fixTexts(f, tr, fmt)) expect(step, `${lang} ${f.id} Schritt`).not.toMatch(/\{\w+\}/);
      }
    });
  }

  it("Breitbandmessung nur bei slowLine", () => {
    for (const id of FINDING_IDS) {
      const texts = [lookup(de, `diagnose.finding.${id}`) ?? "", ...Array.from({ length: FIX_COUNT[id] }, (_, i) => lookup(de, `diagnose.fix.${id}.${i + 1}`) ?? "")].join(" ");
      if (id !== "slowLine") expect(texts.toLowerCase(), id).not.toContain("breitbandmessung");
    }
    expect(Object.entries(LINKS).filter(([, ls]) => ls?.some((l) => l.kind === "url" && l.url.includes("breitbandmessung"))).map(([id]) => id)).toEqual(["slowLine"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Ablauf mit dem Demo-Backend
// ---------------------------------------------------------------------------------------------

type Win = Record<string, unknown>;
const setWindow = (flags: Win | null) => {
  if (flags) (globalThis as unknown as { window: Win }).window = flags;
  else delete (globalThis as unknown as { window?: unknown }).window;
};

describe("Ablauf (store/diagnose) mit dem Demo-Backend", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    // Demo-Backend und Stores vorab laden (dynamische Importe laufen nicht unter Fake-Zeit)
    await import("../store/diagnose");
    const { api } = await import("./api");
    await api.appInfo();
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    setWindow(null);
    vi.restoreAllMocks();
  });

  /** Fake-Zeit vorrücken, bis die Bedingung erfüllt ist (das Demo-Backend lädt per dynamischem Import) */
  async function advanceUntil(done: () => boolean, stepMs = 100, maxSteps = 2000) {
    for (let i = 0; i < maxSteps && !done(); i++) await vi.advanceTimersByTimeAsync(stepMs);
  }

  /** Ein Versprechen unter Fake-Zeit abwarten (das Demo-Backend wartet selbst per setTimeout) */
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    const out = p.finally(() => {
      done = true;
    });
    await advanceUntil(() => done, 25);
    return out;
  }

  async function runOnce(flags: Win | null) {
    const { useDiagnose, diagnoseRunning } = await import("../store/diagnose");
    const { useSettings } = await import("../store/settings");
    const s = useSettings.getState().settings;
    useSettings.setState({ settings: { ...s, ispLog: { slowMs: 100, contractDownMbps: 500, contractUpMbps: null, contractDownNormalMbps: null, contractDownMinMbps: null } } });
    setWindow(flags);
    const p = useDiagnose.getState().start();
    await advanceUntil(() => !diagnoseRunning());
    await p;
    return useDiagnose.getState();
  }

  it("ohne Schalter (Kabel, Bufferbloat 34,6 ms) → allGood", async () => {
    const st = await runOnce(null);
    expect(st.phase).toBe("idle");
    expect(st.result?.verdict).toBe("allGood");
    expect(st.result?.findings.map((f) => f.id)).toEqual(["allGood"]);
    expect(st.result?.steps.every((x) => x.status === "done")).toBe(true);
  });

  it("mit __pulsarWifiPrimary + __pulsarDiagnoseDemo → bufferbloat, wifiBand24, wifiChannel", async () => {
    const st = await runOnce({ __pulsarWifiPrimary: true, __pulsarDiagnoseDemo: true });
    expect(st.result?.verdict).toBe("bufferbloat");
    expect(st.result?.findings.map((f) => f.id)).toEqual(["bufferbloat", "wifiBand24", "wifiChannel"]);
    expect(st.result?.findings[0].values.ms).toBe(78);
  });

  it("diagnose.last enthält kein input", async () => {
    await runOnce(null);
    const { api } = await import("./api");
    const last = await settle(api.kvGet<Record<string, unknown>>("diagnose.last"));
    expect(last).toBeTruthy();
    expect(last && "input" in last).toBe(false);
    expect(parseLast(last)?.verdict).toBe("allGood");
  });

  it("bricht sauber ab (während des Speedtests) und speichert nichts", async () => {
    const { useDiagnose, diagnoseRunning } = await import("../store/diagnose");
    const { api } = await import("./api");
    await settle(api.kvSet("diagnose.last", null));
    const p = useDiagnose.getState().start();
    // bis in den Speedtest (Verbindung, Router, Server ≈ 1 s, Route ≈ 2,7 s, Datenverkehr 2 s)
    await advanceUntil(() => useDiagnose.getState().current === "speed");
    expect(useDiagnose.getState().current).toBe("speed");
    const cancel = useDiagnose.getState().cancel();
    expect(useDiagnose.getState().phase).toBe("cancelling");
    await advanceUntil(() => !diagnoseRunning());
    await settle(cancel);
    await p;
    const st = useDiagnose.getState();
    expect(st.phase).toBe("idle");
    expect(st.cancelled).toBe(true);
    expect(st.result).toBeNull();
    expect(diagnoseRunning()).toBe(false);
    expect(st.steps.speed.status).toBe("cancelled");
    expect(await settle(api.kvGet("diagnose.last"))).toBeNull();
  });

  it("bricht während der Routen-Analyse ab: Ergebnis verworfen", async () => {
    const { useDiagnose, diagnoseRunning } = await import("../store/diagnose");
    const p = useDiagnose.getState().start();
    await advanceUntil(() => useDiagnose.getState().current === "route", 50);
    expect(useDiagnose.getState().current).toBe("route");
    void useDiagnose.getState().cancel();
    await advanceUntil(() => !diagnoseRunning());
    await p;
    const st = useDiagnose.getState();
    expect(st.cancelled).toBe(true);
    expect(st.result).toBeNull();
    expect(st.input?.trace).toBeNull();
    expect(st.steps.route.status).toBe("cancelled");
    expect(st.steps.local.status).toBe("pending");
  });

  it("getaktete Verbindung → Speedtest standardmäßig aus, Schritt `off`", async () => {
    const { useDiagnose, diagnoseRunning } = await import("../store/diagnose");
    const { api } = await import("./api");
    vi.spyOn(api, "metered").mockResolvedValue(true);
    useDiagnose.setState({ speedTouched: false, withSpeedtest: true });
    await settle(useDiagnose.getState().init());
    expect(useDiagnose.getState().withSpeedtest).toBe(false);
    expect(useDiagnose.getState().metered).toBe(true);
    const p = useDiagnose.getState().start();
    await advanceUntil(() => !diagnoseRunning());
    await p;
    const st = useDiagnose.getState();
    expect(st.result?.steps.find((s) => s.id === "speed")?.status).toBe("off");
    expect(st.result?.findings.some((f) => f.id === "incomplete")).toBe(false);
    // eigene Wahl des Nutzers bleibt
    useDiagnose.getState().setWithSpeedtest(true);
    await settle(useDiagnose.getState().init());
    expect(useDiagnose.getState().withSpeedtest).toBe(true);
  });
});
