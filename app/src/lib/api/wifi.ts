/** WLAN-Scanner. Vertrag: docs/API.md, „WLAN-Scanner und Raum-Scan“. */
import { call } from "../api";
import type { WifiScan, WifiStateInfo } from "../types";

export const wifiApi = {
  /** Netze in der Nähe; `refresh = true` = aktiver Scan (nie während eines Spiels) */
  wifiScan: (refresh = false) => call<WifiScan>("net_wifi_scan", { refresh }),
  /** WLAN-Zustand: verbunden, nicht verbunden, kein WLAN-Dienst oder gesperrt */
  wifiState: () => call<WifiStateInfo>("net_wifi_state"),
};
