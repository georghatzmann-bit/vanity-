/**
 * Pulsar-Sonifikation – Fassade der Klang-Engine (E.10).
 * Alles live per Web Audio, keine Dateien, kein AudioWorklet. Ein Grundton F_STAR = 173,7016 Hz,
 * Tonhöhen nur als dessen Harmonische, keine Melodien. Der Kontext entsteht lazy in ensure().
 * Jede Methode ist abgesichert: Ohne Kontext gibt es stumme Objekte mit identischer API.
 */
import { EngineClock, defaultNow } from "./clock";
import {
  Q_BUTTER,
  clamp,
  dbToGain,
  dispersionCurve,
  filteredNoiseRms,
  harmonic,
  rfiPeak,
  type BufferName,
  type Rng,
  type Timbre,
} from "./dsp";
import { bedRms, buildGraph, disconnectAll, makeFilter, makeGain, sendToReverb, snapToSample, stopSafe, type Graph } from "./graph";
import { RECIPES, CHORD_ATTACKS_S, CHORD_HOLD_S, CHORD_LEVELS_DB, CHORD_PARTIALS, CHORD_TAU_S, renderRecipe, type RecipeTarget, type SoundName } from "./recipes";
import { spinUpTrack } from "./spin";
import { ScheduledPulseVoice, SilentPulseVoice, rampParam, type PulseVoice, type PulseVoiceOptions, type VoiceHost } from "./voice";

export type { SoundName } from "./recipes";
export type { AudioClock } from "./clock";
export type { Timbre } from "./dsp";
export type { PulseVoice, PulseVoiceOptions, PulseEvent } from "./voice";
export { F_STAR } from "./dsp";

export interface PlayOptions {
  /** 0..1, z. B. Fortschritt für "progress" */
  value?: number;
  /** Lautstärke-Faktor nur für diesen Aufruf */
  gain?: number;
  /** Modellzeit in s (sound.clock.now()); fehlt = sofort */
  at?: number;
}

export interface SweepOptions {
  fHi: number;
  fLo: number;
  durS: number;
  gainDb: number;
  noiseShare?: number;
  reverb?: boolean;
  at?: number;
}

export interface ChordOptions {
  partials?: number[];
  levelsDb?: number[];
  attacksS?: number[];
  holdS?: number;
  releaseTauS?: number;
  gainDb?: number;
  reverb?: boolean;
  at?: number;
}

export interface ChordHandle {
  release(o?: { tauS?: number; at?: number }): void;
}

export interface NoiseBed {
  set(o: { levelDb: number; centerHz?: number; q?: number; glideS?: number; at?: number }): void;
  /** Kurve für die Bandpass-Mitte */
  follow(centerHz: Float32Array, o: { at: number; durS: number }): void;
  stop(o?: { fadeS?: number }): void;
}

export interface ScoreEvent {
  /** s relativ zu t0 */
  at: number;
  run: (atModel: number) => void;
  /**
   * Zustandssetzend (Rauschbett an, Kurve, Lock, Stopp): verspätet (bis CATCHUP_MAX_S) trotzdem
   * sofort ausführen statt überspringen. Pulse/Klicks ohne `catchUp` werden weiter verworfen.
   */
  catchUp?: boolean;
}

export interface ScoreHandle {
  /** stoppt alle in run() erzeugten Quellen */
  cancel(o?: { fadeS?: number }): void;
}

/** Abhängigkeiten (für Tests austauschbar). */
export interface EngineDeps {
  createContext?: () => AudioContext | null;
  now?: () => number;
  timers?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (h: unknown) => void;
    setTimeout: (fn: () => void, ms: number) => unknown;
  };
  doc?: { readonly hidden: boolean; addEventListener(type: string, fn: () => void): void } | null;
  win?: { addEventListener(type: string, fn: () => void, o?: AddEventListenerOptions): void } | null;
  random?: Rng;
}

/** Verspätete `catchUp`-Ereignisse werden bis zu diesem Alter (s) nachgeholt */
export const CATCHUP_MAX_S = 3;
/** Ohne `catchUp`: älter als das → übersprungen (kein Nachhol-Burst) */
const LATE_DROP_S = 0.25;

/** Scheduler-Takt und Lookahead (E.4) */
export const TICK_MS = 25;
export const LOOKAHEAD_S = 0.12;
export const MAX_VOICES = 4;
/** Hall-Sends */
const SEND_DB = -18;
const CHORD_SEND_DB = -12;

interface Tracked {
  stop(fadeS: number): void;
  /** geplante Startzeit (AudioContext-Zeit) */
  startCt?: number;
  /** sofort stoppen und trennen (noch nicht klingende Quelle) */
  kill?(): void;
}

function defaultCreateContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AC ? new AC({ latencyHint: "interactive" }) : null;
}

const defaultTimers = (): NonNullable<EngineDeps["timers"]> => ({
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
});

class Score {
  private idx = 0;
  readonly tracked: Tracked[] = [];
  private readonly events: ScoreEvent[];

