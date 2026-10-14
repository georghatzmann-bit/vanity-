/**
 * „Warum laggt es?“ – geführte Prüfung mit regelbasierter Diagnose.
 * Vertrag: docs/API.md, „„Warum laggt es?““.
 */
import type { AdapterInfo, PingStats, RegionPing, SpeedResult, SystemStats, TraceResult } from "../types";
import type { IfCounters, LagCheck } from "./lag";
import type { WifiScan, WifiStateInfo } from "./wifi";

export const DIAGNOSE_STEPS = ["connection", "router", "server", "route", "local", "speed"] as const;
export type DiagnoseStepId = (typeof DIAGNOSE_STEPS)[number];

/** off = vom Nutzer abgewählt (zählt nicht als „unvollständig“) */
export type DiagnoseStepStatus = "done" | "skipped" | "failed" | "off";

export const FINDING_IDS = [
  "noLink",
  "offline",
  "localTraffic",
  "bufferbloat",
  "wifiWeak",
  "wifiBand24",
  "wifiChannel",
  "routerSlow",
  "homeRouterJump",
  "routeUnclear",
  "serverLoss",
  "ispPath",
  "internetPath",
  "serverFar",
  "jitterHigh",
  "slowLine",
  "cpuHigh",
  "vpnActive",
  "wifiLocked",
  "routerNoAnswer",
  "wifiBand24Maybe",
  "incomplete",
  "allGood",
] as const;
/** Befund (Texte `diagnose.finding.<id>`, Schritte `diagnose.fix.<id>.<n>`) – Reihenfolge = Tabelle */
export type FindingId = (typeof FINDING_IDS)[number];

export type Severity = "high" | "medium" | "info" | "ok";

/** Ergebnis von `routeJump(hops, gateway)` */
/** `unclear` = privater Hop hinter TTL 1, der nicht das Gateway ist (zweiter Router oder Netz des Anbieters, z. B. Mobilfunk) */
export type RouteJump = "home" | "unclear" | "isp" | "internet" | "target" | "none" | "notMeasurable";

export interface Finding {
  id: FindingId;
  severity: Severity;
  /** abgeleitete Werte für die Texte (keine Adressen, kein WLAN-Scan) */
  values: Record<string, number | string>;
}

export interface DiagnoseStep {
  id: DiagnoseStepId;
  status: DiagnoseStepStatus;
  error?: string;
}

/** Gesammelte Messwerte der Prüfung (Eingabe von `diagnose(input)`; null = nicht gemessen) */
export interface DiagnoseInput {
  steps: DiagnoseStep[];
  /** Schritt `connection` */
  adapters: AdapterInfo[] | null;
  wifiState: WifiStateInfo | null;
  wifiScan: WifiScan | null;
  metered: boolean | null;
  /** Schritt `router`: 20 Pings an das Gateway, Zusatzauskunft der Momentaufnahme */
  router: PingStats | null;
  snapshot: LagCheck | null;
  /** Schritt `server`: Messziel (≥ 50 Messungen) und Lieblingsregionen */
  target: { id: string; label: string; method: "icmp" | "tcp" } | null;
  server: PingStats | null;
  regions: (RegionPing & { name: string })[] | null;
  /** Schritt `route` */
  trace: TraceResult | null;
  /** Schritt `local`: CPU und Datenverkehr vor dem Speedtest (zweimal im Abstand von 2 s) */
  system: SystemStats | null;
  counters: [IfCounters | null, IfCounters | null] | null;
  /** Schritt `speed` */
  speed: SpeedResult | null;
  /** eingetragene Maximal-Geschwindigkeit (Mbit/s) */
  contractDownMbps: number | null;
}

/** `diagnose(input)` */
export interface DiagnoseResult {
  at: number;
  /** erster Befund mit Schwere hoch/mittel, sonst `incomplete`, sonst `allGood` */
  verdict: FindingId;
  findings: Finding[];
  steps: DiagnoseStep[];
  input: DiagnoseInput;
}

/** kv `diagnose.last` – ohne `input` */
export type DiagnoseLast = Omit<DiagnoseResult, "input">;
