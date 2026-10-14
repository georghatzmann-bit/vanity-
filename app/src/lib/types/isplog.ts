/**
 * Anbieter-Protokoll (Bericht als HTML/CSV). Vertrag: docs/API.md, „Anbieter-Protokoll“.
 * Das Protokoll ist ein Indiz, kein Nachweis.
 */
import type { Language } from "../types";
import type { EventSummaryRow, HourlyRow, NetEvent } from "./history";

/** Einstellungen `ispLog` */
export interface IspLogSettings {
  /** „Langsam ab … ms“ (30–1000) */
  slowMs: number;
  /** Maximal-Geschwindigkeit laut Vertrag (Produktinformationsblatt), 1–10 000 oder null */
  contractDownMbps: number | null;
  contractUpMbps: number | null;
  /** optional: normalerweise verfügbar / minimal */
  contractDownNormalMbps: number | null;
  contractDownMinMbps: number | null;
}

/** Zeitraum des Protokolls in Tagen (Standard 30) */
export type IspLogRange = 7 | 30 | 90;

/** Eingabe von `buildIspLog` */
export interface IspLogInput {
  events: NetEvent[];
  /** `net_events_list` war gekappt */
  truncated: boolean;
  summary: EventSummaryRow[];
  hourly: HourlyRow[];
  from: number;
  to: number;
  netId: string;
  contract: IspLogSettings;
  lang: Language;
  timeZone: string;
}

/** Tageswerte (Ortszeit) */
export interface IspLogDay {
  /** JJJJ-MM-TT (Ortszeit) */
  date: string;
  /** nur `scope = internet` */
  internetOutages: number;
  internetOutageS: number;
  homeNetworkOutages: number;
  targetOnlyOutages: number;
  pcOutages: number;
  unknownOutages: number;
  lossWindows: number;
  slowMinutes: number;
  /** Ausreißer nach Ursache (Σ count) */
  spikesByCause: Partial<Record<"home" | "isp" | "internet" | "unknown", number>>;
  /** Messstunden (coveredMs ≥ 30 min) */
  measuredHours: number;
  speedtests: number;
}

/** Ergebnis von `buildIspLog` */
export interface IspLogResult {
  header: {
    from: number;
    to: number;
    timeZone: string;
    /** z. B. „UTC+2“ */
    utcOffset: string;
    targets: { key: string; label: string; method: "icmp" | "tcp" }[];
    hours: number;
    days: number;
    /** Anteil der Messzeit per WLAN bzw. mit VPN (0–1) */
    wifiShare: number;
    vpnShare: number;
    otherNets: number;
  };
  days: IspLogDay[];
  html: string;
  csv: string;
}
