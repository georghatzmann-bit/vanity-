/**
 * Uhr und Synchronisation (E.3).
 * Modellzeit = performance.now()/1000 – Takt-Master für Bild und Ton, springt nie.
 * Audio wird über einen geglätteten Offset darauf abgebildet: ctxTime = T + offset.
 */

export interface AudioClock {
  /** Modellzeit in s */
  now(): number;
  /** Kontext läuft und die Audiozeit wächst (Wachhund) */
  readonly healthy: boolean;
  /** Kontextzeit für Modellzeit t (null ohne Kontext) */
  ctxTimeFor(t: number): number | null;
  /** Modellzeit für Kontextzeit t (null ohne Kontext) */
  modelTimeFor(t: number): number | null;
}

/** Was die Uhr vom AudioContext liest (Teilmenge, damit Tests einen Fake einsetzen können). */
export interface ClockContext {
  readonly currentTime: number;
  readonly state: string;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
}

/** EMA-Glättung pro Scheduler-Takt */
export const OFFSET_ALPHA = 0.1;
/** höchstens 0,5 ms Änderung pro Takt */
export const OFFSET_MAX_STEP = 0.0005;
/** Sprung > 50 ms → neu verankern */
export const OFFSET_REANCHOR = 0.05;
/** Wachhund: Audiozeit muss mit ≥ 40 % der Echtzeit wachsen (0,1 s pro 0,25 s). */
export const MIN_RATE = 0.4;

export const defaultNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() / 1000 : Date.now() / 1000;

export class EngineClock implements AudioClock {
  private ctx: ClockContext | null = null;
  private offset = 0;
  private stalled = false;
  private last: { ct: number; pt: number } | null = null;

  constructor(private readonly nowFn: () => number = defaultNow) {}

  now(): number {
    return this.nowFn();
  }

  get attached(): boolean {
    return this.ctx !== null;
  }

  get healthy(): boolean {
    return this.ctx !== null && this.ctx.state === "running" && !this.stalled;
  }

  /** aktueller (geglätteter) Offset in s */
  get currentOffset(): number {
    return this.offset;
  }

  ctxTimeFor(t: number): number | null {
    return this.ctx ? t + this.offset : null;
  }

  modelTimeFor(t: number): number | null {
    return this.ctx ? t - this.offset : null;
  }

  attach(ctx: ClockContext | null): void {
    this.ctx = ctx;
    this.stalled = false;
    this.last = null;
    const raw = this.rawOffset();
    if (raw !== null) this.offset = raw;
  }

  /** Roh-Offset: getOutputTimestamp (enthält die Ausgabelatenz), sonst currentTime − now − Latenz. */
  rawOffset(): number | null {
    const c = this.ctx;
    if (!c) return null;
    try {
      const ts = c.getOutputTimestamp?.();
      if (ts && typeof ts.contextTime === "number" && typeof ts.performanceTime === "number" && ts.performanceTime > 0 && ts.contextTime > 0) {
        return ts.contextTime - ts.performanceTime / 1000;
      }
    } catch {
      /* Ersatz unten */
    }
    return c.currentTime - this.now() - (c.outputLatency || c.baseLatency || 0);
  }

  /** Pro Scheduler-Takt: EMA α 0,1, Schritt ≤ 0,5 ms; Sprung > 50 ms → neu verankern. */
  update(): void {
    const raw = this.rawOffset();
    if (raw === null || !Number.isFinite(raw)) return;
    const d = raw - this.offset;
    if (Math.abs(d) > OFFSET_REANCHOR) {
      this.offset = raw;
      return;
    }
    const step = Math.max(-OFFSET_MAX_STEP, Math.min(OFFSET_MAX_STEP, d * OFFSET_ALPHA));
    this.offset += step;
  }

  /**
   * Wachhund: 250 ms nach ensure() und danach jede Sekunde aufrufen.
   * Gibt zurück, ob sich `healthy` geändert hat.
   */
  check(): boolean {
    const before = this.healthy;
    const c = this.ctx;
    if (!c) return before !== this.healthy;
    const ct = c.currentTime;
    const pt = this.now();
    if (c.state !== "running") {
      this.stalled = true;
    } else if (this.last && pt - this.last.pt > 0.05) {
      this.stalled = (ct - this.last.ct) / (pt - this.last.pt) < MIN_RATE;
    }
    this.last = { ct, pt };
    return before !== this.healthy;
  }
}