  constructor(
    events: ScoreEvent[],
    private readonly t0: number,
  ) {
    this.events = events.filter((e) => e && Number.isFinite(e.at) && typeof e.run === "function").sort((a, b) => a.at - b.at);
  }

  get done(): boolean {
    return this.idx >= this.events.length;
  }

  /**
   * Führt fällige Ereignisse aus. Deutlich verpasste (verborgenes Fenster) werden ohne Nachhol-Burst
   * übersprungen – außer zustandssetzende (`catchUp`, bis 3 s alt): die laufen sofort mit t = now.
   */
  runDue(horizon: number, now: number, capture: (list: Tracked[] | null) => void): void {
    while (this.idx < this.events.length) {
      const e = this.events[this.idx];
      let t = this.t0 + e.at;
      if (t > horizon) break;
      this.idx++;
      if (t < now - LATE_DROP_S) {
        if (!e.catchUp || t < now - CATCHUP_MAX_S) continue;
        t = now;
      }
      capture(this.tracked);
      try {
        e.run(t);
      } catch {
        /* Partitur darf nicht abbrechen */
      } finally {
        capture(null);
      }
    }
  }

  /**
   * Stoppt alles. Quellen, die noch gar nicht klingen (Startzeit > nowCt), sofort hart stoppen und
   * trennen – sonst setzt ein geplanter Puls 20 ms nach der Quittung ein (Doppelklick beim Überspringen).
   */
  cancel(fadeS: number, nowCt: number | null = null): void {
    this.idx = this.events.length;
    for (const t of this.tracked.splice(0)) {
      try {
        if (nowCt !== null && t.kill && t.startCt !== undefined && t.startCt > nowCt) t.kill();
        else t.stop(fadeS);
      } catch {
        /* ignorieren */
      }
    }
  }
}

class NoiseBedImpl implements NoiseBed {
  private want: { levelDb: number; centerHz: number; q: number } | null = null;
  private hidden = false;
  private n: { g: Graph; src: AudioBufferSourceNode; bp: BiquadFilterNode; lp: BiquadFilterNode; bpG: GainNode; lpG: GainNode; level: GainNode } | null = null;
  private gen = 0;

  constructor(private readonly eng: SoundEngine) {}

  get running(): boolean {
    return this.n !== null;
  }

  set(o: { levelDb: number; centerHz?: number; q?: number; glideS?: number; at?: number }): void {
    try {
      const levelDb = typeof o.levelDb === "number" ? o.levelDb : -60;
      const centerHz = clamp(o.centerHz ?? this.want?.centerHz ?? harmonic(6), 20, 16000);
      const q = clamp(o.q ?? this.want?.q ?? 0.7, 0.05, 40);
      this.want = { levelDb, centerHz, q };
      const g = this.eng.audibleGraph();
      if (!g) return;
      const fresh = !this.n || this.n.g !== g;
      const n = this.ensure(g);
      this.gen++;
      const ct = this.eng.ctAt(o.at);
      const glide = Math.max(0.005, o.glideS ?? (fresh ? 0.3 : 0.05));
      rampExp(n.bp.frequency, centerHz, ct, glide);
      rampParam(n.bp.Q, q, ct, glide);
      rampParam(n.level.gain, this.target(g), ct, glide);
    } catch {
      /* ignorieren */
    }
  }

  follow(centerHz: Float32Array, o: { at: number; durS: number }): void {
    try {
      if (!centerHz || centerHz.length < 2 || !(o.durS > 0)) return;
      if (this.want) this.want.centerHz = centerHz[centerHz.length - 1];
      let n = this.n;
      // Bett fehlt (z. B. verspätetes noise-in), Wunsch ist aber gesetzt: aus dem Wunsch anlegen
      if (!n && this.want) {
        this.set({ ...this.want, glideS: 0.05, at: o.at });
        n = this.n;
      }
      if (!n) return;
      const ct = this.eng.ctAt(o.at);
      n.bp.frequency.cancelScheduledValues(ct);
      n.bp.frequency.setValueCurveAtTime(centerHz, ct, o.durS);
    } catch {
      /* ignorieren */
    }
  }

  stop(o: { fadeS?: number } = {}): void {
    this.want = null;
    this.release(Math.max(0.005, o.fadeS ?? 0.3));
  }

  /** Stumm/unhörbar: Knoten weg, Wunschzustand bleibt. */
  suspend(): void {
    this.release(0.03);
  }

  /** Wieder hörbar: Wunschzustand neu aufbauen. */
  resume(): void {
    if (this.want && !this.n) this.set({ ...this.want, glideS: 0.3 });
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    const n = this.n;
    if (n) rampParam(n.level.gain, h ? 0 : this.target(n.g), n.g.ctx.currentTime, h ? 0.3 : 0.1);
  }

  private target(g: Graph): number {
    if (!this.want || this.hidden) return 0;
    return dbToGain(this.want.levelDb) / bedRms(g.sr, this.want.centerHz, this.want.q);
  }

