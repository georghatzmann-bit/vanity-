/**
 * Anbieter-Protokoll (Bericht als HTML/CSV). Vertrag: docs/API.md, „Anbieter-Protokoll“.
 * Das Protokoll ist ein Indiz, kein Nachweis.
 */
import type { Language, PingMethod } from "../types";
import type { ConnectionKind, EventKind, EventSummaryRow, HourlyRow, NetEvent, OutageScope } from "./history";

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
  /** Ereignisse (ohne `spike`); andere Netze werden herausgefiltert */
  events: NetEvent[];
  /** `net_events_list` war gekappt */
  truncated: boolean;
  /** Zählungen je Stunde (auch anderer Netze – für den Hinweis „andere Netze“) */
  summary: EventSummaryRow[];
  /** Stunden-Summen (auch anderer Netze – für den Hinweis „andere Netze“) */
  hourly: HourlyRow[];
  from: number;
  to: number;
  netId: string;
  contract: IspLogSettings;
  lang: Language;
  timeZone: string;
  /** Erstellt am (Standard: jetzt) */
  now?: number;
}

/** Ausreißer nach vermuteter Ursache: Heimnetz/WLAN/PC, Anschluss/Anbieter, Internet, unklar */
export type SpikeGroup = "home" | "isp" | "internet" | "unknown";

/** Speedtests eines Tages */
export interface IspLogSpeed {
  n: number;
  downMin: number;
  downMedian: number;
  upMin: number;
  upMedian: number;
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
  /** Verlust-Fenster mit dem höchsten Anteil des Tages */
  lossWorst: { lost: number; n: number; pct: number } | null;
  slowMinutes: number;
  /** langsame Minuten je Ziel */
  slowByTarget: { key: string; label: string; minutes: number }[];
  /** Ausreißer nach Ursache (Σ count) */
  spikesByCause: Partial<Record<SpikeGroup, number>>;
  /** Messstunden (Stundengruppe mit coveredMs ≥ 30 min) */
  measuredHours: number;
  coveredMs: number;
  speedtests: number;
  speed: IspLogSpeed | null;
}

/** Eine Zeile der Ereignisliste (ohne Ausreißer) */
export interface IspLogRow {
  id: number;
  t: number;
  endT: number | null;
  kind: Exclude<EventKind, "spike">;
  scope: OutageScope | null;
  targetKey: string | null;
  /** schon als „eigenes Ziel“ ersetzt, wenn der Name wie eine Adresse aussieht */
  targetLabel: string | null;
  method: PingMethod | null;
  connection: ConnectionKind | null;
  value: number | null;
  sessionId: number | null;
  /** lesbarer Wert („3 von 60 Paketen (5 %)“, „4 s ohne Antwort“ …) */
  text: string;
}

/** Messziel im Kopf */
export interface IspLogTarget {
  key: string;
  label: string;
  method: PingMethod;
  /** „ICMP“, „TCP:443“ (Rechenzentren) bzw. „TCP“ */
  methodText: string;
  coveredMs: number;
}

/** Ergebnis von `buildIspLog` */
export interface IspLogResult {
  header: {
    from: number;
    to: number;
    timeZone: string;
    /** z. B. „UTC+2“ (wechselt die Sommerzeit im Zeitraum: „UTC+2 / UTC+1“) */
    utcOffset: string;
    targets: IspLogTarget[];
    hours: number;
    days: number;
    /** Anteil der Messzeit per WLAN bzw. mit VPN (0–1) */
    wifiShare: number;
    vpnShare: number;
    otherNets: number;
    truncated: boolean;
  };
  totals: {
    internetOutages: number;
    internetOutageS: number;
    otherOutages: number;
    lossWindows: number;
    slowMinutes: number;
    speedtests: number;
    /** Median-Download aller Speedtests */
    downMedian: number | null;
    spikesByCause: Partial<Record<SpikeGroup, number>>;
  };
  days: IspLogDay[];
  rows: IspLogRow[];
  html: string;
  csv: string;
}
