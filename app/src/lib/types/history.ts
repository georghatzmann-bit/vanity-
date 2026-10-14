/**
 * Netzwerk-Verlauf (Datenbank v2): gemeinsame Typen von Zeitleiste, Kalender, Anbieter-Protokoll und
 * Lag-Detektiv. Vertrag: docs/API.md, „Datenbank v2“. Rust: src-tauri/src/net/hist_types.rs.
 */
import type { LagCause, Reason } from "./lag";
import type { PingMethod, SpeedResult } from "../types";

export const CONNECTION_KINDS = ["wifi", "ethernet", "other", "vpn"] as const;
/** Verbindungsart einer Messung (`vpn` hat Vorrang vor der Adapterart) */
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const TARGET_KINDS = ["region", "server", "other"] as const;
/** Art des Messziels: `aws-…` = Region, `valve-…`/`riot-…` = Spielserver */
export type TargetKind = (typeof TARGET_KINDS)[number];

export const EVENT_KINDS = ["outage", "loss", "slow", "spike", "speedtest", "quiet"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const OUTAGE_SCOPES = ["pc", "homeNetwork", "internet", "targetOnly", "unknown"] as const;
/** Umfang eines Aussetzers (nur `internet` ist ein „Aussetzer der Internetverbindung“) */
export type OutageScope = (typeof OUTAGE_SCOPES)[number];

/** Station in `detail.snap.hops`: [ttl, rtt | null, zone | null] – ohne Adressen */
export type StoredHop = [number, number | null, "lan" | "isp" | "internet" | "target" | null];

/** `detail` eines `spike` (Kurzschlüssel, höchstens 1 KiB) */
export interface SpikeDetail {
  count: number;
  baseline: number;
  limit: number;
  cpuHigh: boolean;
  reasons: Reason[];
  snap?: {
    conn: "wifi" | "ethernet" | "other" | null;
    vpn: boolean;
    hops: StoredHop[];
    gw: number | null;
    gwB: number | null;
    tgt: number | null;
    rssi: number | null;
    sig: number | null;
    rx: number | null;
    tx: number | null;
    cpu: number | null;
  };
}
export interface LossDetail {
  lost: number;
  n: number;
}
export interface SlowDetail {
  threshold: number;
  minutes: number;
}
export interface OutageDetail {
  checks: { link: boolean | null; gw: boolean | null; ext: boolean | null };
}
export type SpeedtestDetail = SpeedResult & { connection: ConnectionKind | null; localMbps: number | null };
export interface QuietDetail {
  reason: "speedtest" | "wifiScan";
}
export type NetEventDetail = SpikeDetail | LossDetail | SlowDetail | OutageDetail | SpeedtestDetail | QuietDetail;

/** Ein Eintrag aus `net_events` */
export interface NetEvent {
  id: number;
  /** Beginn (ms UTC) */
  t: number;
  /** Ende; null bei `spike` und `speedtest` */
  endT: number | null;
  kind: EventKind;
  targetKey: string | null;
  targetLabel: string | null;
  method: PingMethod | null;
  /** Netz-Kennung (Hash, "" = unbekannt) */
  netId: string;
  connection: ConnectionKind | null;
  /** Dauer (s), Verlust (%), ms oder Mbit/s – je `kind` */
  value: number | null;
  /** nur `spike` */
  cause: LagCause | null;
  /** nur `outage` */
  scope: OutageScope | null;
  sessionId: number | null;
  detail: NetEventDetail | null;
}

/** `net_events_list` */
export interface EventsPage {
  events: NetEvent[];
  /** mehr als `limit` Treffer: nur die neuesten geliefert */
  truncated: boolean;
}

/** `net_events_summary` – je UTC-Stunde gruppiert */
export interface EventSummaryRow {
  hourStart: number;
  kind: EventKind;
  cause: LagCause | null;
  scope: OutageScope | null;
  connection: ConnectionKind | null;
  netId: string;
  rows: number;
  /** Σ `detail.count` bzw. 1 je Zeile */
  countSum: number;
  /** Σ(endT − t) / 1000 */
  durationS: number;
}

/** Eine Zeile aus `ping_hourly` (Rohsummen) */
export interface HourlyRow {
  hourStart: number;
  targetKey: string;
  netId: string;
  connection: ConnectionKind;
  kind: TargetKind;
  label: string;
  method: PingMethod;
  n: number;
  lost: number;
  sumRtt: number;
  sumJitter: number;
  nJitter: number;
  maxRtt: number | null;
  spikes: number;
  coveredMs: number;
}

export interface TimelineTarget {
  key: string;
  label: string;
  method: PingMethod;
}

/** [t, rtt | null, cpu | null, rxMbps | null, txMbps | null] */
export type TimelinePoint = [number, number | null, number | null, number | null, number | null];

/** `net_session_timeline` */
export interface SessionTimeline {
  sessionId: number;
  gameId: string;
  start: number;
  end: number;
  targets: TimelineTarget[];
  targetChanges: { t: number; key: string }[];
  /** 1 = gespeicherte Punkte, sonst zusammengefasste Punkte je Punkt */
  merged: number;
  points: TimelinePoint[];
  events: NetEvent[];
}

/** `net_history_clear(scope)` */
export type HistoryClearScope = "events" | "all";

/** Einstellungen `history` */
export interface HistorySettings {
  /** „Messverlauf dauerhaft speichern“ */
  record: boolean;
}
