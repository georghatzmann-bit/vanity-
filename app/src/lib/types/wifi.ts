/**
 * WLAN-Scanner und Raum-Scan. Vertrag: docs/API.md, „WLAN-Scanner und Raum-Scan“.
 * Rust: src-tauri/src/net/wifiscan.rs. SSIDs/BSSIDs fremder Netze nur im Speicher – nie speichern.
 */
import type { WifiInfo } from "../types";

export type WifiBand = "2.4" | "5" | "6";

/** Ein WLAN-Netz (BSS) aus dem Scan */
export interface WifiNetwork {
  /** "" = verstecktes Netz */
  ssid: string;
  /** aa:bb:cc:dd:ee:ff */
  bssid: string;
  /** dBm */
  rssi: number;
  /** Qualität 0–100 */
  signal: number;
  channel: number;
  band: WifiBand;
  centerKhz: number;
  /** 20/40/80/160/320, null = unbekannt (wie 20 MHz) */
  widthMhz: number | null;
  phy: string;
  secured: boolean;
  connected: boolean;
  ageS: number | null;
}

/** `net_wifi_scan(refresh)` */
export interface WifiScan {
  at: number;
  /** true = nach aktivem Scan, false = Windows-Zwischenspeicher */
  fresh: boolean;
  interfaces: number;
  networks: WifiNetwork[];
}

export const WIFI_STATES = ["connected", "notConnected", "noService", "locked"] as const;
export type WifiStateKind = (typeof WIFI_STATES)[number];

/** `net_wifi_state()` – unterscheidet „kein WLAN“ von „gesperrt“ (24H2-Standortsperre) */
export interface WifiStateInfo {
  state: WifiStateKind;
  wifi: WifiInfo | null;
}

export const CHANNEL_NOTES = ["overlap", "dfs", "dfsWeather", "noConnection", "band24Crowded", "cacheOnly", "ownExtraSsids", "wiredPrimary", "nonWifiInterference"] as const;
/** Hinweise der Kanal-Empfehlung (Texte `wifiScan.note.*`) */
export type ChannelNote = (typeof CHANNEL_NOTES)[number];

/** `channelAdvice(networks, own, opts)` */
export interface ChannelAdvice {
  band: WifiBand;
  current: number | null;
  recommended: number;
  widthMhz: number;
  dfs: boolean;
  loadCurrent: number | null;
  loadRecommended: number;
  alternatives: number[];
  improvement: "none" | "small" | "clear";
  notes: ChannelNote[];
}

/** Eine Messung im Raum-Scan (BSSID nur des eigenen Zugangspunkts) */
export interface RoomSample {
  t: number;
  rssi: number;
  signal: number;
  bssid: string;
  band: WifiBand | null;
  channel: number | null;
  linkMbps: number | null;
  gatewayMs: number | null;
  gatewayLoss: number | null;
}

export interface Room {
  id: string;
  /** höchstens 40 Zeichen */
  name: string;
  /** höchstens 10, älteste fällt heraus */
  samples: RoomSample[];
}

/** kv `wifi.rooms` (höchstens 20 Räume) */
export interface RoomsStore {
  v: 1;
  rooms: Room[];
}

/** Bewertung eines Raums (Median-RSSI der letzten 3 Messungen) */
export type RoomRating = "veryGood" | "good" | "fair" | "weak";
