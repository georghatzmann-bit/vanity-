/**
 * Reines DSP für die Pulsar-Sonifikation (E.2, E.5–E.7).
 * Keine Web-Audio-Abhängigkeit: alles ist synchron, deterministisch und in vitest (node) prüfbar.
 */

/** Grundton: Rotationsfrequenz von PSR J0437−4715 (P = 5,757 ms). */
export const F_STAR = 1 / 0.005757;

/** n-te Harmonische von F_STAR (1 ≤ n ≤ 18 sind im Klangvokabular erlaubt). */
export const harmonic = (n: number): number => n * F_STAR;

export const dbToGain = (db: number): number => (db === -Infinity ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number): number => (g <= 0 ? -Infinity : 20 * Math.log10(g));
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Logarithmische Interpolation zwischen (x0, y0) und (x1, y1), außerhalb begrenzt. */
export function logInterp(x: number, x0: number, y0: number, x1: number, y1: number): number {
  if (x <= x0) return y0;
  if (x >= x1) return y1;
  const u = Math.log(x / x0) / Math.log(x1 / x0);
  return Math.exp(Math.log(y0) + (Math.log(y1) - Math.log(y0)) * u);
}

// ---------------------------------------------------------------------------
// Biquads nach Web-Audio-Spezifikation
// ---------------------------------------------------------------------------

export type FilterType = "bandpass" | "lowpass" | "highpass";

