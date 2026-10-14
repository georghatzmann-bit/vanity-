/**
 * Gemeinsame Bausteine des Demo-Backends (Browser, Screenshots, Tests): Events, Zufall mit festem
 * Startwert (Seed 1337, deterministisch), Demo-Schalter, kv-Vorbelegung und Hooks für die
 * Funktions-Mocks (`lib/mock/<funktion>.ts`). In der echten App wird nichts davon geladen.
 */
import type { PingSample, PingTarget, SpeedResult } from "../types";

type Handler = (p: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

/** Demo-Event senden (wie `app.emit` im Backend) */
export const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload));

export function mockListen(event: string, handler: Handler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => listeners.get(event)?.delete(handler);
}

let seed = 1337;
/** Deterministischer Zufall 0–1 (gemeinsamer Zustand für das ganze Demo-Backend) */
export const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Schalter für Tests und Screenshots (im Browser auf `window` setzen):
 * - `__pulsarDeclineUac` „Nein“ auf die Windows-Abfrage · `__pulsarDnsReadOnly` DNS nicht änderbar ·
 *   `__pulsarDnsNoAnswer` Live-Prüfung des DNS scheitert
 * - `__pulsarWifiPrimary` WLAN (2,4 GHz, Kanal 6, −60 dBm) ist die Hauptverbindung
 * - `__pulsarDiagnoseDemo` nächster Demo-Speedtest mit Latenz unter Last +78 ms
 * - `__pulsarWifiLocked` WLAN-Daten gesperrt (24H2-Standortsperre) · `__pulsarNoWifi` kein WLAN-Dienst
 * - `__pulsarDiagnoseGood` „Warum laggt es?“ ohne Befund
 */
export type DemoFlag =
  | "__pulsarDeclineUac"
  | "__pulsarDnsReadOnly"
  | "__pulsarDnsNoAnswer"
  | "__pulsarWifiPrimary"
  | "__pulsarDiagnoseDemo"
  | "__pulsarWifiLocked"
  | "__pulsarNoWifi"
  | "__pulsarDiagnoseGood";

export const demoFlag = (name: DemoFlag) => typeof window !== "undefined" && (window as unknown as Record<string, unknown>)[name] === true;

/** Handler eines Demo-Befehls (Argumente wie bei `invoke`) */
export type MockHandler = (a: Record<string, unknown>) => unknown;
export type MockHandlers = Record<string, MockHandler>;

const kvDefaults = new Map<string, unknown>();
/** Vorbelegung für `kv_get`, solange der Schlüssel noch nicht gesetzt wurde (z. B. `wifi.rooms`) */
export function registerMockKvDefault(key: string, value: unknown) {
  kvDefaults.set(key, value);
}
export const mockKvDefault = (key: string): unknown => (kvDefaults.has(key) ? structuredClone(kvDefaults.get(key)) : null);

type PingTickHook = (sample: PingSample, tick: number, target: PingTarget) => PingSample | void;
type SpeedtestHook = (result: SpeedResult) => void;
const pingTickHooks: PingTickHook[] = [];
const speedtestHooks: SpeedtestHook[] = [];

/**
 * Hook in jedem Takt des Demo-Monitors für das Hauptziel (`targets[0]`, Takt ab 0). Gibt der Hook
 * einen Messwert zurück, ersetzt er den Wert im `net://ping` (z. B. ein Demo-Ausreißer).
 */
export function onPingTick(hook: PingTickHook) {
  pingTickHooks.push(hook);
}
/** Hook nach jedem erfolgreichen Demo-Speedtest (Protokollierung im Demo). */
export function onSpeedtest(hook: SpeedtestHook) {
  speedtestHooks.push(hook);
}

/** Vom Demo-Monitor aufgerufen. */
export function runPingTick(sample: PingSample, tick: number, target: PingTarget): PingSample {
  let out = sample;
  for (const h of pingTickHooks) out = h(out, tick, target) ?? out;
  return out;
}
/** Vom Demo-Speedtest aufgerufen. */
export function runSpeedtestHooks(result: SpeedResult) {
  for (const h of speedtestHooks) h(result);
}
