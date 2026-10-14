import { describe, expect, it } from "vitest";
import { de } from "../locales/de";
import { en } from "../locales/en";
import type { PingTarget, Room, RoomSample, WifiInfo } from "./types";
import {
  addRoom,
  addSample,
  cleanName,
  deleteRoom,
  emptyRooms,
  MAX_ROOMS,
  MAX_SAMPLES,
  median,
  mixedBands,
  parseRooms,
  rankRooms,
  rateRssi,
  renameRoom,
  roomRssi,
  routerTarget,
  sampleFrom,
} from "./rooms";

const sample = (rssi: number, extra: Partial<RoomSample> = {}): RoomSample => ({ t: 1, rssi, signal: 80, bssid: "3c:a6:2f:5b:71:8e", band: "5", channel: 44, linkMbps: 866, gatewayMs: 2, gatewayLoss: 0, ...extra });
const room = (id: string, samples: RoomSample[]): Room => ({ id, name: id, samples });

describe("Bewertung", () => {
  it("Grenzen −60/−67/−75", () => {
    expect(rateRssi(-60)).toBe("veryGood");
    expect(rateRssi(-61)).toBe("good");
    expect(rateRssi(-67)).toBe("good");
    expect(rateRssi(-68)).toBe("fair");
    expect(rateRssi(-75)).toBe("fair");
    expect(rateRssi(-76)).toBe("weak");
  });
  it("Median der letzten 3 Messungen", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1])).toBe(2.5);
    expect(roomRssi(room("a", [sample(-90), sample(-50), sample(-60), sample(-70)]))).toBe(-60);
    expect(roomRssi(room("a", []))).toBeNull();
    // Nur Messungen im Band der letzten Messung zählen
    expect(roomRssi(room("b", [sample(-50), sample(-52), sample(-70, { band: "2.4" })]))).toBe(-70);
  });
  it("jede Bewertung hat Texte in de und en", () => {
    for (const r of ["veryGood", "good", "fair", "weak"] as const) {
      expect(de.wifiScan.rooms.rating[r]).toBeTruthy();
      expect(en.wifiScan.rooms.rating[r]).toBeTruthy();
    }
    for (const e of ["noConnection", "locked", "noValue", "failed"] as const) {
      expect(de.wifiScan.rooms.err[e]).toBeTruthy();
      expect(en.wifiScan.rooms.err[e]).toBeTruthy();
    }
  });
});

describe("Rangliste", () => {
  it("je Band, bester Platz = höchster Median-RSSI", () => {
    const rooms = [room("Balkon", [sample(-78)]), room("Schreibtisch", [sample(-52)]), room("Wohnzimmer", [sample(-63)]), room("Küche", [sample(-58, { band: "2.4" })]), room("Leer", [])];
    const r = rankRooms(rooms);
    expect(r.map((g) => g.band)).toEqual(["5", "2.4"]);
    expect(r[0].rooms.map((x) => x.room.id)).toEqual(["Schreibtisch", "Wohnzimmer", "Balkon"]);
    expect(r[0].rooms.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r[0].rooms[2].rating).toBe("weak");
    expect(r[1].rooms[0].room.id).toBe("Küche");
  });
  it("Gleichstand über linkMbps, dann kleinerer Router-Ping", () => {
    const a = room("A", [sample(-60, { linkMbps: 400 })]);
    const b = room("B", [sample(-60, { linkMbps: 866 })]);
    expect(rankRooms([a, b])[0].rooms[0].room.id).toBe("B");
    const c = room("C", [sample(-60, { gatewayMs: 9 })]);
    const d = room("D", [sample(-60, { gatewayMs: 3 })]);
    expect(rankRooms([c, d])[0].rooms[0].room.id).toBe("D");
  });
  it("gemischte Bänder erkennen", () => {
    expect(mixedBands([room("a", [sample(-60)]), room("b", [sample(-60)])])).toBe(false);
    expect(mixedBands([room("a", [sample(-60)]), room("b", [sample(-60, { band: "2.4" })])])).toBe(true);
    expect(mixedBands([room("a", [sample(-60)]), room("b", [])])).toBe(false);
  });
});