  private ensure(g: Graph): NonNullable<NoiseBedImpl["n"]> {
    if (this.n && this.n.g === g) return this.n;
    this.teardown();
    const ctx = g.ctx;
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.loop = true;
    const bp = makeFilter(ctx, { type: "bandpass", f: this.want?.centerHz ?? 1000, q: this.want?.q ?? 0.7 });
    const lp = makeFilter(ctx, { type: "lowpass", f: 900, q: Q_BUTTER });
    const bpG = makeGain(ctx, 0.7);
    const lpG = makeGain(ctx, 0.3);
    const level = makeGain(ctx, 0);
    src.connect(bp);
    bp.connect(bpG);
    bpG.connect(level);
    src.connect(lp);
    lp.connect(lpG);
    lpG.connect(level);
    level.connect(g.bedBus);
    src.start(ctx.currentTime, this.eng.random() * 3.5);
    this.n = { g, src, bp, lp, bpG, lpG, level };
    return this.n;
  }

  private release(fadeS: number): void {
    const n = this.n;
    if (!n) return;
    const ct = n.g.ctx.currentTime;
    rampParam(n.level.gain, 0, ct, fadeS);
    const my = ++this.gen;
    this.eng.later((fadeS + 0.05) * 1000, () => {
      if (this.gen === my && this.n === n) this.teardown();
    });
  }

  private teardown(): void {
    const n = this.n;
    if (!n) return;
    this.n = null;
    stopSafe(n.src);
    disconnectAll([n.src, n.bp, n.lp, n.bpG, n.lpG, n.level]);
  }
}

function rampExp(p: AudioParam, target: number, at: number, dur: number): void {
  try {
    p.cancelScheduledValues(at);
    p.setValueAtTime(Math.max(1, p.value), at);
    p.exponentialRampToValueAtTime(Math.max(1, target), at + dur);
  } catch {
    /* ignorieren */
  }
}

const SILENT_CHORD: ChordHandle = { release: () => undefined };
const SILENT_SCORE: ScoreHandle = { cancel: () => undefined };

export class SoundEngine {
  readonly clock: EngineClock;
  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  private lastFail = -Infinity;
  private _volume = 0.6;
  private _muted = false;
  private _hoverEnabled = true;
  private readonly lastPlayed = new Map<SoundName, number>();
  private readonly voices = new Set<ScheduledPulseVoice>();
  private readonly scores = new Set<Score>();
  private timer: unknown = null;
  private tickQueued = false;
  private watchdog: unknown = null;
  private unlockBound = false;
  private visBound = false;
  private hidden = false;
  private capture: Tracked[] | null = null;
  private readonly availCbs = new Set<(a: boolean) => void>();
  private lastAvailable = false;
  private bed: NoiseBedImpl | null = null;
  private readonly deps: EngineDeps;
  private readonly timers: NonNullable<EngineDeps["timers"]>;
  readonly random: Rng;
  private readonly host: VoiceHost;
  private readonly target: RecipeTarget;

  constructor(deps: EngineDeps = {}) {
    this.deps = deps;
    this.clock = new EngineClock(deps.now ?? defaultNow);
    this.timers = deps.timers ?? defaultTimers();
    this.random = deps.random ?? Math.random;
    this.host = {
      clock: this.clock,
      audibleGraph: () => this.audibleGraph(),
      wake: () => this.wake(),
      release: (v) => {
        this.voices.delete(v);
      },
      later: (ms, fn) => this.later(ms, fn),
    };
    this.target = this.makeTarget();
  }

  // ------------------------------------------------------------ bestehende API

  get volume(): number {
    return this._volume;
  }
  get muted(): boolean {
    return this._muted;
  }
  get hoverEnabled(): boolean {
    return this._hoverEnabled;
  }

  setVolume(v: number): void {
    try {
      const before = this.audibleGraph() !== null;
      this._volume = clamp(Number.isFinite(v) ? v : 0, 0, 1);
      this.applyMaster();
      this.audibilityChanged(before);
    } catch {
      /* ignorieren */
    }
  }

  setMuted(m: boolean): void {
    try {
      const before = this.audibleGraph() !== null;
      this._muted = !!m;
      this.applyMaster();
      this.audibilityChanged(before);
    } catch {
      /* ignorieren */
    }
  }

  setHoverEnabled(h: boolean): void {
    this._hoverEnabled = !!h;
  }

  /** Bereitet Audio vor (Kontext, Graph, Puffer, Normierung), ohne einen Ton zu spielen. */
  warmup(): void {
    try {
      this.ensure();
    } catch {
      /* ignorieren */
    }
  }

  play(name: SoundName, opts: PlayOptions = {}): void {
    try {
      if (this._muted || this._volume <= 0) return;
      if (!(name in RECIPES)) return;
      if (name === "hover" && !this._hoverEnabled) return;
      const ctx = this.ensure();
      if (!ctx || !this.audibleGraph()) return;
      const r = RECIPES[name] as { lockMs?: number };
      if (r.lockMs) {
        const now = this.clock.now();
        const last = this.lastPlayed.get(name);
        if (last !== undefined && (now - last) * 1000 < r.lockMs) return;
        this.lastPlayed.set(name, now);
      }
      const t0 = this.startTime(opts.at);
      renderRecipe(this.target, name, t0, opts, this.random);
    } catch {
      /* Audio blockiert nie */
    }
  }

