/**
 * Lag-Detektiv: Ursachen, Momentaufnahme, Event `net://lag`. Vertrag: docs/API.md, „Lag-Detektiv“.
 * Rust: src-tauri/src/net/lag.rs, quickhops.rs, ifstats.rs.
 */
import type { TargetKind } from "./history";

export const LAG_CAUSES = ["wifi", "router", "isp", "internet", "localTraffic", "unknown"] as const;
/** Eingeschätzte Ursache eines Ausreißers (Texte `lag.cause.*`) */
export type LagCause = (typeof LAG_CAUSES)[number];

export const REASONS = [
  "trafficHigh",
  "spikeGone",
  "rssiLow",
  "signalDrop",
  "gatewaySlow",
  "gatewayLost",
  "ispHopSlow",
  "ispHopOnly",
  "lineBusyPossible",
  "pathOk",
  "vpnActive",
  "wifiLocked",
  "connectionOther",
  "noHops",
  "noBaseline",
  "noTargetCheck",
  "snapshotsOff",
  "cpuHigh",
] as const;
/** Begründung einer Einschätzung (Texte `lag.reason.*`) */
export type Reason = (typeof REASONS)[number];

export type HopZone = "lan" | "isp" | "internet" | "target";

/** Station der schnellen Teilroute (TTL 1–3) */
export interface QuickHop {
  ttl: number;
  /** nur live, nie gespeichert */
  address: string | null;
  rtt: number | null;
  /** null = stumme Station („keine Antwort“) */
  zone: HopZone | null;
  /** Anbieter hinter Carrier-NAT („Anbieter (CGNAT)“) */
  cgnat: boolean;
  baseMs: number | null;
}

export interface LagSnapshot {
  at: number;
  connection: "wifi" | "ethernet" | "other" | null;
  viaVpn: boolean;
  /** Median der Antworten von 3 Messungen (null = nicht gemessen/keine Antwort) */
  targetMs: number | null;
  /** Verluste von 3 (null = nicht gemessen) */
  targetLost: number | null;
  hops: QuickHop[];
  gatewayMs: number | null;
  gatewayBaseMs: number | null;
  wifi: { signal: number; rssi: number | null; band: "2.4" | "5" | "6" | null } | null;
  wifiState: "ok" | "locked" | "none" | null;
  signalBase: number | null;
  rxMbps: number | null;
  txMbps: number | null;
  trafficBaseMbps: number | null;
  refDownMbps: number | null;
  refUpMbps: number | null;
  cpu: number | null;
  tookMs: number;
}

/** `net_lag_snapshot` */
export interface LagCheck {
  at: number;
  cause: LagCause;
  cpuHigh: boolean;
  reasons: Reason[];
  snapshot: LagSnapshot;
}

/** Event `net://lag` und `net_lag_recent` (die Oberfläche ersetzt per `at` + `targetId`) */
export interface LagEvent extends LagCheck {
  targetId: string;
  targetLabel: string;
  targetKind: TargetKind;
  rtt: number;
  /** Median des Fensters */
  baseline: number;
  /** Ausreißer-Grenze */
  limit: number;
  /** Ausreißer in diesen 10 s */
  count: number;
  sessionId: number | null;
}

/** `net_if_counters` */
export interface IfCounters {
  adapterId: string;
  adapter: string;
  rxBytes: number;
  txBytes: number;
  at: number;
  /** aus dem Ringpuffer; null, wenn der Monitor nicht läuft */
  rxMbps: number | null;
  txMbps: number | null;
}

/** Einstellungen `lag` */
export interface LagSettings {
  /** Momentaufnahmen und Ruhe-Messungen */
  snapshots: boolean;
}
