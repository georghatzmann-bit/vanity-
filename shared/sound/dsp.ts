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

/** Stereo-Impulsantwort „Kuppel“: 12 ms Vorverzögerung, e^(−t/0,16 s), HP 250 Hz, LP 5 kHz. */
export function makeReverbIR(sr: number, rng: Rng, seconds = 0.8): [Float32Array, Float32Array] {
  const len = Math.round(seconds * sr);
  const pre = Math.round(0.012 * sr);
  const ch = (): Float32Array => {
    const x = new Float32Array(len);
    for (let i = pre; i < len; i++) x[i] = gaussian(rng) * Math.exp(-(i - pre) / sr / 0.16);
    return onePole(onePole(x, 250, sr, true), 5000, sr, false);
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
