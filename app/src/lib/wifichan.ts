/**
 * Kanal-Belegung und Kanal-Empfehlung für den eigenen Router (rein, ohne Seiteneffekte).
 * Vertrag: docs/API.md, „WLAN-Scanner und Raum-Scan“ › „Kanal-Empfehlung“.
 *
 * Ehrlich: Pulsar stellt keinen Kanal um und sieht nur WLAN-Netze – Störungen außerhalb des WLANs
 * (Mikrowelle, Bluetooth, Funk-Kameras) nicht. Die Bewertung ist eine Momentaufnahme an diesem Ort.
 */
import type { ChannelAdvice, ChannelNote, WifiBand, WifiNetwork } from "./types";

/** Das verbundene Netz (aus dem Scan oder aus `net_wifi_state`; `bssid` = "" wenn unbekannt) */
export type OwnNetwork = Pick<WifiNetwork, "ssid" | "bssid" | "channel" | "band" | "widthMhz">;

export interface AdviceOptions {
  /** Hauptverbindung per Kabel */
  wiredPrimary: boolean;
  /** Liste nach aktivem Scan (`false` = nur Windows-Zwischenspeicher → Hinweis `cacheOnly`) */
  fresh?: boolean;
}

/** Empfohlene Kanäle 2,4 GHz (überlappungsfrei) */
export const CHANNELS_24 = [1, 6, 11] as const;
/** Bewertete 80-MHz-Blöcke 5 GHz: [erster, letzter Kanal] */
export const BLOCKS_5: readonly (readonly [number, number])[] = [
  [36, 48],
  [52, 64],
  [100, 112],
  [116, 128],
];
/** 6 GHz: PSC-Kanäle im in der EU freigegebenen unteren Teil */
export const PSC_6 = [5, 21, 37, 53, 69, 85] as const;

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Gewicht eines Netzes nach Stärke: −60 dBm → 1, −77,5 → 0,5, −95 → 0,05 */
export const rssiWeight = (rssi: number) => clamp((rssi + 95) / 35, 0.05, 1);

