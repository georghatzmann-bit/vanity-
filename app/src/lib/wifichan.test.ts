import { describe, expect, it } from "vitest";
import { de } from "../locales/de";
import { en } from "../locales/en";
import { CHANNEL_NOTES, type WifiNetwork } from "./types";
import { channelAdvice, channelBars, connectedNetwork, improvementOf, load24, occupied, ownership, PSC_6, rssiWeight, sameRadio, type OwnNetwork } from "./wifichan";
import { wifiMock } from "./mock/wifi";

let n = 0;
/** Testnetz; BSSID fortlaufend, damit fremde Netze nie zufällig zur eigenen Familie gehören */
function net(band: WifiNetwork["band"], channel: number, rssi: number, extra: Partial<WifiNetwork> = {}): WifiNetwork {
  n++;
  return {
    ssid: `Nachbar-${n}`,
    bssid: `02:00:00:00:${(n >> 8).toString(16).padStart(2, "0")}:${(n & 255).toString(16).padStart(2, "0")}`,
    rssi,
    signal: 50,
    channel,
    band,
    centerKhz: 0,
    widthMhz: 20,
    phy: "Wi-Fi 6 (802.11ax)",
    secured: true,
    connected: false,
    ageS: 1,
    ...extra,
  };
}
const own = (band: WifiNetwork["band"], channel: number, extra: Partial<OwnNetwork> = {}): OwnNetwork => ({ ssid: "Mein-Netz", bssid: "3c:a6:2f:5b:71:8e", channel, band, widthMhz: band === "2.4" ? 20 : 80, ...extra });
const opts = { wiredPrimary: false, fresh: true };

describe("Gewichte und Hilfen", () => {
  it("Gewichte an den Grenzen", () => {
    expect(rssiWeight(-60)).toBe(1);
    expect(rssiWeight(-40)).toBe(1);
    expect(rssiWeight(-77.5)).toBeCloseTo(0.5, 6);
    expect(rssiWeight(-95)).toBe(0.05);
    expect(rssiWeight(-110)).toBe(0.05);
  });
  it("Überlappung 2,4 GHz: Abstand 5 überlappt nicht, 40 MHz zieht 2 ab", () => {
    expect(load24([net("2.4", 6, -60)], 1)).toBe(0);
    expect(load24([net("2.4", 6, -60)], 3)).toBeCloseTo(0.4, 6);
    expect(load24([net("2.4", 6, -60, { widthMhz: 40 })], 1)).toBeCloseTo(0.4, 6);
    expect(load24([net("2.4", 6, -60, { widthMhz: 40 })], 11)).toBeCloseTo(0.4, 6);
  });
  it("belegter Bereich breiter Kanäle im festen Raster", () => {
    expect(occupied("5", 44, 80)).toEqual([36, 48]);
    expect(occupied("5", 36, 160)).toEqual([36, 64]);
    expect(occupied("5", 104, 40)).toEqual([100, 104]);
    expect(occupied("5", 149, 80)).toEqual([149, 161]);
    expect(occupied("6", 37, 160)).toEqual([33, 61]);
    expect(occupied("5", 52, null)).toEqual([52, 52]);
  });
  it("sameRadio: Oktette 2–5 gleich, 1. und 6. nur untere 4 Bit verschieden", () => {
    expect(sameRadio("3c:a6:2f:5b:71:8e", "3e:a6:2f:5b:71:8f")).toBe(true);
    expect(sameRadio("3c:a6:2f:5b:71:8e", "3c:a6:2f:5b:71:8e")).toBe(true);
    expect(sameRadio("3c:a6:2f:5b:71:8e", "4c:a6:2f:5b:71:8e")).toBe(false);
    expect(sameRadio("3c:a6:2f:5b:71:8e", "3c:a6:2f:5b:72:8e")).toBe(false);
    expect(sameRadio("3c:a6:2f:5b:71:8e", "3c:a6:2f:5b:71:9e")).toBe(false);
    expect(sameRadio("kaputt", "3c:a6:2f:5b:71:8e")).toBe(false);
  });
  it("improvement-Grenzen", () => {
    expect(improvementOf(2, 1)).toBe("clear");
    expect(improvementOf(2.2, 1.2)).toBe("small"); // Abstand 1,0, aber mehr als die Hälfte
    expect(improvementOf(1.8, 0.8)).toBe("clear");
    expect(improvementOf(1.0, 0.7)).toBe("small");
    expect(improvementOf(1.0, 0.71)).toBe("none");
    expect(improvementOf(null, 0)).toBe("none");
  });
});