export interface FilterSpec {
  type: FilterType;
  /** Mitten- bzw. Grenzfrequenz in Hz */
  f: number;
  /** Bandpass: Q linear. Tief-/Hochpass: Q in dB (−3,01 = Butterworth). */
  q: number;
}

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Koeffizienten (auf a0 normiert) exakt wie im Web-Audio-BiquadFilterNode. */
export function biquadCoeffs(type: FilterType, f0: number, q: number, sr: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * clamp(f0, 1e-3, sr / 2 - 1e-3)) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  let b0: number, b1: number, b2: number;
  let alpha: number;
  if (type === "bandpass") {
    alpha = sin / (2 * Math.max(q, 1e-4));
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  } else {
    alpha = sin / (2 * Math.pow(10, q / 20));
    if (type === "lowpass") {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    } else {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    }
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/** Betrag des Frequenzgangs |H(e^jω)| bei f. */
export function biquadMagnitude(c: BiquadCoeffs, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = -(c.a1 * s1 + c.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Filtert x (Direktform I) und gibt ein neues Array zurück. */
export function filterSignal(x: Float32Array, c: BiquadCoeffs): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const xn = x[n];
    const yn = c.b0 * xn + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = xn;
    y2 = y1;
    y1 = yn;
    y[n] = yn;
  }
  return y;
}

// ---------------------------------------------------------------------------
// Resonatoren (Klangfarben, Einzelklang-Puffer)
// ---------------------------------------------------------------------------

export interface ResonatorBranch extends FilterSpec {
  /** Anteil des Zweigs in dB */
  gainDb: number;
}

export interface ResonatorSpec {
  /** parallel summierte Zweige */
  branches: ResonatorBranch[];
  /** danach in Reihe (z. B. Glätter) */
  post: FilterSpec[];
}

/** Rohe Antwort (nicht normiert) der Resonatoren auf x, Länge len. */
export function renderResonators(x: Float32Array, spec: ResonatorSpec, sr: number, len: number): Float32Array {
  const input = new Float32Array(len);
  input.set(x.subarray(0, Math.min(len, x.length)));
  let sum: Float32Array = new Float32Array(len);
  for (const b of spec.branches) {
    const y = filterSignal(input, biquadCoeffs(b.type, b.f, b.q, sr));
    const g = dbToGain(b.gainDb);
    for (let n = 0; n < len; n++) sum[n] += g * y[n];
  }
  for (const p of spec.post) sum = filterSignal(sum, biquadCoeffs(p.type, p.f, p.q, sr));
  return sum;
}

export const peakOf = (x: ArrayLike<number>): number => {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
};

export const rmsOf = (x: ArrayLike<number>, from = 0, to = x.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

/** Größte Pufferlänge vorgerenderter Einzelklänge. */
export const MAX_RENDER = 2048;

/**
 * Antwort der Resonatoren auf eine Anregung, auf Spitze 1 normiert und auf ≤ 2048 Samples
 * gekürzt (Ausklang unter −80 dB wird abgeschnitten).
 */
export function renderResponse(exc: Float32Array, spec: ResonatorSpec, sr: number, maxLen = MAX_RENDER): Float32Array {
  const len = Math.min(maxLen, MAX_RENDER);
  const raw = renderResonators(exc, spec, sr, len);
  const peak = peakOf(raw);
  if (peak <= 0) return new Float32Array(1);
  let last = len - 1;
  const floor = peak * 1e-4;
  while (last > 0 && Math.abs(raw[last]) < floor) last--;
  const out = new Float32Array(last + 1);
  for (let n = 0; n <= last; n++) out[n] = raw[n] / peak;
  return out;
}

/** Spitze der rohen Antwort (für die Normierung norm = 1/Spitze). */
export const responsePeak = (exc: Float32Array, spec: ResonatorSpec, sr: number): number =>
  peakOf(renderResonators(exc, spec, sr, MAX_RENDER));

// ---------------------------------------------------------------------------
// Zufall
// ---------------------------------------------------------------------------

export type Rng = () => number;

/** Deterministischer 32-Bit-Zufallsgenerator, Werte in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dreiecksverteilung in [−1, 1], Mittel 0. */
export const triangular = (rng: Rng): number => rng() + rng() - 1;

/** Standardnormalverteilt (Box–Muller). */
export function gaussian(rng: Rng): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Anregung, Pegelgesetz, Überblendung
// ---------------------------------------------------------------------------

/** Rauschanteile der drei Anregungs-Varianten (E.5). */
export const NOISE_VARIANTS = [0.3, 0.15, 0.05] as const;

/** 4-ms-Anregung: e[0] = 1, danach Gaußrauschen σ = noise·e^(−n/(0,00035·sr)). */
export function makeExcitation(sr: number, noise: number, rng: Rng): Float32Array {
  const len = Math.max(1, Math.round(0.004 * sr));
  const e = new Float32Array(len);
  e[0] = 1;
  const tau = 0.00035 * sr;
  for (let n = 1; n < len; n++) e[n] = noise * Math.exp(-n / tau) * gaussian(rng);
  return e;
}

/** k_e = √(Σ e²) */
export const excitationEnergy = (e: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < e.length; i++) s += e[i] * e[i];
  return Math.sqrt(s);
};

/** Rauschanteil nach Pulsfrequenz: 0,30 bis 10 Hz, 0,05 ab 100 Hz, dazwischen log. */
export const noiseShare = (f: number): number => logInterp(f, 10, 0.3, 100, 0.05);

/** Index der nächstliegenden Anregungs-Variante (im log-Abstand). */
export function nearestNoiseVariant(noise: number): number {
  let best = 0;
  let bestD = Infinity;
  NOISE_VARIANTS.forEach((v, i) => {
    const d = Math.abs(Math.log(noise / v));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Pegel je Puls: a(f) = min(1, √(4/f)) – konstante mittlere Leistung über 4 Hz. */
export const pulseAmp = (f: number): number => (f <= 4 ? 1 : Math.min(1, Math.sqrt(4 / f)));

/** Gleich-Leistungs-Überblendung Klick ↔ Ton zwischen 24 und 48 Hz. */
export function crossfade(f: number): { wc: number; wt: number } {
  const x = clamp(Math.log2(Math.max(f, 1e-9) / 24), 0, 1);
  return { wc: Math.cos((Math.PI * x) / 2), wt: Math.sin((Math.PI * x) / 2) };
}

/** Gain der Tonschicht: g_t = 2·a(f)·(f/sr)·k_e·w_t(f). */
export const toneGain = (f: number, sr: number, ke: number, loudnessComp = true): number =>
  2 * (loudnessComp ? pulseAmp(f) : 1) * (f / sr) * ke * crossfade(f).wt;

/** Glätter-Grenzfrequenz c(f): 6000 Hz bis 20 Hz, 2200 Hz ab 174 Hz, dazwischen log. */
export const smootherCutoff = (f: number): number => logInterp(f, 20, 6000, 174, 2200);

export type HeardAs = "clicks" | "rattle" | "buzz" | "tone";

/** „Hörbar als“ (E.6) */
export const heardAs = (f: number): HeardAs => (f < 8 ? "clicks" : f < 20 ? "rattle" : f < 40 ? "buzz" : "tone");

// ---------------------------------------------------------------------------
// Dispersions-Sweep (E.7)
// ---------------------------------------------------------------------------

function checkSweep(fHi: number, fLo: number, durS: number) {
  if (!(fHi > fLo) || !(fLo > 0)) throw new RangeError(`Sweep muss fallen: fHi ${fHi} ≤ fLo ${fLo}`);
  if (!(durS > 0)) throw new RangeError(`Sweep-Dauer ${durS} ≤ 0`);
}

/** f(t) = (f_hi⁻² + t/K)^(−1/2), K = D/(f_lo⁻² − f_hi⁻²) */
export function dispersionAt(fHi: number, fLo: number, durS: number, t: number): number {
  checkSweep(fHi, fLo, durS);
  const K = durS / (fLo ** -2 - fHi ** -2);
  return Math.pow(fHi ** -2 + clamp(t, 0, durS) / K, -0.5);
}

/** n Stützpunkte der Dispersionskurve von 0 bis D (für setValueCurveAtTime). */
export function dispersionCurve(fHi: number, fLo: number, durS: number, n = 64): Float32Array {
  checkSweep(fHi, fLo, durS);
  const out = new Float32Array(Math.max(2, n));
  for (let i = 0; i < out.length; i++) out[i] = dispersionAt(fHi, fLo, durS, (i / (out.length - 1)) * durS);
  return out;
}

// ---------------------------------------------------------------------------
// Rauschen und Impulsantwort
// ---------------------------------------------------------------------------

/** Rosa Rauschen (Paul-Kellet-Filter), normiert auf RMS 0,25. */
export function pinkNoise(len: number, rng: Rng): Float32Array {
  const d = new Float32Array(len);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = b0 + b1 + b2 + w * 0.1848;
  }
  const r = rmsOf(d);
  if (r > 0) for (let i = 0; i < len; i++) d[i] *= 0.25 / r;
  return d;
}

/** Einpoliger Tief- bzw. Hochpass (für die Impulsantwort). */
function onePole(x: Float32Array, fc: number, sr: number, high: boolean): Float32Array {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  const y = new Float32Array(x.length);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp = (1 - a) * x[i] + a * lp;
    y[i] = high ? x[i] - lp : lp;
  }
  return y;
}

/**
 * Stereo-Impulsantwort „Kuppel“: 12 ms Vorverzögerung, e^(−t/0,16 s), HP 250 Hz, LP 5 kHz.
 * Auf Energie 1 je Kanal normiert (Σ h² = 1): Ein Send von −18 dB ergibt so ≈ −18 dB Hall-Pegel.
 */
export function makeReverbIR(sr: number, rng: Rng, seconds = 0.8): [Float32Array, Float32Array] {
  const len = Math.round(seconds * sr);
  const pre = Math.round(0.012 * sr);
  const ch = (): Float32Array => {
    const x = new Float32Array(len);
    for (let i = pre; i < len; i++) x[i] = gaussian(rng) * Math.exp(-(i - pre) / sr / 0.16);
    const y = onePole(onePole(x, 250, sr, true), 5000, sr, false);
    const e = Math.sqrt(y.reduce((s, v) => s + v * v, 0));
    if (e > 0) for (let i = 0; i < y.length; i++) y[i] /= e;
    return y;
  };
  return [ch(), ch()];
}

/** Bandbegrenzter Sägezahn (additiv, für die RFI-Kalibrierung). */
export function sawtooth(f: number, sr: number, len: number): Float32Array {
  const y = new Float32Array(len);
  const nMax = Math.floor(sr / 2 / f);
  for (let k = 1; k <= nMax; k++) {
    const g = ((2 / Math.PI) * (k % 2 ? 1 : -1)) / k;
    const w = (2 * Math.PI * f * k) / sr;
    for (let i = 0; i < len; i++) y[i] += g * Math.sin(w * i);
  }
  return y;
}

// ---------------------------------------------------------------------------
// Klangfarben und Einzelklang-Puffer (E.5)
// ---------------------------------------------------------------------------

export type Timbre = "radio" | "glass" | "soft";

export type BranchRole = "body" | "core" | "gloss" | "transient";

export interface TimbreBranch extends ResonatorBranch {
  role: BranchRole;
}

export interface TimbreSpec {
  branches: TimbreBranch[];
  /** „smoother“ = Glätter LP c(f) (nur radio), sonst fester Tiefpass */
  post: FilterSpec | "smoother";
}

/** Butterworth-Q für Tief- und Hochpass (Q in dB). */
export const Q_BUTTER = -3.01;

export const TIMBRES: Record<Timbre, TimbreSpec> = {
  radio: {
    branches: [
      { role: "body", type: "bandpass", f: harmonic(2), q: 2.8, gainDb: -6 },
      { role: "core", type: "bandpass", f: harmonic(6), q: 7, gainDb: 0 },
      { role: "gloss", type: "bandpass", f: harmonic(12), q: 9, gainDb: -10 },
      { role: "transient", type: "lowpass", f: 5000, q: Q_BUTTER, gainDb: -16 },
    ],
    post: "smoother",
  },
  glass: {
    branches: [
      { role: "core", type: "bandpass", f: harmonic(12), q: 9, gainDb: 0 },
      { role: "gloss", type: "bandpass", f: harmonic(16), q: 12, gainDb: -4 },
    ],
    post: { type: "lowpass", f: 9000, q: Q_BUTTER },
  },
  soft: {
    branches: [
      { role: "core", type: "bandpass", f: harmonic(2), q: 2.5, gainDb: 0 },
      { role: "body", type: "bandpass", f: harmonic(4), q: 4, gainDb: -8 },
    ],
    post: { type: "lowpass", f: 1200, q: Q_BUTTER },
  },
};

/** Resonanz-Stufen (setStep): Kern-BP auf F_STAR·n, Q 7 – Harmonische, keine Tonleiter. */
export const STEP_HARMONICS = [2, 3, 4, 6, 8, 12] as const;
export const STEP_Q = 7;

/** Resonator-Spezifikation einer Klangfarbe, optional mit Stufe und Kern-Q (progress). */
export function timbreSpec(timbre: Timbre, o: { step?: number | null; coreQ?: number; smootherHz?: number } = {}): ResonatorSpec {
  const t = TIMBRES[timbre];
  const branches = t.branches.map((b) => {
    if (b.role !== "core") return { ...b };
    const step = o.step;
    if (step !== null && step !== undefined) {
      const i = clamp(Math.round(step), 0, STEP_HARMONICS.length - 1);
      return { ...b, f: harmonic(STEP_HARMONICS[i]), q: STEP_Q };
    }
    return { ...b, q: o.coreQ ?? b.q };
  });
  const post: FilterSpec[] =
    t.post === "smoother" ? [{ type: "lowpass", f: o.smootherHz ?? smootherCutoff(1), q: Q_BUTTER }] : [{ ...t.post }];
  return { branches, post };
}

export type BufferName =
  | "hover"
  | "tick"
  | "click"
  | "pulse-radio"
  | "pulse-glass"
  | "pulse-soft"
  | "progress-q3"
  | "progress-q6"
  | "progress-q9"
  | "progress-q12";

export type ExcitationName = "A" | "0.30" | "0.15" | "0.05";

export interface BufferSpec {
  exc: ExcitationName;
  spec: ResonatorSpec;
}

const bp = (f: number, q: number, gainDb = 0): ResonatorBranch => ({ type: "bandpass", f, q, gainDb });

/** Vorgerenderte Einzelklänge (E.5) – Resonatoren nur auf Harmonischen von F_STAR. */
export const BUFFER_SPECS: Record<BufferName, BufferSpec> = {
  hover: { exc: "A", spec: { branches: [bp(harmonic(16), 12)], post: [] } },
  tick: { exc: "A", spec: { branches: [bp(harmonic(18), 16)], post: [] } },
  click: { exc: "0.30", spec: { branches: [bp(harmonic(6), 6), bp(harmonic(2), 2.5, -4)], post: [] } },
  "pulse-radio": { exc: "0.30", spec: timbreSpec("radio") },
  "pulse-glass": { exc: "0.30", spec: timbreSpec("glass") },
  "pulse-soft": { exc: "0.30", spec: timbreSpec("soft") },
  "progress-q3": { exc: "0.30", spec: timbreSpec("radio", { coreQ: 3 }) },
  "progress-q6": { exc: "0.30", spec: timbreSpec("radio", { coreQ: 6 }) },
  "progress-q9": { exc: "0.30", spec: timbreSpec("radio", { coreQ: 9 }) },
  "progress-q12": { exc: "0.30", spec: timbreSpec("radio", { coreQ: 12 }) },
};

/** Fester Seed der Anregungen – Puffer und Normierung sind dadurch reproduzierbar. */
export const EXCITATION_SEED = 1919;

/** Die vier Anregungen (excA = nur Impuls) für eine Abtastrate. */
export function makeExcitations(sr: number, seed = EXCITATION_SEED): Record<ExcitationName, Float32Array> {
  const rng = mulberry32(seed);
  const a = new Float32Array(Math.max(1, Math.round(0.004 * sr)));
  a[0] = 1;
  return { A: a, "0.30": makeExcitation(sr, 0.3, rng), "0.15": makeExcitation(sr, 0.15, rng), "0.05": makeExcitation(sr, 0.05, rng) };
}

/** Anregung passend zur Pulsfrequenz (nächstliegende Variante zu noise(f)). */
export const excitationFor = (f: number): ExcitationName => (["0.30", "0.15", "0.05"] as const)[nearestNoiseVariant(noiseShare(f))];

/** Normierung einer Stimme: norm = 1/Spitze der Antwort auf exc0.30 (E.5). */
export function voiceNorm(exc030: Float32Array, timbre: Timbre, sr: number, step: number | null = null): number {
  const p = responsePeak(exc030, timbreSpec(timbre, { step, smootherHz: smootherCutoff(1) }), sr);
  return p > 0 ? 1 / p : 1;
}

/** Index des progress-Puffers für value 0..1 (Kern-Q 3/6/9/12, nächster Wert). */
export function progressBuffer(value: number): BufferName {
  const q = 3 + 9 * clamp(Number.isFinite(value) ? value : 0, 0, 1);
  const qs = [3, 6, 9, 12] as const;
  let best: (typeof qs)[number] = 3;
  for (const c of qs) if (Math.abs(c - q) < Math.abs(best - q)) best = c;
  return `progress-q${best}`;
}

// ---------------------------------------------------------------------------
// Simulation Klickzug ↔ Tonschicht (Prüfung der Formel g_t)
// ---------------------------------------------------------------------------

/** Klickzug: Anregung exc mit Amplitude amp alle 1/f s (auf ganze Samples gerundet). */
export function renderClickTrain(f: number, sr: number, len: number, exc: Float32Array, amp = 1): Float32Array {
  const y = new Float32Array(len);
  const period = sr / f;
  for (let k = 0; ; k++) {
    const n0 = Math.round(k * period);
    if (n0 >= len) break;
    for (let i = 0; i < exc.length && n0 + i < len; i++) y[n0 + i] += amp * exc[i];
  }
  return y;
}

/** Harmonischen-Summe wie die PeriodicWave (real[n] = 1, ohne Normierung) mit Gain g. */
export function renderHarmonicTone(f: number, sr: number, len: number, g: number, nMax = 256): Float32Array {
  const y = new Float32Array(len);
  const top = Math.min(nMax, Math.floor((sr / 2 - 1) / f));
  for (let n = 1; n <= top; n++) {
    const w = (2 * Math.PI * n * f) / sr;
    for (let i = 0; i < len; i++) y[i] += g * Math.cos(w * i);
  }
  return y;
}

// ---------------------------------------------------------------------------
// Pegel-Kalibrierung für Rauschen und RFI (rein, zwischengespeichert)
// ---------------------------------------------------------------------------

const calCache = new Map<string, number>();
let calNoise: { sr: number; data: Float32Array } | null = null;

function calibrationNoise(sr: number): Float32Array {
  if (!calNoise || calNoise.sr !== sr) calNoise = { sr, data: pinkNoise(16384, mulberry32(7)) };
  return calNoise.data;
}

/** RMS von rosa Rauschen (RMS 0,25) hinter einer Filterkette (Zweige parallel, Anteile linear). */
export function filteredNoiseRms(branches: { spec: FilterSpec; share: number }[], sr: number): number {
  const key = `n|${sr}|${branches.map((b) => `${b.spec.type}${b.spec.f.toFixed(1)}/${b.spec.q.toFixed(2)}*${b.share}`).join(",")}`;
  const hit = calCache.get(key);
  if (hit !== undefined) return hit;
  const x = calibrationNoise(sr);
  const sum = new Float32Array(x.length);
  for (const b of branches) {
    const y = filterSignal(x, biquadCoeffs(b.spec.type, b.spec.f, b.spec.q, sr));
    for (let i = 0; i < y.length; i++) sum[i] += b.share * y[i];
  }
  const r = Math.max(1e-6, rmsOf(sum, 2048));
  calCache.set(key, r);
  return r;
}

/** Spitze eines 50-Hz-Sägezahns hinter BP 300 Q 1,2 und LP 900 (für den RFI-Fehlerklang). */
export function rfiPeak(sr: number): number {
  const key = `rfi|${sr}`;
  const hit = calCache.get(key);
  if (hit !== undefined) return hit;
  let y = sawtooth(50, sr, Math.round(0.2 * sr));
  y = filterSignal(y, biquadCoeffs("bandpass", 300, 1.2, sr));
  y = filterSignal(y, biquadCoeffs("lowpass", 900, Q_BUTTER, sr));
  const p = Math.max(1e-6, peakOf(y.subarray(Math.round(0.05 * sr))));
  calCache.set(key, p);
  return p;
}

/** Spitzen-Faktor (Crest) für Rauschen: Spitze ≈ RMS + 12 dB. */
export const NOISE_CREST_DB = 12;
