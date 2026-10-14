/**
 * Eigener Takt einer PulseVoice (E.11) – rein und deterministisch.
 * Nennzeitpunkte akkumulieren keinen Versatz; Zittern, Aussetzer, Betonung und
 * „nächster Puls fällt aus“ werden hier entschieden (auch für Pulse aus dem SpinModel).
 */
import { clamp, mulberry32, triangular, type Rng } from "./dsp";

/** Zittern verschiebt höchstens ±35 % der Periode. */
export const JITTER_SPAN = 0.35;
/** Frühester Planungszeitpunkt relativ zu „jetzt“. */
export const MIN_LEAD_S = 0.005;
/** Ab dieser Verspätung wird ein Puls verworfen statt nachgeholt. */
export const MAX_LATE_S = 0.05;

export interface PlanState {
  periodS: number;
  jitter: number;
  /** Nennzeitpunkt des nächsten, noch nicht geplanten Pulses */
  nextNominal: number;
  /** Index des nächsten Pulses */
  index: number;
  /** Grundpegel 0..1 (für die Betonung) */
  level: number;
  /** Zahl der noch auszulassenden Pulse (skipNext) */
  skip: number;
  /** Betonungsfaktor für den nächsten hörbaren Puls */
  accent: number | null;
  /** Aussetzer-Wahrscheinlichkeit als Rampe */
  dropFrom: number;
  dropTo: number;
  dropT0: number;
  dropT1: number;
  rng: Rng;
}

export interface PlannedPulse {
  /** Ist-Zeitpunkt (Modellzeit, s) */
  t: number;
  /** Nennzeitpunkt */
  nominal: number;
  index: number;
  dropped: boolean;
  /** Pegel dieses Pulses 0..1 (Grundpegel bzw. betont) */
  level: number;
}

export const clampPeriod = (p: number): number => clamp(Number.isFinite(p) ? p : 1.3373, 0.004, 10);

export function createPlanState(o: {
  periodS?: number;
  jitter?: number;
  dropout?: number;
  level?: number;
  seed?: number;
  startAt?: number;
} = {}): PlanState {
  const d = clamp(o.dropout ?? 0, 0, 1);
  return {
    periodS: clampPeriod(o.periodS ?? 1.3373),
    jitter: clamp(o.jitter ?? 0, 0, 1),
    nextNominal: o.startAt ?? 0,
    index: 0,
    level: clamp(o.level ?? 1, 0, 1),
    skip: 0,
    accent: null,
    dropFrom: d,
    dropTo: d,
    dropT0: 0,
    dropT1: 0,
    rng: mulberry32(o.seed ?? 1919),
  };
}

/** Aussetzer-Wahrscheinlichkeit zum Zeitpunkt t (lineare Rampe). */
export function dropoutAt(s: PlanState, t: number): number {
  if (t >= s.dropT1 || s.dropT1 <= s.dropT0) return s.dropTo;
  if (t <= s.dropT0) return s.dropFrom;
  return s.dropFrom + ((s.dropTo - s.dropFrom) * (t - s.dropT0)) / (s.dropT1 - s.dropT0);
}

export function setDropout(s: PlanState, p: number, now: number, rampS = 0): void {
  const cur = dropoutAt(s, now);
  s.dropFrom = cur;
  s.dropTo = clamp(p, 0, 1);
  s.dropT0 = now;
  s.dropT1 = now + Math.max(0, rampS);
}

/** Neue Periode – wirkt ab dem nächsten noch nicht geplanten Puls. */
export function setPeriod(s: PlanState, periodS: number): void {
  if (!Number.isFinite(periodS)) return;
  const p = clampPeriod(periodS);
  // nextNominal enthält bereits die alte Periode → auf die neue umrechnen (erst nach dem ersten Puls)
  if (s.index > 0) s.nextNominal += p - s.periodS;
  s.periodS = p;
}

export const skipNext = (s: PlanState): void => {
  s.skip += 1;
};

export const accentNext = (s: PlanState, factor = 1.5): void => {
  s.accent = Math.max(0, Number.isFinite(factor) ? factor : 1.5);
};

export function setJitter(s: PlanState, j: number): void {
  s.jitter = clamp(Number.isFinite(j) ? j : 0, 0, 1);
}

export function setLevel(s: PlanState, level: number): void {
  s.level = clamp(Number.isFinite(level) ? level : 1, 0, 1);
}

/** Setzt den Takt neu an: nächster Nennzeitpunkt = t (z. B. bei start()). */
export function restartAt(s: PlanState, t: number): void {
  s.nextNominal = t;
}

/**
 * Entscheidet für einen Puls zur Zeit t über Aussetzer und Betonung
 * (verbraucht skipNext bzw. accentNext genau einmal).
 */
export function gatePulse(s: PlanState, t: number): { dropped: boolean; level: number } {
  if (s.skip > 0) {
    s.skip -= 1;
    return { dropped: true, level: 0 };
  }
  const p = dropoutAt(s, t);
  if (p > 0 && (p >= 1 || s.rng() < p)) return { dropped: true, level: 0 };
  let level = s.level;
  if (s.accent !== null) {
    level = Math.min(1, s.accent * s.level);
    s.accent = null;
  }
  return { dropped: false, level };
}

/** Lässt verpasste Pulse ohne Nachhol-Burst aus (Rasterlage bleibt erhalten). */
export function skipTo(s: PlanState, now: number): void {
  if (s.nextNominal >= now) return;
  const k = Math.ceil((now - s.nextNominal) / s.periodS);
  s.nextNominal += k * s.periodS;
  s.index += k;
}

/**
 * Plant alle Pulse, deren frühestmöglicher Ist-Zeitpunkt (Nenn − j·0,35·P) vor `horizon` liegt.
 * (Bei j = 0 also erst, wenn der Nennzeitpunkt selbst im Horizont liegt – so bleiben
 * setPeriod/skipNext auch bei 10-s-Perioden reaktionsschnell.)
 * Ist-Zeit = Nenn + j·0,35·P·tri(rng), nie früher als now + 5 ms.
 */
export function planPulses(s: PlanState, now: number, horizon: number): PlannedPulse[] {
  const out: PlannedPulse[] = [];
  // mehr als 50 ms verpasst → nicht nachholen
  if (s.nextNominal < now - MAX_LATE_S) skipTo(s, now);
  let guard = 0;
  while (s.nextNominal - s.jitter * JITTER_SPAN * s.periodS < horizon && guard++ < 4096) {
    const nominal = s.nextNominal;
    const off = s.jitter > 0 ? s.jitter * JITTER_SPAN * s.periodS * triangular(s.rng) : 0;
    const t = Math.max(now + MIN_LEAD_S, nominal + off);
    const g = gatePulse(s, t);
    out.push({ t, nominal, index: s.index, dropped: g.dropped, level: g.level });
    s.index += 1;
    s.nextNominal = nominal + s.periodS;
  }
  return out;
}