  // ------------------------------------------------------------ neue API

  get available(): boolean {
    return this.ctx !== null && this.clock.healthy;
  }

  onAvailabilityChange(cb: (available: boolean) => void): () => void {
    this.availCbs.add(cb);
    return () => {
      this.availCbs.delete(cb);
    };
  }

  /** Einzelpuls (vorgerendert). */
  pulse(o: { timbre?: Timbre; gainDb?: number; at?: number; pan?: number; reverb?: boolean } = {}): void {
    try {
      if (!this.prepared()) return;
      const timbre: Timbre = o.timbre === "glass" || o.timbre === "soft" ? o.timbre : "radio";
      this.target.buffer(`pulse-${timbre}`, this.startTime(o.at), dbToGain(o.gainDb ?? -14), o.reverb ?? false);
    } catch {
      /* ignorieren */
    }
  }

  /** Höchstens 4 Stimmen; danach stumme Stimme + console.warn. */
  createVoice(o: PulseVoiceOptions = {}): PulseVoice {
    try {
      if (this.voices.size >= MAX_VOICES) {
        console.warn(`[sound] höchstens ${MAX_VOICES} PulseVoices – stumme Stimme zurückgegeben`);
        return new SilentPulseVoice(o);
      }
      this.ensure();
      const v = new ScheduledPulseVoice(this.host, o);
      this.voices.add(v);
      return v;
    } catch {
      return new SilentPulseVoice(o);
    }
  }

  /** Eine gemeinsame Instanz. */
  noiseBed(): NoiseBed {
    if (!this.bed) this.bed = new NoiseBedImpl(this);
    try {
      this.ensure();
    } catch {
      /* ignorieren */
    }
    return this.bed;
  }

  /** Dispersions-Sweep (E.7). Wirft RangeError, wenn fHi ≤ fLo. */
  sweep(o: SweepOptions): void {
    if (!o || !(o.fHi > o.fLo) || !(o.fLo > 0)) throw new RangeError(`Sweep muss fallen: fHi ${o?.fHi} ≤ fLo ${o?.fLo}`);
    try {
      if (!this.prepared()) return;
      this.target.sweep({ at: this.startTime(o.at), fHi: o.fHi, fLo: o.fLo, durS: o.durS, gain: dbToGain(o.gainDb), noiseShare: o.noiseShare, reverb: o.reverb ?? true });
    } catch {
      /* ignorieren */
    }
  }

  /** Standard = Abschluss-Akkord (E.8): Obertöne des Endtons, gleichzeitig. */
  chord(o: ChordOptions = {}): ChordHandle {
    try {
      if (!this.prepared()) return SILENT_CHORD;
      const g = this.g as Graph;
      const partials = o.partials ?? [...CHORD_PARTIALS];
      const levels = o.levelsDb ?? [...CHORD_LEVELS_DB];
      const attacks = o.attacksS ?? [...CHORD_ATTACKS_S];
      const hold = o.holdS ?? CHORD_HOLD_S;
      const tau = o.releaseTauS ?? CHORD_TAU_S;
      const at = this.startTime(o.at);
      const parts = partials.map((n, i) =>
        this.partialNodes(g, {
          f: harmonic(n),
          at,
          gain: dbToGain((levels[i] ?? -50) + (o.gainDb ?? 0)),
          attackS: attacks[i] ?? 0.6,
          holdS: hold,
          tauS: tau,
          reverb: o.reverb ?? true,
        }),
      );
      const handle: ChordHandle = {
        release: (r = {}) => {
          try {
            const ct = this.ctAt(r.at);
            const tauS = Math.max(0.005, r.tauS ?? tau);
            for (const p of parts) {
              if (!p) continue;
              p.gain.gain.cancelScheduledValues(ct);
              p.gain.gain.setTargetAtTime(0, ct, tauS);
              stopSafe(p.osc, ct + 7 * tauS);
            }
          } catch {
            /* ignorieren */
          }
        },
      };
      return handle;
    } catch {
      return SILENT_CHORD;
    }
  }

