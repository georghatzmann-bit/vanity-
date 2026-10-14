/**
 * Demo-Backend: WLAN-Scanner und Raum-Scan (`net_wifi_scan`, `net_wifi_state`, kv `wifi.rooms`).
 * Vertrag: docs/API.md, „WLAN-Scanner und Raum-Scan“ › „Demo“. Alle Werte deterministisch.
 *
 * 14 feste Netze: 2,4 GHz fremd auf 1, 1, 3, 6, 6, 6, 11 plus das eigene Netz auf Kanal 6 (−60 dBm);
 * 5 GHz fremd auf 36 (80 MHz) und 100 (DFS), das eigene Netz auf 44 (verbunden), ein „Gast“-Netz mit
 * der BSSID-Familie des eigenen Routers und ein verstecktes Netz; 6 GHz auf 37.
 * Schalter: `__pulsarWifiPrimary` (verbunden mit dem 2,4-GHz-Zugangspunkt), `__pulsarWifiLocked`,
 * `__pulsarNoWifi` (siehe ./core.ts). Während „Hier messen“ setzt der Raum-Scan im Demo
 * `window.__pulsarDemoRoom` (Raumname) – die Messwerte hängen dann fest vom Namen ab.
 */
import type { RoomSample, RoomsStore, WifiInfo, WifiNetwork, WifiScan, WifiStateInfo } from "../types";
import { demoFlag, registerMockKvDefault, sleep, type MockHandlers } from "./core";

/** Wörtlich wie `backend.wifiLocked` (src-tauri/src/net/wifiscan.rs) */
const WIFI_LOCKED =
  "WLAN-Daten gesperrt: Windows gibt sie nur mit Standortzugriff frei. Bitte unter Einstellungen › Datenschutz und Sicherheit › Standort die Standortdienste und „Desktop-Apps den Zugriff auf Ihren Standort erlauben“ einschalten.";

const OWN_SSID = "FRITZ!Box 7590 XK";
/** Eigener Router: 5-GHz- und 2,4-GHz-Zugangspunkt (gleiche BSSID-Familie) */
export const OWN_BSSID_5 = "3c:a6:2f:5b:71:8e";
export const OWN_BSSID_24 = "3c:a6:2f:5b:71:8d";

type Net = Omit<WifiNetwork, "connected" | "ageS" | "centerKhz" | "signal">;
const khz = (band: WifiNetwork["band"], ch: number) => (band === "2.4" ? 2407 + 5 * ch : band === "5" ? 5000 + 5 * ch : 5950 + 5 * ch) * 1000;
const quality = (rssi: number) => Math.max(0, Math.min(100, 2 * (rssi + 100)));

const NETWORKS: Net[] = [
  // 2,4 GHz
  { ssid: "Vodafone-7A3C", bssid: "a4:91:b1:2c:7a:3c", rssi: -71, channel: 1, band: "2.4", widthMhz: 20, phy: "Wi-Fi 4 (802.11n)", secured: true },
  { ssid: "o2-WLAN42", bssid: "e0:28:6d:13:44:02", rssi: -83, channel: 1, band: "2.4", widthMhz: 20, phy: "Wi-Fi 4 (802.11n)", secured: true },
  { ssid: "DIRECT-7B-HP LaserJet", bssid: "fa:da:0c:41:7b:10", rssi: -78, channel: 3, band: "2.4", widthMhz: 20, phy: "Wi-Fi 4 (802.11n)", secured: true },
  { ssid: OWN_SSID, bssid: OWN_BSSID_24, rssi: -60, channel: 6, band: "2.4", widthMhz: 20, phy: "Wi-Fi 6 (802.11ax)", secured: true },
  { ssid: "MagentaWLAN-9F2K", bssid: "38:10:d5:9f:22:b0", rssi: -62, channel: 6, band: "2.4", widthMhz: 20, phy: "Wi-Fi 6 (802.11ax)", secured: true },
  { ssid: "WLAN-Familie-Schulz", bssid: "c8:0e:14:57:a1:19", rssi: -68, channel: 6, band: "2.4", widthMhz: 20, phy: "Wi-Fi 4 (802.11n)", secured: true },
  { ssid: "TP-Link_E4A0", bssid: "50:c7:bf:e4:a0:01", rssi: -74, channel: 6, band: "2.4", widthMhz: 20, phy: "Wi-Fi 5 (802.11ac)", secured: true },
  { ssid: "EasyBox-Gast", bssid: "62:10:d5:9f:22:b1", rssi: -80, channel: 11, band: "2.4", widthMhz: 20, phy: "Wi-Fi 4 (802.11n)", secured: false },
  // 5 GHz
  { ssid: OWN_SSID, bssid: OWN_BSSID_5, rssi: -51, channel: 44, band: "5", widthMhz: 80, phy: "Wi-Fi 6 (802.11ax)", secured: true },
  { ssid: "FRITZ!Box Gastzugang", bssid: "3e:a6:2f:5b:71:8f", rssi: -52, channel: 44, band: "5", widthMhz: 80, phy: "Wi-Fi 6 (802.11ax)", secured: true },
  { ssid: "Vodafone-7A3C", bssid: "a4:91:b1:2c:7a:3d", rssi: -74, channel: 36, band: "5", widthMhz: 80, phy: "Wi-Fi 5 (802.11ac)", secured: true },
  { ssid: "", bssid: "2a:7f:91:0c:55:e3", rssi: -86, channel: 52, band: "5", widthMhz: 20, phy: "Wi-Fi 5 (802.11ac)", secured: true },
  { ssid: "MagentaWLAN-9F2K", bssid: "38:10:d5:9f:22:b4", rssi: -81, channel: 100, band: "5", widthMhz: 80, phy: "Wi-Fi 6 (802.11ax)", secured: true },
  // 6 GHz
  { ssid: "Nachbar-6E", bssid: "74:83:c2:6e:00:37", rssi: -79, channel: 37, band: "6", widthMhz: 160, phy: "Wi-Fi 6 (802.11ax)", secured: true },
];