function octets(bssid: string): number[] | null {
  const parts = bssid.split(/[:-]/);
  if (parts.length !== 6) return null;
  const out = parts.map((p) => parseInt(p, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? out : null;
}

/**
 * Gleicher Funkteil (virtuelle Zugangspunkte eines Routers): Oktette 2–5 gleich, im 1. und 6.
 * Oktett nur die unteren 4 Bit verschieden. Heuristik – im Zweifel `false` (zählt als fremd).
 */
export function sameRadio(a: string, b: string): boolean {
  const x = octets(a);
  const y = octets(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 4; i++) if (x[i] !== y[i]) return false;
  return ((x[0] ^ y[0]) & 0xf0) === 0 && ((x[5] ^ y[5]) & 0xf0) === 0;
}

/** Wie ordnet sich ein Netz zum eigenen ein? */
export function ownership(n: WifiNetwork, own: OwnNetwork | null): "own" | "ownExtra" | "foreign" {
  if (!own) return "foreign";
  if (own.bssid && n.bssid.toLowerCase() === own.bssid.toLowerCase()) return "own";
  if (own.ssid !== "" && n.ssid === own.ssid) return "own";
  if (own.bssid && n.band === own.band && n.channel === own.channel && sameRadio(n.bssid, own.bssid)) return "ownExtra";
  return "foreign";
}

/** Fremde Netze (zählen als Last) und erkannte Zusatz-Netze des eigenen Routers */
export function splitNetworks(networks: WifiNetwork[], own: OwnNetwork | null) {
  const foreign: WifiNetwork[] = [];
  let ownExtra = 0;
  for (const n of networks) {
    const o = ownership(n, own);
    if (o === "foreign") foreign.push(n);
    else if (o === "ownExtra" && n.ssid !== own?.ssid) ownExtra++;
  }
  return { foreign, ownExtra };
}

/** Last auf einem 2,4-GHz-Kanal: Σ w × max(0, 1 − d/5); bei 40 MHz d − 2 (nicht unter 0) */
export function load24(networks: WifiNetwork[], k: number): number {
  let sum = 0;
  for (const n of networks) {
    if (n.band !== "2.4") continue;
    let d = Math.abs(k - n.channel);
    if (n.widthMhz === 40) d = Math.max(0, d - 2);
    sum += rssiWeight(n.rssi) * Math.max(0, 1 - d / 5);
  }
  return sum;
}

/**
 * Belegter Bereich eines 5-/6-GHz-Netzes in 20-MHz-Kanalnummern [erster, letzter]. Windows meldet
 * die Mitte des Hauptkanals; breite Kanäle liegen im festen Raster (5 GHz ab 36/100/149, 6 GHz ab 1).
 */
export function occupied(band: WifiBand, channel: number, widthMhz: number | null): [number, number] {
  const n = Math.max(1, Math.round((widthMhz ?? 20) / 20));
  if (n === 1 || band === "2.4") return [channel, channel];
  const base = band === "6" ? 1 : channel >= 149 ? 149 : channel >= 100 ? 100 : 36;
  if (channel < base) return [channel, channel];
  const slot = Math.floor((channel - base) / 4);
  const start = base + Math.floor(slot / n) * n * 4;
  return [start, start + (n - 1) * 4];
}

const touches = (a: [number, number], b: readonly [number, number]) => a[0] <= b[1] && b[0] <= a[1];

/** Last eines Bereichs (5/6 GHz): Σ w aller Netze, deren belegter Bereich ihn berührt */
export function loadRange(networks: WifiNetwork[], band: WifiBand, range: readonly [number, number]): number {
  let sum = 0;
  for (const n of networks) if (n.band === band && touches(occupied(band, n.channel, n.widthMhz), range)) sum += rssiWeight(n.rssi);
  return sum;
}

/** Bewertung der Verbesserung (aktuell → empfohlen) */
export function improvementOf(loadCurrent: number | null, loadRecommended: number): ChannelAdvice["improvement"] {
  if (loadCurrent === null) return "none";
  const diff = loadCurrent - loadRecommended;
  if (diff >= 1.0 && loadRecommended <= loadCurrent / 2) return "clear";
  if (diff >= 0.3) return "small";
  return "none";
}

/** Bester Kandidat; Gleichstand → aktueller, sonst der kleinere */
function pick(cands: { key: number; load: number }[], current: number | null) {
  const eps = 1e-9;
  const min = Math.min(...cands.map((c) => c.load));
  const best = cands.filter((c) => c.load <= min + eps);
  return best.find((c) => c.key === current) ?? best.reduce((a, b) => (b.key < a.key ? b : a));
}

function alternativesOf(cands: { key: number; load: number }[], rec: number, recLoad: number) {
  return cands
    .filter((c) => c.key !== rec && c.load <= recLoad + 0.5)
    .sort((a, b) => a.load - b.load || a.key - b.key)
    .map((c) => c.key);
}

function advice24(foreign: WifiNetwork[], own: OwnNetwork | null, notes: ChannelNote[]): ChannelAdvice {
  const current = own?.band === "2.4" ? own.channel : null;
  const cands = CHANNELS_24.map((k) => ({ key: k as number, load: load24(foreign, k) }));
  const loadCurrent = current !== null ? load24(foreign, current) : null;
  let best = pick(cands, current);
  // Kein lohnender Wechsel → beim aktuellen Kanal bleiben (nur 1/6/11)
  const curCand = cands.find((c) => c.key === current);
  if (curCand && improvementOf(loadCurrent, best.load) === "none") best = curCand;
  const out = notes.slice();
  if (current !== null && !(CHANNELS_24 as readonly number[]).includes(current)) out.push("overlap");
  if (Math.min(...cands.map((c) => c.load)) >= 2) out.push("band24Crowded");
  out.push("nonWifiInterference");
  return {
    band: "2.4",
    current,
    recommended: best.key,
    widthMhz: 20,
    dfs: false,
    loadCurrent: loadCurrent === null ? null : round2(loadCurrent),
    loadRecommended: round2(best.load),
    alternatives: alternativesOf(cands, best.key, best.load),
    improvement: best.key === current ? "none" : improvementOf(loadCurrent, best.load),
    notes: out,
  };
}

/** 5-GHz-Block, in dem ein Kanal liegt (auch außerhalb der Kandidaten, z. B. 132–144, 149–161) */
function blockOf(channel: number): [number, number] {
  return occupied("5", channel, 80);
}

function advice5(foreign: WifiNetwork[], own: OwnNetwork | null, notes: ChannelNote[]): ChannelAdvice {
  const current = own?.band === "5" ? own.channel : null;
  const cands = BLOCKS_5.map((b) => ({ key: b[0], load: loadRange(foreign, "5", b) }));
  const curBlock = current !== null ? blockOf(current) : null;
  const loadCurrent = curBlock ? loadRange(foreign, "5", curBlock) : null;
  const curKey = curBlock && BLOCKS_5.some((b) => b[0] === curBlock[0]) ? curBlock[0] : null;

  const weather = cands.find((c) => c.key === 116)!;
  const others = cands.filter((c) => c.key !== 116);
  let rec: { key: number; load: number };
  if (others.every((c) => weather.load + 1.0 <= c.load)) {
    rec = weather;
  } else {
    rec = pick(others, curKey);
    const low = cands[0];
    // 36–48 bevorzugt (keine DFS-Pause), wenn höchstens 0,5 schlechter
    if (low.load <= rec.load + 0.5) rec = low;
  }
  // Kein lohnender Wechsel → beim aktuellen Block bleiben
  if (curKey !== null && improvementOf(loadCurrent, rec.load) === "none") rec = cands.find((c) => c.key === curKey)!;
  const dfs = rec.key !== 36;
  const out = notes.slice();
  if (dfs) out.push("dfs");
  if (rec.key === 116) out.push("dfsWeather");
  return {
    band: "5",
    current,
    recommended: rec.key,
    widthMhz: 80,
    dfs,
    loadCurrent: loadCurrent === null ? null : round2(loadCurrent),
    loadRecommended: round2(rec.load),
    alternatives: alternativesOf(
      cands.filter((c) => c.key !== 116),
      rec.key,
      rec.load,
    ),
    improvement: rec.key === curKey ? "none" : improvementOf(loadCurrent, rec.load),
    notes: out,
  };
}

function advice6(foreign: WifiNetwork[], own: OwnNetwork | null, notes: ChannelNote[]): ChannelAdvice {
  const current = own?.band === "6" ? own.channel : null;
  const cands = PSC_6.map((k) => ({ key: k as number, load: loadRange(foreign, "6", [k, k]) }));
  const loadCurrent = current !== null ? loadRange(foreign, "6", [current, current]) : null;
  const curKey = current !== null && (PSC_6 as readonly number[]).includes(current) ? current : null;
  let rec = pick(cands, curKey);
  if (curKey !== null && improvementOf(loadCurrent, rec.load) === "none") rec = cands.find((c) => c.key === curKey)!;
  return {
    band: "6",
    current,
    recommended: rec.key,
    widthMhz: own?.band === "6" && own.widthMhz ? own.widthMhz : 20,
    dfs: false,
    loadCurrent: loadCurrent === null ? null : round2(loadCurrent),
    loadRecommended: round2(rec.load),
    alternatives: alternativesOf(cands, rec.key, rec.load),
    improvement: rec.key === curKey ? "none" : improvementOf(loadCurrent, rec.load),
    notes: notes.slice(),
  };
}

const BANDS: WifiBand[] = ["2.4", "5", "6"];

/**
 * Kanal-Empfehlung. Mit WLAN-Verbindung: eine Empfehlung für das Band des eigenen Netzes. Ohne
 * Verbindung: je Band mit Netzen eine Belegung „falls dein Router in diesem Band funkt“
 * (`noConnection`, `current = null`).
 */
export function channelAdvice(networks: WifiNetwork[], own: OwnNetwork | null, opts: AdviceOptions): ChannelAdvice[] {
  const { foreign, ownExtra } = splitNetworks(networks, own);
  const common: ChannelNote[] = [];
  if (!own) common.push("noConnection");
  if (opts.fresh === false) common.push("cacheOnly");
  if (ownExtra > 0) common.push("ownExtraSsids");
  if (opts.wiredPrimary) common.push("wiredPrimary");
  const bands = own ? [own.band] : BANDS.filter((b) => networks.some((n) => n.band === b));
  return bands.map((b) => (b === "2.4" ? advice24(foreign, own, common) : b === "5" ? advice5(foreign, own, common) : advice6(foreign, own, common)));
}

/** Ein Balken der Kanalbelegung */
export interface ChannelBar {
  channel: number;
  /** Last durch fremde Netze (gewichtet) */
  load: number;
  /** Zahl der Netze, deren Hauptkanal hier liegt (alle, auch eigene) */
  count: number;
  /** eigenes Netz auf diesem Kanal bzw. in diesem Bereich */
  own: boolean;
  /** empfohlener Kanal bzw. Block */
  recommended: boolean;
  /** Kandidat der Empfehlung (1/6/11, Block-Anfang, PSC) */
  candidate: boolean;
  /** DFS-Kanal (5 GHz 52–144) */
  dfs: boolean;
}

/** Kanäle, die je Band als Balken gezeigt werden */
export function barChannels(band: WifiBand): number[] {
  if (band === "2.4") return Array.from({ length: 13 }, (_, i) => i + 1);
  if (band === "5") return [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];
  return Array.from({ length: 24 }, (_, i) => 1 + i * 4);
}

/** Kanalbelegung eines Bands als Balken (eigenes Netz und Empfehlung markiert) */
export function channelBars(networks: WifiNetwork[], band: WifiBand, own: OwnNetwork | null, advice: ChannelAdvice | null): ChannelBar[] {
  const { foreign } = splitNetworks(networks, own);
  const ownRange = own && own.band === band ? occupied(band, own.channel, own.widthMhz) : null;
  const recRange: [number, number] | null = advice && advice.band === band ? (band === "5" ? [advice.recommended, advice.recommended + 12] : [advice.recommended, advice.recommended]) : null;
  return barChannels(band).map((ch) => {
    const load = band === "2.4" ? load24(foreign, ch) : loadRange(foreign, band, [ch, ch]);
    return {
      channel: ch,
      load: round2(load),
      count: networks.filter((n) => n.band === band && n.channel === ch).length,
      own: ownRange ? ch >= ownRange[0] && ch <= ownRange[1] : false,
      recommended: recRange ? ch >= recRange[0] && ch <= recRange[1] : false,
      candidate: band === "2.4" ? (CHANNELS_24 as readonly number[]).includes(ch) : band === "5" ? BLOCKS_5.some((b) => ch >= b[0] && ch <= b[1]) : (PSC_6 as readonly number[]).includes(ch),
      dfs: band === "5" && ch >= 52 && ch <= 144,
    };
  });
}

/** Band als Zahl in der Sprache der Oberfläche („2,4“ auf Deutsch) */
export const bandNumber = (band: WifiBand | string, lang: "de" | "en") => (lang === "de" ? band.replace(".", ",") : band);

/** Das verbundene Netz aus dem Scan (stärkster verbundener Eintrag) */
export function connectedNetwork(networks: WifiNetwork[]): WifiNetwork | null {
  return networks.filter((n) => n.connected).sort((a, b) => b.rssi - a.rssi)[0] ?? null;
}
