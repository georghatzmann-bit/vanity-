/**
 * Noten und Kennzahlen für die Verbindung – reine Logik, überall gleich (Cockpit, Berichte, Overlay, Demo).
 */
import type { Grade, PingSample, PingStats } from "./types";

/**
 * Grenzen der Ø-Ping-Stufen von `pingGrade` (ms): unter 20 → A+, 20–34,9 → A, 35–59,9 → B, 60–99,9 → C,
 * 100–179,9 → D, ab 180 → F. Gemeinsame Konstante, z. B. für die Tonstufen von „Hör dein Netz“.
 */
export const PING_GRADE_LIMITS = [20, 35, 60, 100, 180] as const;

/** Note aus Ping, Schwankung und Paketverlust (loss 0–1). Ohne Messung → null. */
export function pingGrade(avg: number | null, jitter: number | null, loss: number): Grade | null {
  if (avg === null || !Number.isFinite(avg)) return null;
  const j = jitter ?? 0;
  const [a, b, c, d, f] = PING_GRADE_LIMITS;
  if (loss >= 0.08 || avg >= f) return "F";
  if (loss >= 0.03 || avg >= d || j >= 25) return "D";
  if (loss >= 0.01 || avg >= c || j >= 12) return "C";
  if (loss >= 0.005 || avg >= b || j >= 6) return "B";
  if (loss > 0 || avg >= a || j >= 3) return "A";
  return "A+";
}

/** Farbe (CSS-Variable) zu einer Note */
export function gradeColor(grade: Grade | null): string {
  switch (grade) {
    case "A+":
    case "A":
      return "var(--nv-success)";
    case "B":
      return "var(--nv-accent)";
    case "C":
      return "var(--nv-warning)";
    case "D":
      return "color-mix(in oklab, var(--nv-warning) 50%, var(--nv-danger))";
    case "F":
      return "var(--nv-danger)";
    default:
      return "var(--nv-muted)";
  }
}

/** Note als Zahl 0–1 für Ringe (A+ = 1) */
export function gradeValue(grade: Grade | null): number {
  return { "A+": 1, A: 0.88, B: 0.72, C: 0.52, D: 0.32, F: 0.12 }[grade ?? "F"] ?? 0;
}

/** Ping-Farbe für Diagramme: grün bis rot */
export function pingColor(ms: number | null): string {
  if (ms === null) return "var(--nv-danger)";
  if (ms < 35) return "var(--nv-success)";
  if (ms < 60) return "var(--nv-accent)";
  if (ms < 100) return "var(--nv-warning)";
  return "var(--nv-danger)";
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Statistik über Messwerte (wie im Backend: Jitter = mittlere Abweichung aufeinanderfolgender Antworten) */
export function summarize(targetId: string, samples: PingSample[]): PingStats {
  const rtts = samples.map((s) => s.rtt).filter((v): v is number => v !== null && Number.isFinite(v));
  const n = samples.length;
  let jitter: number | null = null;
  if (rtts.length >= 2) {
    let acc = 0;
    for (let i = 1; i < rtts.length; i++) acc += Math.abs(rtts[i] - rtts[i - 1]);
    jitter = acc / (rtts.length - 1);
  }
  const last = samples.length ? samples[samples.length - 1].rtt : null;
  return {
    targetId,
    last,
    avg: rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    min: rtts.length ? Math.min(...rtts) : null,
    max: rtts.length ? Math.max(...rtts) : null,
    jitter,
    loss: n ? (n - rtts.length) / n : 0,
    samples: n,
  };
}

/**
 * Ausreißer-Grenze über die Antworten: `max(2 × Median, Median + 40)`; null ohne Antwort.
 * Gleiche Regel wie im Backend (`lag::spike_limit`), gemeinsame Prüfdaten in ./fixtures/spikes.json.
 */
export function spikeLimit(ok: number[]): number | null {
  const base = median(ok);
  return base === null ? null : Math.max(base * 2, base + 40);
}

/** Ping-Spitzen (Ausreißer): echt über der Grenze; Verluste sind nie Ausreißer */
export function countSpikes(rtts: (number | null)[]): number {
  const ok = rtts.filter((v): v is number => v !== null);
  const limit = spikeLimit(ok);
  if (limit === null) return 0;
  return ok.filter((v) => v > limit).length;
}

/** Live-Fenster: die letzten höchstens 60 Werte; bewertet wird erst ab 10 Antworten */
export const LIVE_WINDOW = 60;
export const LIVE_MIN_ANSWERS = 10;

/**
 * Live-Regel (wie `lag::is_live_spike` im Backend): Ist der neueste Wert von `window` (das Fenster endet mit
 * ihm) ein Ausreißer? Nur die letzten 60 Werte zählen, mindestens 10 Antworten, Verlust ist nie ein Ausreißer.
 */
export function isLiveSpike(window: (number | null)[]): boolean {
  const w = window.slice(-LIVE_WINDOW);
  const last = w[w.length - 1];
  if (last === null || last === undefined) return false;
  const ok = w.filter((v): v is number => v !== null);
  if (ok.length < LIVE_MIN_ANSWERS) return false;
  const limit = spikeLimit(ok);
  return limit !== null && last > limit;
}

/** Zeitreihe auf höchstens `max` Punkte verdichten (Mittelwert je Abschnitt, Verlust bleibt sichtbar) */
export function compressTimeline(points: [number, number | null][], max = 600): [number, number | null][] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: [number, number | null][] = [];
  for (let i = 0; i < max; i++) {
    const slice = points.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    if (!slice.length) continue;
    const vals = slice.map((p) => p[1]).filter((v): v is number => v !== null);
    const lost = vals.length < slice.length / 2;
    out.push([slice[0][0], lost || !vals.length ? null : vals.reduce((a, b) => a + b, 0) / vals.length]);
  }
  return out;
}

/** Bufferbloat-Note aus dem Anstieg der Antwortzeit unter Last (ms) */
export function bufferbloatGrade(increaseMs: number): Grade {
  if (increaseMs < 5) return "A+";
  if (increaseMs < 30) return "A";
  if (increaseMs < 60) return "B";
  if (increaseMs < 200) return "C";
  if (increaseMs < 400) return "D";
  return "F";
}

/** Signalstärke 0–100 → Wort */
export function signalLabel(signal: number): "excellent" | "good" | "fair" | "weak" {
  if (signal >= 80) return "excellent";
  if (signal >= 60) return "good";
  if (signal >= 40) return "fair";
  return "weak";
}