  /** „Einzelton“ für den Warnton: 694,81 Hz + 1389,61 Hz (−12 dB), Anstieg 15 ms, τ 120 ms; Spitze = level × −20 dBFS. */
  alertTone(level: number, o: { at?: number } = {}): void {
    try {
      if (!this.prepared()) return;
      const g = this.g as Graph;
      const peak = clamp(Number.isFinite(level) ? level : 0, 0, 1) * dbToGain(-20);
      if (peak <= 0) return;
      const ctx = g.ctx;
      const ct = this.ctAt(this.startTime(o.at));
      const env = makeGain(ctx, 0);
      const k = peak / (1 + dbToGain(-12));
      const oscs = [
        { f: harmonic(4), g: 1 },
        { f: harmonic(8), g: dbToGain(-12) },
      ].map(({ f, g: lv }) => {
        const osc = ctx.createOscillator();
        osc.frequency.value = f;
        const pg = makeGain(ctx, lv);
        osc.connect(pg);
        pg.connect(env);
        return { osc, pg };
      });
      env.connect(g.uiBus);
      env.gain.setValueAtTime(0, ct);
      env.gain.linearRampToValueAtTime(k, ct + 0.015);
      env.gain.setTargetAtTime(0, ct + 0.015, 0.12);
      const end = ct + 0.015 + 0.12 * 8;
      for (const x of oscs) {
        x.osc.start(ct);
        x.osc.stop(end);
      }
      oscs[0].osc.onended = () => disconnectAll([...oscs.flatMap((x) => [x.osc, x.pg]), env]);
      this.track({
        startCt: ct,
        kill: () => {
          for (const x of oscs) stopSafe(x.osc, 0);
          disconnectAll([...oscs.flatMap((x) => [x.osc, x.pg]), env]);
        },
        stop: (f) => {
          const now = ctx.currentTime;
          rampParam(env.gain, 0, now, f);
          for (const x of oscs) stopSafe(x.osc, now + f + 0.01);
        },
      });
    } catch {
      /* ignorieren */
    }
  }

  /** Partitur in Modellzeit (Intro): Ereignisse laufen über den Scheduler (Lookahead 0,12 s). */
  score(events: ScoreEvent[], t0Model: number): ScoreHandle {
    try {
      const s = new Score(Array.isArray(events) ? events : [], Number.isFinite(t0Model) ? t0Model : this.clock.now());
      this.scores.add(s);
      this.wake();
      return {
        cancel: (o = {}) => {
          s.cancel(Math.max(0.005, o.fadeS ?? 0.04), this.ctx ? this.ctx.currentTime : null);
          this.scores.delete(s);
        },
      };
    } catch {
      return SILENT_SCORE;
    }
  }

  // ------------------------------------------------------------ intern (auch für Stimmen/Rauschbett)

  /** Graph, wenn hörbare Knoten erzeugt werden dürfen. */
  audibleGraph(): Graph | null {
    if (!this.g || !this.clock.healthy || this._muted || this._volume <= 0 || this.hidden) return null;
    return this.g;
  }

