/**
 * Pulsar-Kalender (Rechnung in der Oberfläche, Ortszeit). Vertrag: docs/API.md, „Pulsar-Kalender“.
 */
import type { Grade } from "../types";

/** Zeitraum in Tagen (Standard 90) */
export type CalendarRange = 30 | 90 | 365;
/** Verbindungsart-Filter (Standard „alle außer VPN“) */
export type CalendarConnectionFilter = "noVpn" | "ethernet" | "wifi";

/** Ein Fach (Wochentag Montag = 0 … Sonntag = 6, Stunde 0–23) */
export interface CalendarCell {
  weekday: number;
  hour: number;
  n: number;
  lost: number;
  avg: number | null;
  jitter: number | null;
  loss: number;
  spikeRate: number;
  /** Σ coveredMs */
  covered: number;
  /** verschiedene Kalendertage mit einer Messstunde (≥ 30 min) */
  days: number;
  grade: Grade | null;
  /** mindestens 2 Messstunden an mindestens 2 Tagen */
  valid: boolean;
  /** gültig und an mindestens 3 Tagen */
  recommendable: boolean;
}

/** Ein Block aus 2 aufeinanderfolgenden Stunden am selben Wochentag */
export interface CalendarBlock {
  weekday: number;
  /** erste Stunde des Blocks */
  hour: number;
  avg: number | null;
  grade: Grade | null;
  /** an so vielen dieser Wochentage gemessen */
  days: number;
}

/** Empfehlung: ruhigste Zeit, kein deutlicher Unterschied oder zu wenig Daten */
export type CalendarAdvice =
  | { kind: "best"; best: CalendarBlock; worst: CalendarBlock }
  | { kind: "noDifference" }
  | { kind: "tooLittle"; hours: number; days: number };
