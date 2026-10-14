/**
 * Ridgeline-Modell des Intros (Spec D.3/D.4), rein. Seed 1919, beschriftet „SIMULIERTES PROFIL“.
 * 16 Zeilen à 161 Punkte (x = −80 … +80 ms), Faltung zu Haarstrahlen und Ring.
 */
import { MARK_GEOMETRY, rayAngle, rayDir } from "@shared/ui/PulsarMark";
import { gaussian, mixSeed, mulberry32 } from "./rng";

export const ROWS = 16;
export const SAMPLES = 161;
export const X_MIN_MS = -80;
export const RIDGE_SEED = 1919;
export const NOISE_SIGMA = 0.06;
/** Plotfeld: x 250 + 3·j, Grundlinie der Zeile k: 128 + 14·(k − 1), Höhe 34·y */
export const PLOT_X0 = 250;
export const PLOT_DX = 3;
export const ROW_Y0 = 128;
export const ROW_DY = 14;
export const ROW_H = 34;
/** Σ: Grundlinie y 376 (10 px über der Achse bei 386,5), Höhe 26·Σ */
export const SUM_Y = 376;
export const SUM_H = 26;
/** Zeichen im Intro: 200 px bei (490, 250) */
export const INTRO_MARK_CENTER: [number, number] = [490, 250];
export const INTRO_MARK_SIZE = 200;
/** Faltfrequenz (CP 1919) */
export const FOLD_F0 = 0.7478;

export const sampleMs = (j: number) => X_MIN_MS + j;
export const plotX = (j: number) => PLOT_X0 + PLOT_DX * j;
export const rowBaseY = (k: number) => ROW_Y0 + ROW_DY * (k - 1);

export interface Row {
  /** 1…16 */
  k: number;
  /** Lage des Hauptpulses (ms) */
  c: number;
  A: number;
  /** reines Profil s_k */
  signal: Float64Array;
  /** Profil + geglättetes Rauschen y_k */
  y: Float64Array;
}

function smooth3(a: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const l = a[Math.max(0, i - 1)];
    const r = a[Math.min(a.length - 1, i + 1)];
    out[i] = (l + a[i] + r) / 3;
  }
  return out;
}

/** Gaußrauschen σ, über 3 Punkte geglättet */
function noiseArray(rand: () => number, sigma: number): Float64Array {
  const g = gaussian(rand);
  const n = new Float64Array(SAMPLES);
  for (let j = 0; j < SAMPLES; j++) n[j] = g() * sigma;
  return smooth3(n);
}

/** Profil-Klammer ohne Amplitude, auf Maximum 1 normiert */
function profile(c: number): Float64Array {
  const p = new Float64Array(SAMPLES);
  let max = 0;
  for (let j = 0; j < SAMPLES; j++) {
    const x = sampleMs(j);
    p[j] = Math.exp(-((x - c) ** 2) / 18) + 0.7 * Math.exp(-((x - c - 9) ** 2) / 12.5);
    max = Math.max(max, p[j]);
  }
  for (let j = 0; j < SAMPLES; j++) p[j] /= max;
  return p;
}

/** Die 16 Zeilen (deterministisch je Seed) */
export function makeRows(seed = RIDGE_SEED): Row[] {
  const rand = mulberry32(seed);
  const rows: Row[] = [];
  for (let k = 1; k <= ROWS; k++) {
    const u = rand();
    const A = 0.6 + 0.4 * u;
    const c = -6 + (((k - 1) * 3.7) % 12);
    const p = profile(c);
    const signal = new Float64Array(SAMPLES);
    for (let j = 0; j < SAMPLES; j++) signal[j] = A * p[j];
    const n = noiseArray(rand, NOISE_SIGMA);
    const y = new Float64Array(SAMPLES);
    for (let j = 0; j < SAMPLES; j++) y[j] = signal[j] + n[j];
    rows.push({ k, c, A, signal, y });
  }
  return rows;
}

/** Reine Rauschzeile (flimmernde Zeilen, Suche), deterministisch je Seed und Bild */
export function noiseRow(seed: number, frame: number, sigma = 0.1): Float64Array {
  return noiseArray(mulberry32(mixSeed(seed, frame)), sigma);
}

