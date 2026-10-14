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

/** Index des Segments [k_i, k_i+1], das t enthält (−1 vor dem ersten Knoten). */
function findSeg(knots: readonly SpinKnot[], t: number): number {
  if (knots.length === 0 || t < knots[0].t) return -1;
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Pulse (ganzzahlige Phase) innerhalb [t0, t1) einer Knotenfolge. */
export function pulsesInKnots(knots: readonly SpinKnot[], t0: number, t1: number): SpinPulse[] {
  const out: SpinPulse[] = [];
  if (knots.length < 2 || t1 <= t0) return out;
  for (let i = Math.max(0, findSeg(knots, t0)); i < knots.length - 1; i++) {
    const a = knots[i];
    const b = knots[i + 1];
    if (b.t <= t0) continue;
    if (a.t >= t1) break;
    const lo = Math.max(t0, a.t);
    const hi = Math.min(t1, b.t);
    if (hi <= lo) continue;
    // An Knoten exakt die gespeicherte Phase verwenden – so gehört jede ganze Zahl genau
    // einem Segment (keine verlorenen oder doppelten Pulse auf Knotengrenzen).
    const pLo = lo === a.t ? a.phi : segPhase(a, b, lo);
    const pHi = hi === b.t ? b.phi : segPhase(a, b, hi);
    for (let n = Math.ceil(pLo); n < pHi; n++) {
      const t = Math.min(Math.max(a.t + solveSeg(a, b, n), lo), Math.max(lo, hi - 1e-12));
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

/** Was eine Stimme von einer Drehquelle braucht (SpinModel oder feste Knotenspur). */
export interface SpinSource {
  advance(until: number): SpinKnot[];
  freqAt(t: number): number;
  phaseAt(t: number): number;
  pulsesBetween(t0: number, t1: number): SpinPulse[];
  knotsSince(t: number): SpinKnot[];
}

/** Feste, vorab berechnete Knotenspur (Einzelklänge „launch“, „achievement“). Nach dem letzten Knoten konstant. */
export class KnotTrack implements SpinSource {
  constructor(readonly knots: readonly SpinKnot[]) {
    if (knots.length === 0) throw new RangeError("KnotTrack braucht Knoten");
  }
  get start(): number {
    return this.knots[0].t;
  }
  get end(): number {
    return this.knots[this.knots.length - 1].t;
  }
  advance(): SpinKnot[] {
    return [];
  }
  freqAt(t: number): number {
    const k = this.knots;
    const i = findSeg(k, t);
    if (i < 0) return k[0].f;
    const a = k[i];
    const b = k[i + 1];
    return b ? a.f + ((b.f - a.f) * (t - a.t)) / (b.t - a.t) : a.f;
  }
  phaseAt(t: number): number {
    const k = this.knots;
    const i = findSeg(k, t);
    if (i < 0) return k[0].phi + k[0].f * (t - k[0].t);
    const a = k[i];
    const b = k[i + 1];
    return b ? segPhase(a, b, t) : a.phi + a.f * (t - a.t);
  }
  pulsesBetween(t0: number, t1: number): SpinPulse[] {
    return pulsesInKnots(this.knots, t0, t1);
  }
  knotsSince(t: number): SpinKnot[] {
    return this.knots.filter((k) => k.t > t);
  }
}

const LN2 = Math.LN2;
/** Schutz gegen unbegrenztes Wachstum, wenn niemand prune() aufruft (≈ 2 min bei 20 ms). */
const MAX_KNOTS = 6000;

export class SpinModel implements SpinSource {
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
    return findSeg(this.knots, t);
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

/**
 * Hochdrehen als feste Spur: P(u) = P₀·(P₁/P₀)^(u^shape), u = 0…1 über durS,
 * danach holdS konstant bei P₁. Der erste Puls liegt genau bei t0 (Phase 0).
 */
export function spinUpTrack(o: { t0: number; p0: number; p1: number; durS: number; shape?: number; holdS?: number; dt?: number }): KnotTrack {
  const shape = o.shape ?? 1.6;
  const end = o.t0 + o.durS;
  const fn = (t: number): number => {
    const u = Math.min(1, Math.max(0, (t - o.t0) / o.durS));
    return 1 / (o.p0 * Math.pow(o.p1 / o.p0, Math.pow(u, shape)));
  };
  return new KnotTrack(knotsFromFrequency(fn, o.t0, end + (o.holdS ?? 0), o.dt ?? 0.005, 0));
}