describe("channelAdvice 2,4 GHz", () => {
  it("empfiehlt nur 1, 6 oder 11 und immer mit Hinweis nonWifiInterference", () => {
    const nets = [net("2.4", 1, -55), net("2.4", 2, -60), net("2.4", 6, -58), net("2.4", 11, -90), net("2.4", 13, -62)];
    const [a] = channelAdvice(nets, own("2.4", 1), opts);
    expect([1, 6, 11]).toContain(a.recommended);
    expect(a.recommended).toBe(11);
    expect(a.notes).toContain("nonWifiInterference");
    expect(a.widthMhz).toBe(20);
    expect(a.dfs).toBe(false);
  });
  it("Kanal 3 überlappt 1 und 6 → Hinweis overlap", () => {
    const [a] = channelAdvice([net("2.4", 1, -80)], own("2.4", 3), opts);
    expect(a.notes).toContain("overlap");
    expect(a.current).toBe(3);
    expect([1, 6, 11]).toContain(a.recommended);
  });
  it("eigene SSID zählt nicht als Last, fremde BSSID schon", () => {
    const mine = net("2.4", 6, -40, { ssid: "Mein-Netz", bssid: "aa:aa:aa:aa:aa:aa" });
    const [a] = channelAdvice([mine], own("2.4", 6), opts);
    expect(a.loadCurrent).toBe(0);
    expect(a.improvement).toBe("none");
    const [b] = channelAdvice([mine, net("2.4", 6, -60)], own("2.4", 6), opts);
    expect(b.loadCurrent).toBe(1);
  });
  it("Gast-/Hotspot-SSID derselben BSSID-Familie zählt nicht (ownExtraSsids), auch versteckt", () => {
    const guest = net("2.4", 6, -45, { ssid: "Telekom_FON", bssid: "3e:a6:2f:5b:71:8f" });
    const hidden = net("2.4", 6, -45, { ssid: "", bssid: "3d:a6:2f:5b:71:8c" });
    const [a] = channelAdvice([guest, hidden], own("2.4", 6), opts);
    expect(a.loadCurrent).toBe(0);
    expect(a.notes).toContain("ownExtraSsids");
    expect(ownership(guest, own("2.4", 6))).toBe("ownExtra");
    // Gleiche Familie, aber anderer Kanal → fremd (im Zweifel fremd)
    const other = net("2.4", 1, -45, { ssid: "Telekom_FON", bssid: "3e:a6:2f:5b:71:8f" });
    expect(ownership(other, own("2.4", 6))).toBe("foreign");
  });
  it("Gleichstand → aktueller Kanal, sonst der kleinere", () => {
    const [a] = channelAdvice([], own("2.4", 6), opts);
    expect(a.recommended).toBe(6);
    expect(a.improvement).toBe("none");
    const [b] = channelAdvice([], own("2.4", 3), opts);
    expect(b.recommended).toBe(1);
  });
  it("deutlich besser → clear; kein lohnender Wechsel → beim aktuellen Kanal bleiben", () => {
    const busy = [net("2.4", 6, -55), net("2.4", 6, -60), net("2.4", 11, -80)];
    const [a] = channelAdvice(busy, own("2.4", 6), opts);
    expect(a.recommended).toBe(1);
    expect(a.improvement).toBe("clear");
    expect(a.loadCurrent).toBe(2);
    const [b] = channelAdvice([net("2.4", 6, -85), net("2.4", 1, -95)], own("2.4", 6), opts);
    expect(b.recommended).toBe(6);
    expect(b.improvement).toBe("none");
  });
  it("2,4 GHz überall voll → band24Crowded", () => {
    const nets = [1, 6, 11].flatMap((c) => [net("2.4", c, -50), net("2.4", c, -55)]);
    const [a] = channelAdvice(nets, own("2.4", 6), opts);
    expect(a.notes).toContain("band24Crowded");
  });
});

describe("channelAdvice 5 GHz", () => {
  it("bevorzugt 36–48, wenn höchstens 0,5 schlechter (kein DFS)", () => {
    const nets = [net("5", 36, -77.5, { widthMhz: 20 }), net("5", 52, -95)];
    const [a] = channelAdvice(nets, own("5", 149), opts);
    expect(a.recommended).toBe(36);
    expect(a.dfs).toBe(false);
    expect(a.notes).not.toContain("dfs");
    expect(a.widthMhz).toBe(80);
  });
  it("sonst DFS-Block mit Hinweis dfs", () => {
    const nets = [net("5", 36, -50, { widthMhz: 80 }), net("5", 44, -55)];
    const [a] = channelAdvice(nets, own("5", 157), opts);
    expect(a.recommended).toBe(52);
    expect(a.dfs).toBe(true);
    expect(a.notes).toContain("dfs");
    expect(a.notes).not.toContain("dfsWeather");
  });
  it("116–128 nur, wenn um mindestens 1,0 besser als jeder andere Block → dfsWeather", () => {
    const full = (ch: number) => [net("5", ch, -50, { widthMhz: 80 })];
    const nets = [...full(36), ...full(52), ...full(100)];
    const [a] = channelAdvice(nets, own("5", 165), opts);
    expect(a.recommended).toBe(116);
    expect(a.notes).toEqual(expect.arrayContaining(["dfs", "dfsWeather"]));
    // Nur 0,9 besser → nicht 116
    const almost = [net("5", 36, -63.5), net("5", 52, -63.5), net("5", 100, -63.5)];
    const [b] = channelAdvice(almost, own("5", 165), opts);
    expect(b.recommended).not.toBe(116);
  });
  it("keine Empfehlung ab Kanal 149", () => {
    const nets = [36, 52, 100, 116].map((c) => net("5", c, -50, { widthMhz: 80 }));
    const [a] = channelAdvice(nets, own("5", 44), opts);
    expect(a.recommended).toBeLessThan(149);
    expect(a.alternatives.every((c) => c < 149)).toBe(true);
  });
  it("eigener Block gut → none, Empfehlung = aktueller Kanal", () => {
    const [a] = channelAdvice([net("5", 100, -60, { widthMhz: 80 })], own("5", 44), opts);
    expect(a.improvement).toBe("none");
    expect(a.recommended).toBe(36);
    expect(a.current).toBe(44);
  });
});