/** Σ_k(x) = (1/k)·Σ_{i≤k} y_i(x) */
export function foldMean(rows: Row[], k = rows.length): Float64Array {
  const n = Math.max(0, Math.min(k, rows.length));
  const out = new Float64Array(SAMPLES);
  if (n === 0) return out;
  for (let i = 0; i < n; i++) for (let j = 0; j < SAMPLES; j++) out[j] += rows[i].y[j];
  for (let j = 0; j < SAMPLES; j++) out[j] /= n;
  return out;
}

/** Probefaltung beim Suchen: c(f) = exp(−(ln(f/f₀)/0,05)²) */
export function probeGain(f: number, f0 = FOLD_F0): number {
  if (!(f > 0)) return 0;
  return Math.exp(-((Math.log(f / f0) / 0.05) ** 2));
}

/* ── Faltung zum Zeichen (D.4) ──────────────────────────── */
type Pt = [number, number];
const lerpPt = (s: Pt, t: Pt, e: number): Pt => [s[0] + e * (t[0] - s[0]), s[1] + e * (t[1] - s[1])];

/** Strahl b und Haarstrahl k für Zeile i (1…16) */
export function rowRay(i: number): { b: 0 | 1; k: number } {
  return { b: i <= 8 ? 0 : 1, k: (i - 1) % 8 };
}

/**
 * Zielpunkt des Punkts j (0…160) der Zeile i auf ihrem Haarstrahl. Strahl b = 0 läuft von innen (j = 0) nach
 * außen, Strahl b = 1 umgekehrt (j = 0 außen): So zeigen beide Bündel in Laufrichtung der Zeile (links → rechts)
 * gleichsinnig und drehen sich bei der Faltung beide um denselben Winkel, ohne sich zu überkreuzen.
 */
export function rayTarget(i: number, j: number, center: Pt = INTRO_MARK_CENTER, size = INTRO_MARK_SIZE): Pt {
  const g = MARK_GEOMETRY;
  const s = size / g.VIEWBOX;
  const { b, k } = rowRay(i);
  const [dx, dy] = rayDir(rayAngle(b, k));
  const u = j / (SAMPLES - 1);
  const r = s * (g.RAY_IN + (b === 0 ? u : 1 - u) * (g.RAY_OUT(k) - g.RAY_IN));
  return [center[0] + r * dx, center[1] + r * dy];
}

/* ── Zweistufige Faltung: erst glätten, dann als starres Segment drehen ── */

/** Anteil der Faltung, in dem die Amplitude der Zeile auf 0 geht (gerade Haarlinie an der Basis) */
export const FOLD_FLATTEN = 0.35;

export interface Segment {
  /** Mittelpunkt */
  cx: number;
  cy: number;
  /** Richtung j = 0 → j = 160 (rad, Bildschirm) */
  angle: number;
  len: number;
}

/** Zeile i als gerade Haarlinie an ihrer Grundlinie */
export function rowStartSegment(i: number): Segment {
  const x0 = plotX(0);
  const x1 = plotX(SAMPLES - 1);
  return { cx: (x0 + x1) / 2, cy: rowBaseY(i), angle: 0, len: x1 - x0 };
}

/** Haarstrahl der Zeile i als Segment (rayTarget j = 0 → 160) */
export function rowTargetSegment(i: number, center: Pt = INTRO_MARK_CENTER, size = INTRO_MARK_SIZE): Segment {
  const a = rayTarget(i, 0, center, size);
  const b = rayTarget(i, SAMPLES - 1, center, size);
  return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, angle: Math.atan2(b[1] - a[1], b[0] - a[0]), len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
}

/** Starres Segment bei u (0…1): Mittelpunkt und Länge linear, Winkel auf kürzestem Weg */
export function foldSegment(i: number, u: number, center: Pt = INTRO_MARK_CENTER, size = INTRO_MARK_SIZE): Segment {
  const A = rowStartSegment(i);
  const B = rowTargetSegment(i, center, size);
  const k = Math.min(1, Math.max(0, u));
  let d = B.angle - A.angle;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return { cx: A.cx + (B.cx - A.cx) * k, cy: A.cy + (B.cy - A.cy) * k, angle: A.angle + d * k, len: A.len + (B.len - A.len) * k };
}

