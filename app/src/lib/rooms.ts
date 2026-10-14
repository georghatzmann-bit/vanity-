/**
 * Raum-Scan: WLAN-Signal je Raum vergleichen (rein, ohne Seiteneffekte). kv `wifi.rooms`.
 * Vertrag: docs/API.md, „WLAN-Scanner und Raum-Scan“ › „Raum-Scan“.
 *
 * Datenschutz: gespeichert wird höchstens die BSSID des **eigenen** Zugangspunkts – nie fremde Netze.
 * Ehrlich: Die Werte gelten für dieses Gerät; Konsole oder Handy haben andere Antennen.
 */
import type { PingStats, PingTarget, Room, RoomRating, RoomSample, RoomsStore, WifiBand, WifiInfo } from "./types";

export const ROOMS_KEY = "wifi.rooms";
export const MAX_ROOMS = 20;
export const MAX_SAMPLES = 10;
export const NAME_MAX = 40;
/** „Hier messen“: so viele WLAN-Abfragen im Abstand von 1 s */
export const MEASURE_READS = 5;
export const MEASURE_GAP_MS = 1000;
/** Router-Ping beim Messen (Anzahl Pakete) */
export const ROUTER_PINGS = 4;

export const emptyRooms = (): RoomsStore => ({ v: 1, rooms: [] });

/** Name säubern: Leerraum zusammenfassen, höchstens 40 Zeichen */
export function cleanName(name: string): string {
  return Array.from(name.replace(/\s+/g, " ").trim()).slice(0, NAME_MAX).join("");
}

const BANDS: readonly WifiBand[] = ["2.4", "5", "6"];
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function parseSample(x: unknown): RoomSample | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  const t = num(s.t);
  const rssi = num(s.rssi);
  if (t === null || rssi === null) return null;
  const band = BANDS.includes(s.band as WifiBand) ? (s.band as WifiBand) : null;
  return {
    t,
    rssi,
    signal: num(s.signal) ?? 0,
    bssid: typeof s.bssid === "string" ? s.bssid : "",
    band,
    channel: num(s.channel),
    linkMbps: num(s.linkMbps),
    gatewayMs: num(s.gatewayMs),
    gatewayLoss: num(s.gatewayLoss),
  };
}

/** kv-Wert tolerant lesen (fehlerhafte Einträge fallen weg, Grenzen 20/10 werden eingehalten) */
export function parseRooms(raw: unknown): RoomsStore {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { rooms?: unknown }).rooms)) return emptyRooms();
  const rooms: Room[] = [];
  for (const r of (raw as { rooms: unknown[] }).rooms) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") continue;
    const name = cleanName(o.name);
    if (!name || rooms.some((x) => x.id === o.id)) continue;
    const samples = (Array.isArray(o.samples) ? o.samples : []).map(parseSample).filter((s): s is RoomSample => s !== null);
    rooms.push({ id: o.id, name, samples: samples.slice(-MAX_SAMPLES) });
    if (rooms.length >= MAX_ROOMS) break;
  }
  return { v: 1, rooms };
}

/** Raum anlegen. `null`, wenn schon 20 Räume da sind oder der Name leer ist. */
export function addRoom(store: RoomsStore, name: string, id: string): RoomsStore | null {
  const clean = cleanName(name);
  if (!clean || store.rooms.length >= MAX_ROOMS) return null;
  return { v: 1, rooms: [...store.rooms, { id, name: clean, samples: [] }] };
}

export function renameRoom(store: RoomsStore, id: string, name: string): RoomsStore {
  const clean = cleanName(name);
  if (!clean) return store;
  return { v: 1, rooms: store.rooms.map((r) => (r.id === id ? { ...r, name: clean } : r)) };
}

export function deleteRoom(store: RoomsStore, id: string): RoomsStore {
  return { v: 1, rooms: store.rooms.filter((r) => r.id !== id) };
}