/** Wie Demo-`net_wifi` (lib/mock.ts): 5 GHz Kanal 44 bzw. mit `__pulsarWifiPrimary` 2,4 GHz Kanal 6 */
const WIFI_5: WifiInfo = { ssid: OWN_SSID, signal: 86, rssi: -51, band: "5", channel: 44, phy: "Wi-Fi 6 (802.11ax)", rxMbps: 1201, txMbps: 1201 };
const WIFI_24: WifiInfo = { ssid: OWN_SSID, signal: 80, rssi: -60, band: "2.4", channel: 6, phy: "Wi-Fi 6 (802.11ax)", rxMbps: 287, txMbps: 287 };

/** Kleiner, fester Hash (FNV-1a) für deterministische Abweichungen je Raumname */
function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619) >>> 0;
  return h;
}

/** Feste Werte der vorbelegten Räume (passend zu den gespeicherten Messungen) */
const ROOM_RSSI: Record<string, number> = { Schreibtisch: -52, Wohnzimmer: -63, Balkon: -78 };

let reads = 0;
/** WLAN-Verbindung der Demo; misst gerade der Raum-Scan (`__pulsarDemoRoom`), abhängig vom Raumnamen */
function demoWifiInfo(): WifiInfo {
  const base = demoFlag("__pulsarWifiPrimary") ? WIFI_24 : WIFI_5;
  const room = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>).__pulsarDemoRoom : undefined;
  if (typeof room !== "string" || !room) return { ...base };
  const jitter = [0, 1, -1, 2, -1][reads++ % 5];
  const target = ROOM_RSSI[room] ?? (base.rssi ?? -60) + 2 - (hash(room) % 30);
  const rssi = target + jitter;
  const rate = Math.max(6, Math.round((base.rxMbps ?? 0) * Math.min(1, Math.max(0.05, (rssi + 90) / 38))));
  return { ...base, rssi, signal: quality(rssi), rxMbps: rate, txMbps: rate };
}

function scanResult(refresh: boolean): WifiScan {
  const connectedBssid = demoFlag("__pulsarWifiPrimary") ? OWN_BSSID_24 : OWN_BSSID_5;
  const networks: WifiNetwork[] = NETWORKS.map((n, i) => ({
    ...n,
    signal: quality(n.rssi),
    centerKhz: khz(n.band, n.channel),
    connected: n.bssid === connectedBssid,
    ageS: refresh ? i % 3 : 12 + ((i * 7) % 30),
  })).sort((a, b) => b.rssi - a.rssi || a.bssid.localeCompare(b.bssid));
  return { at: Date.now(), fresh: refresh, interfaces: 1, networks };
}

const DAY = 86_400_000;
/** Vorbelegte Messung eines Raums */
function roomSample(rssi: number, t: number, i: number): RoomSample {
  const r = rssi + [0, -1, 1][i % 3];
  const rate = Math.round(1201 * Math.min(1, Math.max(0.05, (r + 90) / 38)));
  return { t, rssi: r, signal: quality(r), bssid: OWN_BSSID_5, band: "5", channel: 44, linkMbps: rate, gatewayMs: Math.round((1.8 + (-50 - r) * 0.12) * 10) / 10, gatewayLoss: 0 };
}

const t0 = Date.now() - 3 * DAY;
const DEMO_ROOMS: RoomsStore = {
  v: 1,
  rooms: Object.entries(ROOM_RSSI).map(([name, rssi], k) => ({
    id: `demo-room-${k + 1}`,
    name,
    samples: [0, 1, 2].map((i) => roomSample(rssi, t0 + i * DAY + k * 600_000, i)),
  })),
};
registerMockKvDefault("wifi.rooms", DEMO_ROOMS);

export const wifiMock: MockHandlers = {
  net_wifi_scan: async (a) => {
    const refresh = a.refresh === true;
    if (refresh) await sleep(1800);
    if (demoFlag("__pulsarWifiLocked")) throw new Error(WIFI_LOCKED);
    if (demoFlag("__pulsarNoWifi")) return { at: Date.now(), fresh: false, interfaces: 0, networks: [] } satisfies WifiScan;
    return scanResult(refresh);
  },
  net_wifi_state: () => {
    if (demoFlag("__pulsarWifiLocked")) return { state: "locked", wifi: null } satisfies WifiStateInfo;
    if (demoFlag("__pulsarNoWifi")) return { state: "noService", wifi: null } satisfies WifiStateInfo;
    return { state: "connected", wifi: demoWifiInfo() } satisfies WifiStateInfo;
  },
};
