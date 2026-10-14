/**
 * Zahlenformate des Messgeräts (F.4, B.3): de mit Komma, en mit Punkt,
 * zwischen Zahl und Einheit U+00A0 (U+202F/U+2009 fehlen in Plex Mono).
 */
import type { Lang } from "../i18n";
import { exposureTime, exposureTurns } from "./star";

export const NBSP = " ";

/** Feste Nachkommastellen, ohne Tausendertrennung */
export function fixed(v: number, digits: number, lang: Lang = "de"): string {
  const s = (Number.isFinite(v) ? v : 0).toFixed(digits);
  return lang === "de" ? s.replace(".", ",") : s;
}

/** Periode: ≥ 1 s 4 Stellen; 100 ms–1 s 1; 10–100 ms 2; < 10 ms 3 */
export function formatPeriod(periodS: number, lang: Lang = "de"): string {
  if (periodS >= 1) return `${fixed(periodS, 4, lang)}${NBSP}s`;
  const ms = periodS * 1000;
  if (ms >= 100) return `${fixed(ms, 1, lang)}${NBSP}ms`;
  if (ms >= 10) return `${fixed(ms, 2, lang)}${NBSP}ms`;
  return `${fixed(ms, 3, lang)}${NBSP}ms`;
}

/** Frequenz: < 1 Hz 3 Stellen; < 100 Hz 2; sonst 1 */
export function formatHz(f: number, lang: Lang = "de"): string {
  const d = f < 1 ? 3 : f < 100 ? 2 : 1;
  return `${fixed(f, d, lang)}${NBSP}Hz`;
}

/** Prozent mit einer Nachkommastelle: „43,0 %“ (de), „43.0%“ (en) */
export function formatPercent(percent: number, lang: Lang = "de"): string {
  return lang === "de" ? `${fixed(percent, 1, lang)}${NBSP}%` : `${fixed(percent, 1, lang)}%`;
}

/** Dauer (ms): „0,4 s“ unter 10 s, „12 s“ unter 1 min, sonst „1:05“ */
export function formatDuration(ms: number, lang: Lang = "de"): string {
  const s = Math.max(0, ms) / 1000;
  if (Math.round(s * 10) / 10 < 10) return `${fixed(s, 1, lang)}${NBSP}s`;
  if (Math.round(s) < 60) return `${Math.round(s)}${NBSP}s`;
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Kamera-Wert zur Frequenz: „1/60 s“, „0,12 s“ oder „2 · P“ (ohne das Wort „Belichtung“) */
export function formatExposure(f: number, lang: Lang = "de"): string {
  if (f <= 0.75) return `1/60${NBSP}s`;
  if (exposureTurns(f) >= 2) return "2 · P";
  return `${fixed(exposureTime(f), 2, lang)}${NBSP}s`;
}
