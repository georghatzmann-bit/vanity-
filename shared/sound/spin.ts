/**
 * SpinModel (F.2): stückweise lineare Frequenzkurve mit exakt integrierter Phase.
 * Eine Takt-Quelle für Bild und Ton – Klicks liegen bei ganzzahliger Phase,
 * die Tonschicht bekommt dieselben Knoten als linearRamp.
 * Rein, ohne Web Audio.
 */

export interface SpinKnot {
  t: number;
  f: number;
  phi: number;
}

export interface SpinPulse {
  t: number;
  index: number;
  f: number;
}

/** Phase am Ort t innerhalb des Segments a → b (Trapez-Integral, exakt für lineare f). */
function segPhase(a: SpinKnot, b: SpinKnot, t: number): number {
  const dt = b.t - a.t;
  const s = t - a.t;
  if (dt <= 0) return a.phi + a.f * s;
  return a.phi + a.f * s + ((b.f - a.f) / (2 * dt)) * s * s;
}

/**
 * Löst φ_a + f_a·s + (f_b − f_a)/(2dt)·s² = n numerisch stabil nach s
 * (f > 0, also streng monotone Phase).
 */
function solveSeg(a: SpinKnot, b: SpinKnot, n: number): number {
  const dt = b.t - a.t;
  const d = n - a.phi;
  const k = dt > 0 ? (b.f - a.f) / (2 * dt) : 0;
  const disc = Math.max(0, a.f * a.f + 4 * k * d);
  const den = a.f + Math.sqrt(disc);
  return den > 0 ? (2 * d) / den : 0;
}

/** Pulse (ganzzahlige Phase) innerhalb [t0, t1) einer Knotenfolge. */
export function pulsesInKnots(knots: readonly SpinKnot[], t0: number, t1: number): SpinPulse[] {
  const out: SpinPulse[] = [];
  if (knots.length < 2 || t1 <= t0) return out;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i];
    const b = knots[i + 1];
    if (b.t <= t0) continue;
    if (a.t >= t1) break;
    const lo = Math.max(t0, a.t);
    const hi = Math.min(t1, b.t);
    if (hi <= lo) continue;
    const pLo = segPhase(a, b, lo);
    const pHi = segPhase(a, b, hi);
    for (let n = Math.ceil(pLo); n < pHi; n++) {
      const t = a.t + solveSeg(a, b, n);
      if (t < lo || t >= hi) continue;
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      out.push({ t, index: n, f: a.f + (b.f - a.f) * u });
    }
  }
  return out;
}

/** Knoten aus einer beliebigen Frequenzfunktion f(t), Abstand dt (für Einzelklänge wie „launch“). */
export function knotsFromFrequency(fn: (t: number) => number, t0: number, t1: number, dt = 0.02, phi0 = 0): SpinKnot[] {
  const knots: SpinKnot[] = [{ t: t0, f: fn(t0), phi: phi0 }];
  const n = Math.max(1, Math.ceil((t1 - t0) / dt - 1e-9));
  for (let i = 1; i <= n; i++) {
    const prev = knots[i - 1];
    const t = Math.min(t1, t0 + i * dt);
    const f = fn(t);
    knots.push({ t, f, phi: prev.phi + ((prev.f + f) / 2) * (t - prev.t) });
  }
  return knots;
}

const LN2 = Math.LN2;
/** Längere Lücken werden ohne Speichern der Zwischenknoten überbrückt. */
const FAST_FORWARD_S = 2;
/** Schutz gegen unbegrenztes Wachstum, wenn niemand prune() aufruft. */
const MAX_KNOTS = 6000;

export class SpinModel {
  readonly dt: number;
  private knots: SpinKnot[];
  private lnTarget: number;
  private tauS = 0.6;
  private maxOctPerS = 2;

  constructor(o: { t0: number; f0: number; phi0?: number; dt?: number }) {
    this.dt = o.dt ?? 0.02;
    const f0 = Math.max(1e-6, o.f0);
    this.knots = [{ t: o.t0, f: f0, phi: o.phi0 ?? 0 }];
    this.lnTarget = Math.log(f0);
  }