/** Messung anhängen (höchstens 10 je Raum, die älteste fällt heraus) */
export function addSample(store: RoomsStore, id: string, sample: RoomSample): RoomsStore {
  return { v: 1, rooms: store.rooms.map((r) => (r.id === id ? { ...r, samples: [...r.samples, sample].slice(-MAX_SAMPLES) } : r)) };
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Die letzten 3 Messungen eines Raums – im Band der letzten Messung (Bänder nicht vermischen) */
const recent = (room: Room) => {
  const band = room.samples[room.samples.length - 1]?.band ?? null;
  return room.samples.filter((s) => s.band === band).slice(-3);
};

/** Median-RSSI der letzten 3 Messungen (`null` = noch nicht gemessen) */
export const roomRssi = (room: Room): number | null => median(recent(room).map((s) => s.rssi));
/** Median der Verbindungsrate der letzten 3 Messungen */
export const roomLinkMbps = (room: Room): number | null => median(recent(room).flatMap((s) => (s.linkMbps === null ? [] : [s.linkMbps])));
/** Median des Router-Pings der letzten 3 Messungen */
export const roomGatewayMs = (room: Room): number | null => median(recent(room).flatMap((s) => (s.gatewayMs === null ? [] : [s.gatewayMs])));
/** Band der letzten Messung */
export const roomBand = (room: Room): WifiBand | null => room.samples[room.samples.length - 1]?.band ?? null;

/** Bewertung: ≥ −60 sehr gut, ≥ −67 gut, ≥ −75 mäßig, darunter schwach */
export function rateRssi(rssi: number): RoomRating {
  if (rssi >= -60) return "veryGood";
  if (rssi >= -67) return "good";
  if (rssi >= -75) return "fair";
  return "weak";
}

export interface RankedRoom {
  room: Room;
  rssi: number;
  rating: RoomRating;
  linkMbps: number | null;
  gatewayMs: number | null;
  /** Platz in der Rangliste seines Bands (1 = bester Platz) */
  rank: number;
}

export interface BandRanking {
  band: WifiBand | null;
  rooms: RankedRoom[];
}

/**
 * Rangliste je Band (nur gemessene Räume): höchster Median-RSSI zuerst, bei Gleichstand höhere
 * Verbindungsrate, dann kleinerer Router-Ping. Bänder in der Reihenfolge 5, 6, 2,4, unbekannt.
 */
export function rankRooms(rooms: Room[]): BandRanking[] {
  const groups = new Map<WifiBand | null, RankedRoom[]>();
  for (const room of rooms) {
    const rssi = roomRssi(room);
    if (rssi === null) continue;
    const band = roomBand(room);
    const list = groups.get(band) ?? [];
    list.push({ room, rssi, rating: rateRssi(rssi), linkMbps: roomLinkMbps(room), gatewayMs: roomGatewayMs(room), rank: 0 });
    groups.set(band, list);
  }
  const order: (WifiBand | null)[] = ["5", "6", "2.4", null];
  return order
    .filter((b) => groups.has(b))
    .map((band) => {
      const list = (groups.get(band) ?? []).sort(
        (a, b) => b.rssi - a.rssi || (b.linkMbps ?? -1) - (a.linkMbps ?? -1) || (a.gatewayMs ?? Infinity) - (b.gatewayMs ?? Infinity) || a.room.name.localeCompare(b.room.name),
      );
      list.forEach((r, i) => (r.rank = i + 1));
      return { band, rooms: list };
    });
}

/** Sind Räume in verschiedenen Bändern gemessen? → Hinweis „Datenrate vergleichen“ */
export const mixedBands = (rooms: Room[]): boolean => new Set(rooms.filter((r) => roomRssi(r) !== null).map(roomBand)).size > 1;

/** Router-Ziel für „Hier messen“ (ICMP zum Gateway) */
export function routerTarget(gateway: string): PingTarget {
  return { id: "gateway", label: "Router", host: gateway, method: "icmp" } satisfies PingTarget;
}

/**
 * Eine Messung aus den WLAN-Abfragen (Median von RSSI, Signal, Verbindungsrate) und dem Router-Ping.
 * `bssid` nur des eigenen Zugangspunkts. `null`, wenn keine Abfrage einen Wert hatte.
 */
export function sampleFrom(reads: WifiInfo[], bssid: string, router: PingStats | null, t: number): RoomSample | null {
  const rssi = median(reads.flatMap((w) => (w.rssi === null ? [] : [w.rssi])));
  if (rssi === null) return null;
  const last = reads[reads.length - 1];
  return {
    t,
    rssi: Math.round(rssi),
    signal: Math.round(median(reads.map((w) => w.signal)) ?? 0),
    bssid,
    band: last?.band ?? null,
    channel: last?.channel ?? null,
    linkMbps: median(reads.flatMap((w) => (w.rxMbps === null ? [] : [w.rxMbps]))),
    gatewayMs: router?.avg ?? null,
    gatewayLoss: router ? router.loss : null,
  };
}
