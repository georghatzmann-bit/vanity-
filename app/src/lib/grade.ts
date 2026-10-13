/**
 * Noten und Kennzahlen für die Verbindung – reine Logik, überall gleich (Cockpit, Berichte, Overlay, Demo).
 */
import type { Grade, PingSample, PingStats } from "./types";

/** Note aus Ping, Schwankung und Paketverlust (loss 0–1). Ohne Messung → null. */
export function pingGrade(avg: number | null, jitter: number | null, loss: number): Grade | null {
  if (avg === null || !Number.isFinite(avg)) return null;
  const j = jitter ?? 0;
  if (loss >= 0.08 || avg >= 180) return "F";
  if (loss >= 0.03 || avg >= 100 || j >= 25) return "D";
  if (loss >= 0.01 || avg >= 60 || j >= 12) return "C";
  if (loss >= 0.005 || avg >= 35 || j >= 6) return "B";
  if (loss > 0 || avg >= 20 || j >= 3) return "A";
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

/** Ping-Spitzen: deutlich über dem Median (mindestens doppelt oder +40 ms) */
export function countSpikes(rtts: (number | null)[]): number {
  const ok = rtts.filter((v): v is number => v !== null);
  const base = median(ok);
  if (base === null) return 0;
  const limit = Math.max(base * 2, base + 40);
  return ok.filter((v) => v > limit).length;
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