  /** Kontextzeit für Modellzeit at (fehlt = sofort), nie in der Vergangenheit. */
  ctAt(at?: number): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const now = ctx.currentTime;
    if (at === undefined || !Number.isFinite(at)) return now;
    const c = this.clock.ctxTimeFor(at);
    return c === null ? now : Math.max(now, c);
  }

  later(ms: number, fn: () => void): void {
    try {
      this.timers.setTimeout(() => {
        try {
          fn();
        } catch {
          /* ignorieren */
        }
      }, Math.max(0, ms));
    } catch {
      /* ignorieren */
    }
  }

  /** Klanglabor: AnalyserNode an der Summe vor dem Master (Spitze/RMS in dBFS). */
  createAnalyser(fftSize = 8192): AnalyserNode | null {
    try {
      if (!this.ensure() || !this.g) return null;
      const an = this.g.ctx.createAnalyser();
      an.fftSize = fftSize;
      this.g.sum.connect(an);
      return an;
    } catch {
      return null;
    }
  }

  /** Testhilfe: ein Scheduler-Takt sofort. */
  tickNow(): void {
    this.tick();
  }

  /** Testhilfe: Zahl registrierter (nicht freigegebener) Stimmen. */
  get voiceCount(): number {
    return this.voices.size;
  }

  private prepared(): boolean {
    if (this._muted || this._volume <= 0) return false;
    return this.ensure() !== null && this.audibleGraph() !== null;
  }

  /** Modellzeit für „jetzt“ bzw. at – so bleiben Abstände innerhalb eines Rezepts exakt. */
  private startTime(at?: number): number {
    if (at !== undefined && Number.isFinite(at)) return at;
    const ctx = this.ctx;
    const m = ctx ? this.clock.modelTimeFor(ctx.currentTime) : null;
    return m ?? this.clock.now();
  }

  private track(t: Tracked): void {
    this.capture?.push(t);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume?.().catch(() => undefined);
      return this.ctx;
    }
    const now = this.clock.now();
    if (now - this.lastFail < 2) return null;
    let ctx: AudioContext | null = null;
    try {
      ctx = this.deps.createContext ? this.deps.createContext() : defaultCreateContext();
      if (!ctx) {
        this.lastFail = now;
        return null;
      }
      this.g = buildGraph(ctx);
      this.ctx = ctx;
      // Kalibrierungen vorwärmen (sonst rechnet der erste Fehlerklang sie synchron – Long Task, Knack)
      try {
        rfiPeak(this.g.sr);
        filteredNoiseRms([{ spec: { type: "bandpass", f: 1000, q: 18 }, share: 1 }], this.g.sr);
      } catch {
        /* nur Vorwärmen */
      }
      this.clock.attach(ctx);
      this.applyMaster();
      this.bindUnlock();
      this.bindVisibility();
      this.startWatchdog();
      try {
        ctx.addEventListener?.("statechange", () => this.later(250, () => this.checkHealth()));
      } catch {
        /* ignorieren */
      }
      if (ctx.state === "suspended") void ctx.resume?.().catch(() => undefined);
      this.notifyAvailability();
      return ctx;
    } catch {
      this.ctx = null;
      this.g = null;
      this.lastFail = now;
      try {
        void ctx?.close?.();
      } catch {
        /* ignorieren */
      }
      return null;
    }
  }

  private applyMaster(): void {
    if (!this.ctx || !this.g) return;
    const target = this._muted ? 0 : this._volume * this._volume;
    try {
      this.g.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
    } catch {
      /* ignorieren */
    }
  }

  /** Nach Stumm-/Lautstärke-/Gesundheits-Wechsel: Rauschbett und Stimmen nachziehen. */
  private audibilityChanged(before: boolean): void {
    const now = this.audibleGraph() !== null;
    if (before === now) return;
    if (now) {
      this.bed?.resume();
      if ([...this.voices].some((v) => v.isRunning)) this.wake();
    } else {
      this.bed?.suspend();
      this.tick(); // Stimmen geben ihre Knoten frei
    }
  }

  private bindUnlock(): void {
    const win = this.deps.win !== undefined ? this.deps.win : typeof window !== "undefined" ? window : null;
    if (this.unlockBound || !win) return;
    this.unlockBound = true;
    const unlock = () => {
      const c = this.ctx;
      if (c && c.state === "suspended") {
        void c.resume?.().then(() => this.later(250, () => this.checkHealth())).catch(() => undefined);
      }
    };
    try {
      win.addEventListener("pointerdown", unlock, { capture: true });
      win.addEventListener("keydown", unlock, { capture: true });
    } catch {
      /* ignorieren */
    }
  }

  private bindVisibility(): void {
    const doc = this.deps.doc !== undefined ? this.deps.doc : typeof document !== "undefined" ? document : null;
    if (this.visBound || !doc) return;
    this.visBound = true;
    this.hidden = !!doc.hidden;
    try {
      doc.addEventListener("visibilitychange", () => {
        const before = this.audibleGraph() !== null;
        const h = !!doc.hidden;
        this.hidden = h;
        for (const v of this.voices) v.setHidden(h);
        this.bed?.setHidden(h);
        if (!h) {
          this.audibilityChanged(before);
          if (this.voices.size || this.scores.size) this.wake();
        }
      });
    } catch {
      /* ignorieren */
    }
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = true;
    this.later(250, () => {
      this.checkHealth();
      try {
        this.watchdog = this.timers.setInterval(() => this.checkHealth(), 1000);
      } catch {
        /* ignorieren */
      }
    });
  }

  private checkHealth(): void {
    const before = this.audibleGraph() !== null;
    this.clock.check();
    this.audibilityChanged(before);
    this.notifyAvailability();
  }

  private notifyAvailability(): void {
    const a = this.available;
    if (a === this.lastAvailable) return;
    this.lastAvailable = a;
    for (const cb of [...this.availCbs]) {
      try {
        cb(a);
      } catch {
        /* ignorieren */
      }
    }
  }

  /**
   * Scheduler anwerfen. Der erste Takt läuft bewusst asynchron (setTimeout 0): So plant eine
   * Stimme, die React-StrictMode sofort wieder aufräumt, nie einen Puls (keine Doppel-Pulse).
   */
  private wake(): void {
    if (this.timer === null) {
      try {
        this.timer = this.timers.setInterval(() => this.tick(), TICK_MS);
      } catch {
        this.timer = null;
      }
    }
    if (!this.tickQueued) {
      this.tickQueued = true;
      this.later(0, () => {
        this.tickQueued = false;
        this.tick();
      });
    }
  }

  /** Lookahead-Scheduler (E.4). */
  private tick(): void {
    try {
      const now = this.clock.now();
      if (this.ctx) this.clock.update();
      const horizon = now + LOOKAHEAD_S;
      const g = this.audibleGraph();
      for (const v of [...this.voices]) {
        if (this.hidden) v.tick(now, horizon, null, true);
        else v.tick(now, horizon, g);
      }
      if (!this.hidden) {
        for (const s of [...this.scores]) {
          s.runDue(horizon, now, (list) => {
            this.capture = list;
          });
          if (s.done) this.scores.delete(s);
        }
      }
      const busy = this.scores.size > 0 || [...this.voices].some((v) => v.isRunning);
      // verborgen: Scheduler pausiert (bindVisibility weckt ihn wieder)
      if ((!busy || this.hidden) && this.timer !== null) {
        this.timers.clearInterval(this.timer);
        this.timer = null;
      }
    } catch {
      /* Scheduler darf nie werfen */
    }
  }

  // ------------------------------------------------------------ Bausteine

  private partialNodes(
    g: Graph,
    o: { f: number; at: number; gain: number; attackS: number; holdS: number; tauS: number; reverb: boolean },
  ): { osc: OscillatorNode; gain: GainNode } | null {
    const ctx = g.ctx;
    const ct = this.ctAt(o.at);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = o.f;
    const gain = makeGain(ctx, 0);
    osc.connect(gain);
    gain.connect(g.chordBus);
    const send = o.reverb ? sendToReverb(g, gain, CHORD_SEND_DB) : null;
    gain.gain.setValueAtTime(0, ct);
    gain.gain.setTargetAtTime(o.gain, ct, Math.max(0.001, o.attackS / 3));
    gain.gain.setTargetAtTime(0, ct + Math.max(0, o.holdS), Math.max(0.005, o.tauS));
    osc.start(ct);
    osc.stop(ct + Math.max(0, o.holdS) + 7 * Math.max(0.005, o.tauS));
    osc.onended = () => disconnectAll([osc, gain, send]);
    this.track({
      startCt: ct,
      kill: () => {
        stopSafe(osc, 0);
        disconnectAll([osc, gain, send]);
      },
      stop: (f) => {
        const now = ctx.currentTime;
        rampParam(gain.gain, 0, now, f);
        stopSafe(osc, now + f + 0.01);
      },
    });
    return { osc, gain };
  }

  private makeTarget(): RecipeTarget {
    return {
      buffer: (name: BufferName, at: number, gain: number, reverb: boolean) => {
        const g = this.audibleGraph();
        if (!g || !(gain > 0)) return;
        const ctx = g.ctx;
        const src = ctx.createBufferSource();
        src.buffer = g.buffers[name];
        const gn = makeGain(ctx, gain);
        src.connect(gn);
        gn.connect(g.uiBus);
        const send = reverb ? sendToReverb(g, gn, SEND_DB) : null;
        const startCt = snapToSample(this.ctAt(at), g.sr);
        src.start(startCt);
        src.onended = () => disconnectAll([src, gn, send]);
        this.track({
          startCt,
          kill: () => {
            stopSafe(src, 0);
            disconnectAll([src, gn, send]);
          },
          stop: (f) => {
            rampParam(gn.gain, 0, ctx.currentTime, f);
            stopSafe(src, ctx.currentTime + f + 0.01);
          },
        });
      },
      partial: (o) => {
        const g = this.audibleGraph();
        if (g && o.gain > 0) this.partialNodes(g, o);
      },
      sweep: (o) => {
        const g = this.audibleGraph();
        if (!g || !(o.gain > 0)) return;
        const ctx = g.ctx;
        const D = Math.max(0.02, o.durS);
        const curve = dispersionCurve(o.fHi, o.fLo, D, 64);
        const ct = this.ctAt(o.at);
        const share = clamp(o.noiseShare ?? 1 / 3, 0, 1);
        // Hüllkurve: Anstieg 2 ms, Pegel ∝ √(f/f_hi), Ausklang in den letzten 25 ms
        const env = new Float32Array(64);
        for (let i = 0; i < 64; i++) {
          const t = (i / 63) * D;
          env[i] = o.gain * Math.min(1, t / 0.002) * Math.sqrt(curve[i] / o.fHi) * clamp((D - t) / 0.025, 0, 1);
        }
        const envG = makeGain(ctx, 0);
        envG.connect(g.uiBus);
        const send = o.reverb ? sendToReverb(g, envG, SEND_DB) : null;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueCurveAtTime(curve, ct, D);
        // Sinus und Rauschen (Standard: Rauschen −6 dB relativ); der lautere Anteil hat Gewicht 1
        const wMax = Math.max(1 - share, share);
        const oscG = makeGain(ctx, (1 - share) / wMax);
        osc.connect(oscG);
        oscG.connect(envG);
        const nodes: (AudioNode | null)[] = [osc, oscG, envG, send];
        let src: AudioBufferSourceNode | null = null;
        if (share > 0) {
          src = ctx.createBufferSource();
          src.buffer = g.noise;
          src.loop = true;
          const bp = makeFilter(ctx, { type: "bandpass", f: o.fHi, q: 18 });
          bp.frequency.setValueCurveAtTime(curve, ct, D);
          const norm = 0.35 / filteredNoiseRms([{ spec: { type: "bandpass", f: 1000, q: 18 }, share: 1 }], g.sr);
          const nG = makeGain(ctx, (share / wMax) * norm);
          src.connect(bp);
          bp.connect(nG);
          nG.connect(envG);
          src.start(ct, this.random() * 3.5);
          src.stop(ct + D + 0.01);
          nodes.push(src, bp, nG);
        }
        envG.gain.setValueCurveAtTime(env, ct, D);
        osc.start(ct);
        osc.stop(ct + D + 0.01);
        osc.onended = () => disconnectAll(nodes);
        this.track({
          startCt: ct,
          kill: () => {
            stopSafe(osc, 0);
            stopSafe(src, 0);
            disconnectAll(nodes);
          },
          stop: (f) => {
            const now = ctx.currentTime;
            try {
              envG.gain.cancelScheduledValues(now);
              envG.gain.setValueAtTime(0, now + f);
            } catch {
              /* ignorieren */
            }
            stopSafe(osc, now + f + 0.01);
            stopSafe(src, now + f + 0.01);
          },
        });
      },
      noise: (o) => {
        const g = this.audibleGraph();
        if (!g || !(o.rms > 0)) return;
        const ctx = g.ctx;
        const ct = this.ctAt(o.at);
        const src = ctx.createBufferSource();
        src.buffer = g.noise;
        src.loop = true;
        const bp = makeFilter(ctx, { type: "bandpass", f: o.centerHz, q: o.q });
        const glide = Math.max(0.005, o.glideS ?? 0);
        if (o.centerToHz) {
          bp.frequency.setValueAtTime(o.centerHz, ct);
          bp.frequency.exponentialRampToValueAtTime(o.centerToHz, ct + glide);
        }
        if (o.qTo !== undefined) {
          bp.Q.setValueAtTime(o.q, ct);
          bp.Q.linearRampToValueAtTime(o.qTo, ct + glide);
        }
        const r0 = filteredNoiseRms([{ spec: { type: "bandpass", f: o.centerHz, q: o.q }, share: 1 }], g.sr);
        const r1 = filteredNoiseRms([{ spec: { type: "bandpass", f: o.centerToHz ?? o.centerHz, q: o.qTo ?? o.q }, share: 1 }], g.sr);
        const level = o.rms / Math.sqrt(r0 * r1);
        const env = makeGain(ctx, 0);
        src.connect(bp);
        bp.connect(env);
        env.connect(g.uiBus);
        const a = Math.max(0.002, o.attackS);
        const holdEnd = ct + a + Math.max(0, o.durS);
        const end = holdEnd + Math.max(0.005, o.releaseS);
        env.gain.setValueAtTime(0, ct);
        env.gain.linearRampToValueAtTime(level, ct + a);
        env.gain.setValueAtTime(level, holdEnd);
        env.gain.linearRampToValueAtTime(0, end);
        src.start(ct, this.random() * 3.5);
        src.stop(end + 0.01);
        src.onended = () => disconnectAll([src, bp, env]);
        this.track({
          startCt: ct,
          kill: () => {
            stopSafe(src, 0);
            disconnectAll([src, bp, env]);
          },
          stop: (f) => {
            rampParam(env.gain, 0, ctx.currentTime, f);
            stopSafe(src, ctx.currentTime + f + 0.01);
          },
        });
      },
      rfi: (o) => {
        const g = this.audibleGraph();
        if (!g || !(o.peak > 0)) return;
        const ctx = g.ctx;
        // Kalibrierung VOR der Startzeit bestimmen: sonst läge `ct` nach einer langen Rechnung in der Vergangenheit
        const k = o.peak / rfiPeak(g.sr);
        const ct = this.ctAt(o.at);
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = 50;
        const bp = makeFilter(ctx, { type: "bandpass", f: 300, q: 1.2 });
        const lp = makeFilter(ctx, { type: "lowpass", f: 900, q: Q_BUTTER });
        const env = makeGain(ctx, 0);
        osc.connect(bp);
        bp.connect(lp);
        lp.connect(env);
        env.connect(g.uiBus);
        let last = 0;
        env.gain.setValueAtTime(0, ct);
        for (const [b0, b1] of o.bursts) {
          env.gain.setValueAtTime(0, ct + b0);
          env.gain.linearRampToValueAtTime(k, ct + b0 + o.attackS);
          env.gain.setValueAtTime(k, ct + b1);
          env.gain.linearRampToValueAtTime(0, ct + b1 + o.releaseS);
          last = Math.max(last, b1 + o.releaseS);
        }
        osc.start(ct);
        osc.stop(ct + last + 0.01);
        osc.onended = () => disconnectAll([osc, bp, lp, env]);
        this.track({
          startCt: ct,
          kill: () => {
            stopSafe(osc, 0);
            disconnectAll([osc, bp, lp, env]);
          },
          stop: (f) => {
            rampParam(env.gain, 0, ctx.currentTime, f);
            stopSafe(osc, ctx.currentTime + f + 0.01);
          },
        });
      },
      spin: (o) => {
        if (!this.audibleGraph()) return;
        const track = spinUpTrack({ t0: o.at, p0: o.p0, p1: o.p1, durS: o.durS, shape: o.shape, holdS: o.toneS });
        // temporäre Stimme, zählt nicht zu den 4 Stimmen
        const v = new ScheduledPulseVoice({ ...this.host, release: () => undefined }, { gainDb: o.gainDb, timbre: o.timbre });
        v.renderOnce(track, o.at, o.at + o.durS + o.toneS, 0.04);
        this.track({ stop: (f) => v.stop({ fadeS: f }) });
      },
    };
  }
}

/** Gemeinsame Instanz für App und Installer. */
export const sound = new SoundEngine();