describe("Räume verwalten", () => {
  it("Grenzen 20 Räume und 10 Messungen", () => {
    let s = emptyRooms();
    for (let i = 0; i < MAX_ROOMS; i++) s = addRoom(s, `Raum ${i}`, `id${i}`)!;
    expect(s.rooms).toHaveLength(20);
    expect(addRoom(s, "zu viel", "x")).toBeNull();
    for (let i = 0; i < 12; i++) s = addSample(s, "id0", sample(-50 - i, { t: i }));
    expect(s.rooms[0].samples).toHaveLength(MAX_SAMPLES);
    expect(s.rooms[0].samples[0].t).toBe(2);
  });
  it("Namen kürzen und säubern", () => {
    expect(cleanName("  Wohn   zimmer ")).toBe("Wohn zimmer");
    expect(cleanName("x".repeat(60))).toHaveLength(40);
    expect(addRoom(emptyRooms(), "   ", "a")).toBeNull();
    const s = addRoom(emptyRooms(), "Büro", "a")!;
    expect(renameRoom(s, "a", "y".repeat(50)).rooms[0].name).toHaveLength(40);
    expect(renameRoom(s, "a", "  ").rooms[0].name).toBe("Büro");
    expect(deleteRoom(s, "a").rooms).toHaveLength(0);
  });
  it("kv-Wert tolerant lesen", () => {
    expect(parseRooms(null)).toEqual(emptyRooms());
    expect(parseRooms({ v: 1, rooms: "kaputt" })).toEqual(emptyRooms());
    const raw = {
      v: 1,
      rooms: [
        { id: "a", name: "  Flur ", samples: [{ t: 1, rssi: -60, band: "5" }, { t: "x" }, ...Array.from({ length: 12 }, (_, i) => ({ t: i, rssi: -70 }))] },
        { id: "a", name: "doppelt", samples: [] },
        { name: "ohne id" },
        ...Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, name: `R${i}`, samples: [] })),
      ],
    };
    const s = parseRooms(raw);
    expect(s.rooms).toHaveLength(20);
    expect(s.rooms[0].name).toBe("Flur");
    expect(s.rooms[0].samples).toHaveLength(10);
    expect(s.rooms[0].samples[0].band).toBeNull();
    expect(s.rooms[0].samples[0].linkMbps).toBeNull();
  });
});

describe("Messen", () => {
  it("Router-Ziel ist ein gültiges PingTarget mit label", () => {
    const target = routerTarget("192.168.178.1") satisfies PingTarget;
    expect(target).toEqual({ id: "gateway", label: "Router", host: "192.168.178.1", method: "icmp" });
  });
  it("Median aus 5 Abfragen, BSSID nur des eigenen Zugangspunkts", () => {
    const w = (rssi: number | null, rx: number | null): WifiInfo => ({ ssid: "Mein-Netz", signal: 70, rssi, band: "5", channel: 44, phy: "Wi-Fi 6", rxMbps: rx, txMbps: rx });
    const s = sampleFrom([w(-60, 800), w(-62, 866), w(-58, 866), w(null, null), w(-61, 720)], "3c:a6:2f:5b:71:8e", { targetId: "gateway", last: 2, avg: 2.4, min: 2, max: 3, jitter: 0.2, loss: 0, samples: 4 }, 5);
    expect(s).toMatchObject({ t: 5, rssi: -60, signal: 70, bssid: "3c:a6:2f:5b:71:8e", band: "5", channel: 44, linkMbps: 833, gatewayMs: 2.4, gatewayLoss: 0 });
    expect(sampleFrom([w(null, null)], "", null, 1)).toBeNull();
    expect(sampleFrom([w(-70, 100)], "", null, 1)).toMatchObject({ gatewayMs: null, gatewayLoss: null });
  });
});