  /** Zielfrequenz und Regelgesetz; wirkt auf alle noch nicht erzeugten Knoten. */
  setTarget(o: { f: number; tauS?: number; maxOctPerS?: number }): void {
    this.lnTarget = Math.log(Math.max(1e-6, o.f));
    this.tauS = Math.max(1e-4, o.tauS ?? 0.6);
    this.maxOctPerS = Math.max(0, o.maxOctPerS ?? 2);
  }

  get targetF(): number {
    return Math.exp(this.lnTarget);
  }

  get lastKnot(): SpinKnot {
    return this.knots[this.knots.length - 1];
  }

  get firstKnot(): SpinKnot {
    return this.knots[0];
  }

  private step(k: SpinKnot): SpinKnot {
    const dt = this.dt;
    const lnF = Math.log(k.f);
    let d = (this.lnTarget - lnF) * (1 - Math.exp(-dt / this.tauS));
    const lim = LN2 * this.maxOctPerS * dt;
    if (d > lim) d = lim;
    else if (d < -lim) d = -lim;
    const f = Math.exp(lnF + d);
    return { t: k.t + dt, f, phi: k.phi + ((k.f + f) / 2) * dt };
  }

  /** Erzeugt Knoten bis einschließlich des ersten Knotens ≥ until. Bereits erzeugte bleiben unverändert. */
  advance(until: number): SpinKnot[] {
    const created: SpinKnot[] = [];
    let last = this.lastKnot;
    if (until - last.t > FAST_FORWARD_S) {
      // Lange Lücke (z. B. verborgenes Fenster): ohne Zwischenknoten überspringen.
      while (until - last.t > FAST_FORWARD_S / 2) last = this.step(last);
      this.knots = [last];
      created.push(last);
    }
    while (last.t < until) {
      last = this.step(last);
      this.knots.push(last);
      created.push(last);
    }
    if (this.knots.length > MAX_KNOTS) this.knots.splice(0, this.knots.length - MAX_KNOTS / 2);
    return created;
  }

  /** Index des Segments [k_i, k_i+1], das t enthält (oder -1 vor dem ersten Knoten). */
  private segIndex(t: number): number {
    const k = this.knots;
    if (t < k[0].t) return -1;
    let lo = 0;
    let hi = k.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (k[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  private ensure(t: number) {
    if (t > this.lastKnot.t) this.advance(t);
  }

  /** Frequenz bei t, linear zwischen den Knoten. */
  freqAt(t: number): number {
    this.ensure(t);
    const i = this.segIndex(t);
    if (i < 0) return this.knots[0].f;
    const a = this.knots[i];
    const b = this.knots[i + 1];
    if (!b) return a.f;
    return a.f + ((b.f - a.f) * (t - a.t)) / (b.t - a.t);
  }

  /** Phase (in Umdrehungen) bei t. */
  phaseAt(t: number): number {
    this.ensure(t);
    const i = this.segIndex(t);
    const k0 = this.knots[0];
    if (i < 0) return k0.phi + k0.f * (t - k0.t);
    const a = this.knots[i];
    const b = this.knots[i + 1];
    if (!b) return a.phi + a.f * (t - a.t);
    return segPhase(a, b, t);
  }

  /** Pulse bei ganzzahliger Phase in [t0, t1). */
  pulsesBetween(t0: number, t1: number): SpinPulse[] {
    this.ensure(t1);
    return pulsesInKnots(this.knots, t0, t1);
  }

  /** Alle Knoten mit k.t > t. */
  knotsSince(t: number): SpinKnot[] {
    const i = this.segIndex(t);
    return this.knots.slice(Math.max(0, i + 1)).filter((k) => k.t > t);
  }

  /** Entfernt Knoten vor `before`, behält aber den Knoten davor (Stetigkeit). */
  prune(before: number): void {
    const i = this.segIndex(before);
    if (i > 0) this.knots.splice(0, i);
  }
}
