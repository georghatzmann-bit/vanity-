import { create } from "zustand";

/** Zustand: WLAN-Scanner und Raum-Scan – Umsetzung: F5. Gerüst: noch leer, damit `App.tsx` den Store schon kennt. */
export interface WifiScanStoreState {}

export const useWifiScan = create<WifiScanStoreState>(() => ({}));