describe("channelAdvice 6 GHz und Hinweise", () => {
  it("nur PSC-Kanäle 5–85", () => {
    const nets = PSC_6.map((c) => net("6", c, -55));
    nets.push(net("6", 101, -95));
    const [a] = channelAdvice(nets.slice(1), own("6", 37), opts);
    expect(PSC_6 as readonly number[]).toContain(a.recommended);
    expect(a.recommended).toBe(5);
    for (const alt of a.alternatives) expect(PSC_6 as readonly number[]).toContain(alt);
  });
  it("wiredPrimary, cacheOnly und noConnection", () => {
    const nets = [net("2.4", 6, -60), net("5", 36, -60)];
    const res = channelAdvice(nets, null, { wiredPrimary: true, fresh: false });
    expect(res.map((r) => r.band)).toEqual(["2.4", "5"]);
    for (const r of res) {
      expect(r.current).toBeNull();
      expect(r.loadCurrent).toBeNull();
      expect(r.improvement).toBe("none");
      expect(r.notes).toEqual(expect.arrayContaining(["noConnection", "wiredPrimary", "cacheOnly"]));
    }
    expect(res[0].notes).toContain("nonWifiInterference");
  });
  it("jede Note hat Texte in de und en", () => {
    for (const note of CHANNEL_NOTES) {
      expect(de.wifiScan.note[note], note).toBeTruthy();
      expect(en.wifiScan.note[note], note).toBeTruthy();
    }
    for (const imp of ["none", "small", "clear"] as const) {
      expect(de.wifiScan.advice[imp]).toBeTruthy();
      expect(en.wifiScan.advice[imp]).toBeTruthy();
    }
  });
  it("Balken markieren eigenes Netz und Empfehlung", () => {
    const nets = [net("2.4", 6, -60), net("2.4", 6, -62)];
    const o = own("2.4", 6);
    const [a] = channelAdvice(nets, o, opts);
    const bars = channelBars(nets, "2.4", o, a);
    expect(bars).toHaveLength(13);
    expect(bars.find((b) => b.channel === 6)?.own).toBe(true);
    expect(bars.find((b) => b.channel === a.recommended)?.recommended).toBe(true);
    expect(bars.find((b) => b.channel === 6)?.count).toBe(2);
  });
});

describe("Demo-Daten (lib/mock/wifi.ts)", () => {
  const scan = async () => (await wifiMock.net_wifi_scan({ refresh: false })) as { networks: WifiNetwork[]; interfaces: number };
  it("14 Netze, eigenes Netz auf 5 GHz Kanal 44 verbunden, Kanal 44 schon gut gewählt", async () => {
    const s = await scan();
    expect(s.networks).toHaveLength(14);
    const c = connectedNetwork(s.networks);
    expect(c?.channel).toBe(44);
    expect(c?.band).toBe("5");
    const [a] = channelAdvice(s.networks, c, opts);
    expect(a.improvement).toBe("none");
    expect(a.notes).toContain("ownExtraSsids");
    expect(s.networks.filter((x) => x.band === "2.4").map((x) => x.channel).sort((x, y) => x - y)).toEqual([1, 1, 3, 6, 6, 6, 6, 11]);
  });
  it("__pulsarWifiPrimary: 2,4 GHz Kanal 6 belegt → deutliche Empfehlung", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = { __pulsarWifiPrimary: true };
    try {
      const s = await scan();
      const c = connectedNetwork(s.networks);
      expect(c?.band).toBe("2.4");
      expect(c?.rssi).toBe(-60);
      const [a] = channelAdvice(s.networks, c, opts);
      expect(a.current).toBe(6);
      expect(a.recommended).toBe(11);
      expect(a.improvement).toBe("clear");
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });
});
