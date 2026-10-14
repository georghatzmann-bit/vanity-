/**
 * Zustand: WLAN-Scanner und Raum-Scan. Vertrag: docs/API.md, „WLAN-Scanner und Raum-Scan“.
 *
 * - Aktiver Scan (`refresh = true`) nur beim Öffnen des Tabs und per Knopf – nie, solange ein Spiel
 *   läuft (dann nur der Windows-Zwischenspeicher mit Hinweis). Alle 30 s `refresh = false` regelt
 *   `WifiPanel`, solange der Tab sichtbar ist.
 * - Die Netzliste bleibt nur im Speicher. Gespeichert (kv `wifi.rooms`) werden nur die Räume mit den
 *   eigenen Messungen (BSSID nur des eigenen Zugangspunkts).
 */
import { create } from "zustand";
import { api, errorText } from "@/lib/api";
import { addRoom, addSample, deleteRoom, emptyRooms, MEASURE_GAP_MS, MEASURE_READS, parseRooms, renameRoom, ROOMS_KEY, ROUTER_PINGS, routerTarget, sampleFrom } from "@/lib/rooms";
import type { AdapterInfo, PingStats, RoomsStore, WifiInfo, WifiScan, WifiStateInfo } from "@/lib/types";
import { connectedNetwork } from "@/lib/wifichan";
import { isTauri } from "@shared/lib/env";

/** Anfang des Sperr-Fehlers `backend.wifiLocked` (24H2-Standortsperre) */
const LOCKED_PREFIX = "WLAN-Daten gesperrt";
export const isLockedError = (msg: string | null | undefined) => !!msg && msg.startsWith(LOCKED_PREFIX);

/** Warum „Hier messen“ nicht ging */
export type MeasureError = "noConnection" | "locked" | "noValue" | "failed";

export interface WifiScanStoreState {
  scan: WifiScan | null;
  /** Zeitpunkt des letzten aktiven Scans (ms) */
  freshAt: number | null;
  wifiState: WifiStateInfo | null;
  /** Hauptverbindung (für den Hinweis „per Kabel“ und das Router-Ziel) */
  primary: AdapterInfo | null;
  /** aktiver Scan läuft */
  scanning: boolean;
  /** Liste wird gelesen (Zwischenspeicher) */
  loading: boolean;
  /** letzter Fehler des Scans (Backend-Text) */
  error: string | null;
  /** letzter Aktualisierungswunsch ohne aktiven Scan, weil ein Spiel läuft */
  gameRunning: boolean;
  rooms: RoomsStore;
  roomsLoaded: boolean;
  /** Raum, in dem gerade gemessen wird */
  measuring: string | null;
  /** Fortschritt 0–1 */
  measureProgress: number;
  measureError: MeasureError | null;