/**
 * Punkt j der Zeile i (Wert y) bei Faltung e (0…1, schon geglättet): bis e = 0,35 geht die Amplitude auf 0,
 * danach wird die gerade Zeile als STARRES Segment zum Haarstrahl geführt (Punkte gleichmäßig auf dem Segment).
 */
export function foldRowPoint(i: number, j: number, y: number, e: number, center: Pt = INTRO_MARK_CENTER, size = INTRO_MARK_SIZE): Pt {
  if (e < FOLD_FLATTEN) {
    const u = e / FOLD_FLATTEN;
    const amp = 1 - u * u * (3 - 2 * u);
    return [plotX(j), rowBaseY(i) - ROW_H * y * amp];
  }
  const seg = foldSegment(i, (e - FOLD_FLATTEN) / (1 - FOLD_FLATTEN), center, size);
  const t = j / (SAMPLES - 1) - 0.5;
  return [seg.cx + t * seg.len * Math.cos(seg.angle), seg.cy + t * seg.len * Math.sin(seg.angle)];
}

/** P = S + e·(T − S); e = schon geglätteter Fortschritt 0…1 */
export function rowToRay(i: number, j: number, e: number, start: Pt, center: Pt = INTRO_MARK_CENTER, size = INTRO_MARK_SIZE): Pt {
  return lerpPt(start, rayTarget(i, j, center, size), e);
}

/** Zielpunkt des Σ-Punkts j auf dem Ring: ψ_j = 360°·j/160 */
export function ringTarget(j: number, center: Pt = INTRO_MARK_CENTER, size = INTRO_MARK_SIZE): Pt {
  const s = size / MARK_GEOMETRY.VIEWBOX;
  const psi = (2 * Math.PI * j) / (SAMPLES - 1);
  const r = s * MARK_GEOMETRY.RING_R;
  return [center[0] + r * Math.sin(psi), center[1] - r * Math.cos(psi)];
}

export function sumToRing(j: number, e: number, start: Pt, center: Pt = INTRO_MARK_CENTER, size = INTRO_MARK_SIZE): Pt {
  return lerpPt(start, ringTarget(j, center, size), e);
}

/** Zielwinkel (Grad, gegen den Uhrzeigersinn ab 12 Uhr) des Σ-Punkts j: ψ_j = 180° + 360°·(j/(SAMPLES−1) − 0,5) */
export function ringAngleDeg(j: number): number {
  return 180 + 360 * (j / (SAMPLES - 1) - 0.5);
}

/**
 * Σ → Ring polar um die Zeichenmitte (Radius und Winkel getrennt interpoliert): Die Kurve rollt sich ohne
 * Knoten zum Ring; die Mitte bleibt unten, die Enden treffen sich bei 12 Uhr.
 */
export function sumToRingPolar(j: number, e: number, start: Pt, center: Pt = INTRO_MARK_CENTER, size = INTRO_MARK_SIZE): Pt {
  const R = (size / MARK_GEOMETRY.VIEWBOX) * MARK_GEOMETRY.RING_R;
  const dx = start[0] - center[0];
  const dy = start[1] - center[1];
  const rs = Math.hypot(dx, dy);
  let as = (Math.atan2(-dx, -dy) * 180) / Math.PI;
  if (as < 0) as += 360;
  const at = ringAngleDeg(j);
  const k = Math.min(1, Math.max(0, e));
  const a = ((as + (at - as) * k) * Math.PI) / 180;
  const r = rs + (R - rs) * k;
  return [center[0] - r * Math.sin(a), center[1] - r * Math.cos(a)];
}

/** Startpunkt eines Zeilenpunkts im Plot (Bildschirm) */
export function rowPoint(k: number, j: number, y: number): Pt {
  return [plotX(j), rowBaseY(k) - ROW_H * y];
}

/** Startpunkt eines Σ-Punkts im Plot */
export function sumPoint(j: number, v: number): Pt {
  return [plotX(j), SUM_Y - SUM_H * v];
}