  /** Tab geöffnet: Zustand, Hauptverbindung, Räume und ein aktiver Scan (außer während eines Spiels) */
  open: () => Promise<void>;
  /** Liste neu lesen; `active` = aktiver Scan (wird während eines Spiels zum Zwischenspeicher) */
  refresh: (active: boolean) => Promise<void>;
  loadRooms: () => Promise<void>;
  addRoom: (name: string) => Promise<boolean>;
  renameRoom: (id: string, name: string) => Promise<void>;
  deleteRoom: (id: string) => Promise<void>;
  /** „Hier messen“: 5 × WLAN-Zustand im Abstand von 1 s und Router-Ping (≈ 6 s) */
  measure: (id: string) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

async function gameRunningNow(): Promise<boolean> {
  try {
    return (await api.runningGames()).length > 0;
  } catch {
    // Unbekannt → vorsichtig: kein aktiver Scan
    return true;
  }
}

/** Nur im Demo: Raumname für die deterministischen Demo-Messwerte (lib/mock/wifi.ts) */
function demoRoomHint(name: string | null) {
  if (isTauri() || typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__pulsarDemoRoom = name ?? undefined;
}

let seq = 0;

export const useWifiScan = create<WifiScanStoreState>((set, get) => ({
  scan: null,
  freshAt: null,
  wifiState: null,
  primary: null,
  scanning: false,
  loading: false,
  error: null,
  gameRunning: false,
  rooms: emptyRooms(),
  roomsLoaded: false,
  measuring: null,
  measureProgress: 0,
  measureError: null,

  open: async () => {
    void get().loadRooms();
    void api
      .adapters()
      .then((list) => set({ primary: list.find((a) => a.primary) ?? null }))
      .catch(() => set({ primary: null }));
    await get().refresh(true);
  },

  refresh: async (active) => {
    // Ein aktiver Scan läuft schon: ein weiterer Zwischenspeicher-Abruf würde nur alte Werte zeigen
    if (get().scanning) return;
    const game = active ? await gameRunningNow() : false;
    const doActive = active && !game;
    const my = ++seq;
    set({ scanning: doActive, loading: true, gameRunning: active ? game : get().gameRunning });
    const [stateRes, scanRes] = await Promise.allSettled([api.wifiState(), api.wifiScan(doActive)]);
    if (my !== seq) return;
    const wifiState = stateRes.status === "fulfilled" ? stateRes.value : get().wifiState;
    if (scanRes.status === "fulfilled") {
      const freshAt = scanRes.value.fresh ? scanRes.value.at : get().freshAt;
      set({ scan: scanRes.value, freshAt, error: null, wifiState, scanning: false, loading: false });
    } else {
      set({ error: errorText(scanRes.reason), wifiState, scanning: false, loading: false });
    }
  },

  loadRooms: async () => {
    try {
      set({ rooms: parseRooms(await api.kvGet<unknown>(ROOMS_KEY)), roomsLoaded: true });
    } catch {
      set({ rooms: emptyRooms(), roomsLoaded: true });
    }
  },

  addRoom: async (name) => {
    const next = addRoom(get().rooms, name, newId());
    if (!next) return false;
    set({ rooms: next });
    await api.kvSet(ROOMS_KEY, next);
    return true;
  },

  renameRoom: async (id, name) => {
    const next = renameRoom(get().rooms, id, name);
    set({ rooms: next });
    await api.kvSet(ROOMS_KEY, next);
  },

  deleteRoom: async (id) => {
    const next = deleteRoom(get().rooms, id);
    set({ rooms: next });
    await api.kvSet(ROOMS_KEY, next);
  },

  measure: async (id) => {
    const room = get().rooms.rooms.find((r) => r.id === id);
    if (!room || get().measuring) return;
    set({ measuring: id, measureProgress: 0, measureError: null });
    demoRoomHint(room.name);
    const fail = (measureError: MeasureError) => set({ measuring: null, measureProgress: 0, measureError });
    try {
      const reads: WifiInfo[] = [];
      for (let i = 0; i < MEASURE_READS; i++) {
        const st = await api.wifiState();
        if (st.state === "locked") return fail("locked");
        if (st.state !== "connected" || !st.wifi) return fail("noConnection");
        reads.push(st.wifi);
        set({ wifiState: st, measureProgress: (i + 1) / (MEASURE_READS + 1) });
        if (i < MEASURE_READS - 1) await sleep(MEASURE_GAP_MS);
      }
      // BSSID nur des eigenen (verbundenen) Zugangspunkts – aus dem Windows-Zwischenspeicher
      let bssid = "";
      try {
        bssid = connectedNetwork((await api.wifiScan(false)).networks)?.bssid ?? "";
      } catch {
        bssid = "";
      }
      // Router-Ping nur, wenn das WLAN die Hauptverbindung ist (sonst liefe er über das Kabel)
      let router: PingStats | null = null;
      const primary = await api
        .adapters()
        .then((list) => list.find((a) => a.primary) ?? null)
        .catch(() => get().primary);
      set({ primary });
      const gateway = primary?.kind === "wifi" ? primary.gateway : null;
      if (gateway && /^\d{1,3}(\.\d{1,3}){3}$/.test(gateway)) {
        try {
          router = await api.pingOnce(routerTarget(gateway), ROUTER_PINGS);
        } catch {
          router = null;
        }
      }
      const sample = sampleFrom(reads, bssid, router, Date.now());
      if (!sample) return fail("noValue");
      const next = addSample(get().rooms, id, sample);
      set({ rooms: next, measuring: null, measureProgress: 1 });
      await api.kvSet(ROOMS_KEY, next);
    } catch {
      fail("failed");
    } finally {
      demoRoomHint(null);
    }
  },
}));
