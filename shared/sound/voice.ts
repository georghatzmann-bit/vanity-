/**
 * PulseVoice (E.11): Puls-Stimme für den Installer und „Hör dein Netz“.
 * ScheduledPulseVoice plant Klicks (BufferSource) und die Tonschicht (PeriodicWave) über den
 * gemeinsamen Lookahead-Scheduler der Engine. SilentPulseVoice hat dieselbe API ohne Knoten.
 */
import type { EngineClock } from "./clock";
import {
  F_STAR,
  STEP_HARMONICS,
  STEP_Q,
  TIMBRES,
  clamp,
  crossfade,
  dbToGain,
  excitationFor,
  pulseAmp,
  smootherCutoff,
  toneGain,
  voiceNorm,
  type ExcitationName,
  type Timbre,
} from "./dsp";
import { disconnectAll, makeFilter, makeGain, snapToSample, stopSafe, type Graph } from "./graph";
import type { SpinPulse, SpinSource } from "./spin";
import * as plan from "./voicePlan";

export type { Timbre } from "./dsp";

export interface PulseVoiceOptions {
  /** 0.004 … 10, Standard 1.3373 */
  periodS?: number;
  /** 0..1: Versatz bis ±35 % der Periode (Dreiecksverteilung, begrenzt) */
  jitter?: number;
  /** 0..1: Ausfallwahrscheinlichkeit pro Puls */
  dropout?: number;
  /** 0..1 linear, Standard 1 */
  level?: number;
  /** Grundpegel bei level 1, a = 1; Standard −14 */
  gainDb?: number;
  /** Standard "radio" */
  timbre?: Timbre;
  /** 0..5 Resonanz-Stufe (E.5), null = Timbre-Standard */
  step?: number | null;
  /** Tonschicht über 24 Hz erlauben (Standard true) */
  tone?: boolean;
  /** a(f) anwenden (Standard true) */
  loudnessComp?: boolean;
  pan?: number;
  seed?: number;
}

export interface PulseEvent {
  atModel: number;
  index: number;
  dropped: boolean;
  level: number;
}

export interface PulseVoice {
  /** erzeugt hörbare Knoten */
  readonly active: boolean;
  readonly periodS: number;
  /** fadeS ≤ 0.15 */
  start(o?: { atModel?: number; fadeS?: number }): void;
  /** gibt die Knoten nach dem Ausblenden frei */
  stop(o?: { fadeS?: number }): void;
  /** glide 0 = ab dem nächsten noch nicht geplanten Puls */
  setPeriod(periodS: number, o?: { glideS?: number }): void;
  setJitter(j: number): void;
  setDropout(p: number, o?: { rampS?: number }): void;
  /** nächster Puls fällt aus (Stille) */
  skipNext(): void;
  /** Standard 1.5, Pegel höchstens 1 */
  accentNext(factor?: number): void;
  /** rampS ≥ 0.02 erzwungen */
  setLevel(level: number, o?: { rampS?: number }): void;
  setStep(step: number | null): void;
  /** Ereignis-Modus, unabhängig vom Takt */
  pulse(o?: { atModel?: number; level?: number }): void;
  /** Installer: rendert die Pulse des Modells */
  follow(model: SpinSource | null): void;
  onPulse(cb: (e: PulseEvent) => void): () => void;
  dispose(): void;
}

/** Was die Stimme von der Engine braucht. */
export interface VoiceHost {
  readonly clock: EngineClock;
  /** Graph, wenn hörbare Knoten erzeugt werden dürfen (Kontext gesund, nicht stumm, sichtbar) – sonst null */
  audibleGraph(): Graph | null;
  /** Scheduler anwerfen (und sofort einen Takt planen) */
  wake(): void;
  /** Stimme freigeben (Platz für neue Stimmen) */
  release(v: ScheduledPulseVoice): void;
  /** Zeitgeber (ms) */
  later(ms: number, fn: () => void): void;
}

export const DEFAULT_PERIOD = 1.3373;
export const MAX_START_FADE = 0.15;
export const MIN_LEVEL_RAMP = 0.02;
/** Verspätung, ab der ein Klick verworfen wird */
const MAX_LATE = 0.05;
const MIN_LEAD = 0.005;
/** Ton aus, wenn w_t so lange 0 ist */
const TONE_IDLE_S = 0.3;

const normCache = new Map<string, number>();
function cachedNorm(g: Graph, timbre: Timbre, step: number | null): number {
  const key = `${g.sr}|${timbre}|${step ?? "-"}`;
  let v = normCache.get(key);
  if (v === undefined) {
    v = voiceNorm(g.excData["0.30"], timbre, g.sr, step);
    normCache.set(key, v);
  }
  return v;
}

/** Rampe ab dem aktuellen Wert (cancel + set + linearRamp). */
export function rampParam(p: AudioParam, target: number, at: number, dur: number): void {
  try {
    p.cancelScheduledValues(at);
    p.setValueAtTime(p.value, at);
    if (dur > 0) p.linearRampToValueAtTime(target, at + dur);
    else p.setValueAtTime(target, at);
  } catch {
    /* ignorieren */
  }
}

interface ToneLayer {
  osc: OscillatorNode;
  gain: GainNode;
  /** Modellzeit des Starts (Pulszeit) */
  startT: number;
  lastAudible: number;
}

interface Click {
  src: AudioBufferSourceNode;
  gain: GainNode;
  at: number;
}

interface VoiceNodes {
  g: Graph;
  input: GainNode;
  core: BiquadFilterNode | null;
  filters: AudioNode[];
  norm: GainNode;
  post: BiquadFilterNode;
  level: GainNode;
  fade: GainNode;
  pan: StereoPannerNode | null;
  clicks: Click[];
  tone: ToneLayer | null;
}

export class ScheduledPulseVoice implements PulseVoice {
  private readonly st: plan.PlanState;
  private readonly timbre: Timbre;
  private readonly unit: number;
  private readonly toneOn: boolean;
  private readonly loudnessComp: boolean;
  private readonly panValue: number;
  private step: number | null;
  private model: SpinSource | null = null;
  private running = false;
  private disposed = false;
  private hidden = false;
  private nodes: VoiceNodes | null = null;
  private scheduledUntil = -Infinity;
  private knotCursor = -Infinity;
  private startFade = 0.01;
  private gen = 0;
  private eventIndex = 0;
  private glide: { from: number; to: number; t0: number; t1: number } | null = null;
  private readonly listeners = new Set<(e: PulseEvent) => void>();

  constructor(
    private readonly host: VoiceHost,
    o: PulseVoiceOptions = {},
  ) {
    this.st = plan.createPlanState({
      periodS: o.periodS ?? DEFAULT_PERIOD,
      jitter: o.jitter,
      dropout: o.dropout,
      level: o.level,
      seed: o.seed,
    });
    this.timbre = o.timbre && o.timbre in TIMBRES ? o.timbre : "radio";
    this.unit = dbToGain(Number.isFinite(o.gainDb) ? (o.gainDb as number) : -14);
    this.toneOn = o.tone ?? true;
    this.loudnessComp = o.loudnessComp ?? true;
    this.panValue = clamp(o.pan ?? 0, -1, 1);
    this.step = normStep(o.step);
  }

  get active(): boolean {
    return this.running && !this.disposed && this.nodes !== null;
  }

  /** Läuft der Takt (unabhängig davon, ob gerade Knoten existieren)? */
  get isRunning(): boolean {
    return this.running && !this.disposed;
  }

  get periodS(): number {
    if (this.model) {
      const f = this.model.freqAt(this.host.clock.now());
      return f > 0 ? 1 / f : this.st.periodS;
    }
    return this.st.periodS;
  }

  get level(): number {
    return this.st.level;
  }

  // ---------------------------------------------------------------- Steuerung

  start(o: { atModel?: number; fadeS?: number } = {}): void {
    if (this.disposed) return;
    try {
      const now = this.host.clock.now();
      const t = Math.max(now, Number.isFinite(o.atModel) ? (o.atModel as number) : now);
      this.startFade = clamp(Number.isFinite(o.fadeS) ? (o.fadeS as number) : 0.01, 0, MAX_START_FADE);
      const wasRunning = this.running;
      this.running = true;
      this.gen++;
      if (!wasRunning) {
        this.scheduledUntil = t;
        // erster Puls des eigenen Takts mit 30 ms Vorlauf (sonst würde er geklemmt)
        if (!this.model) plan.restartAt(this.st, Math.max(t, now + 0.03));
      }
      const n = this.nodes;
      if (n) {
        const ct = this.ct(t, n);
        if (ct !== null) rampParam(n.fade.gain, 1, ct, this.startFade);
      }
      this.host.wake();
    } catch {
      /* Audio blockiert nie */
    }
  }

  stop(o: { fadeS?: number } = {}): void {
    if (!this.running && !this.nodes) return;
    this.running = false;
    this.glide = null;
    this.releaseNodes(Math.max(0.005, Number.isFinite(o.fadeS) ? (o.fadeS as number) : 0.05));
  }

  setPeriod(periodS: number, o: { glideS?: number } = {}): void {
    if (this.disposed || !Number.isFinite(periodS)) return;
    const to = plan.clampPeriod(periodS);
    const glideS = o.glideS ?? 0;
    if (glideS > 0) {
      const now = this.host.clock.now();
      this.glide = { from: this.st.periodS, to, t0: now, t1: now + glideS };
    } else {
      this.glide = null;
      plan.setPeriod(this.st, to);
    }
  }

  setJitter(j: number): void {
    plan.setJitter(this.st, j);
  }

  setDropout(p: number, o: { rampS?: number } = {}): void {
    if (!Number.isFinite(p)) return;
    plan.setDropout(this.st, p, this.host.clock.now(), Math.max(0, o.rampS ?? 0));
  }

  skipNext(): void {
    plan.skipNext(this.st);
  }

  accentNext(factor = 1.5): void {
    plan.accentNext(this.st, factor);
  }

  setLevel(level: number, o: { rampS?: number } = {}): void {
    if (!Number.isFinite(level)) return;
    plan.setLevel(this.st, level);
    const n = this.nodes;
    if (!n) return;
    const ct = n.g.ctx.currentTime;
    rampParam(n.level.gain, this.levelTarget(), ct, Math.max(MIN_LEVEL_RAMP, o.rampS ?? 0.03));
  }

  setStep(step: number | null): void {
    this.step = normStep(step);
    const n = this.nodes;
    if (!n || !n.core) return;
    try {
      const ct = n.g.ctx.currentTime;
      const base = TIMBRES[this.timbre].branches.find((b) => b.role === "core");
      const f = this.step === null ? (base?.f ?? F_STAR * 6) : F_STAR * STEP_HARMONICS[this.step];
      const q = this.step === null ? (base?.q ?? STEP_Q) : STEP_Q;
      n.core.frequency.setTargetAtTime(f, ct, 0.01);
      n.core.Q.setTargetAtTime(q, ct, 0.01);
      n.norm.gain.setTargetAtTime(cachedNorm(n.g, this.timbre, this.step), ct, 0.01);
    } catch {
      /* ignorieren */
    }
  }

  pulse(o: { atModel?: number; level?: number } = {}): void {
    if (this.disposed) return;
    try {
      const now = this.host.clock.now();
      const t = Math.max(now, Number.isFinite(o.atModel) ? (o.atModel as number) : now);
      const level = clamp(Number.isFinite(o.level) ? (o.level as number) : 1, 0, 1);
      this.emit({ atModel: t, index: this.eventIndex++, dropped: false, level });
      const g = this.host.audibleGraph();
      if (!g) return;
      const n = this.ensureNodes(g);
      const ct = this.ct(t, n);
      if (ct === null) return;
      if (!this.running) {
        // Ereignis-Modus ohne Takt: kurz öffnen, danach wieder freigeben
        n.fade.gain.cancelScheduledValues(ct);
        n.fade.gain.setValueAtTime(1, Math.max(n.g.ctx.currentTime, ct - 0.002));
        const my = ++this.gen;
        this.host.later(Math.max(0, (t - now) * 1000) + 800, () => {
          if (this.gen === my && !this.running) this.teardown();
        });
      }
      this.click(n, t, this.unit * level, "0.30");
    } catch {
      /* ignorieren */
    }
  }

  follow(model: SpinSource | null): void {
    if (this.disposed) return;
    const now = this.host.clock.now();
    if (model === this.model) return;
    if (!model && this.nodes?.tone) this.stopTone(this.nodes, this.nodes.g.ctx.currentTime + 0.02);
    this.model = model;
    this.knotCursor = now;
    this.scheduledUntil = Math.max(this.scheduledUntil, now);
    if (!model) plan.restartAt(this.st, now);
    if (this.running) this.host.wake();
  }

  onPulse(cb: (e: PulseEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.running = false;
    this.glide = null;
    this.releaseNodes(0.02, true);
    this.disposed = true;
    this.listeners.clear();
    this.host.release(this);
  }

  // ---------------------------------------------------------------- Engine-Seite

  /** Sichtbarkeit (document.hidden): in 300 ms auf 0, zurück in 50 ms. */
  setHidden(h: boolean): void {
    if (this.hidden === h) return;
    this.hidden = h;
    const n = this.nodes;
    if (n) rampParam(n.level.gain, this.levelTarget(), n.g.ctx.currentTime, h ? 0.3 : 0.05);
  }

  /** Ein Scheduler-Takt: plant alles bis horizon (E.4). */
  tick(now: number, horizon: number, g: Graph | null, hidden = false): void {
    if (this.disposed) return;
    if (hidden) {
      // verborgen: nichts planen, Knoten blenden über setHidden aus; kein Nachhol-Burst danach
      this.scheduledUntil = now;
      return;
    }
    if (!this.running || !g) {
      this.scheduledUntil = now;
      if (!g && this.nodes) this.releaseNodes(0.03);
      return;
    }
    try {
      const fresh = this.nodes === null || this.nodes.g !== g;
      const n = this.ensureNodes(g);
      if (fresh) {
        const ct = this.ct(Math.max(now, this.scheduledUntil), n);
        if (ct !== null) {
          n.fade.gain.setValueAtTime(0, ct);
          n.fade.gain.linearRampToValueAtTime(1, ct + Math.max(0.005, this.startFade));
        }
        this.knotCursor = now;
      }
      const from = Math.max(this.scheduledUntil, now);
      if (this.model) {
        this.model.advance(horizon + 0.02);
        this.renderKnots(n, now, horizon + 0.02);
        for (const p of this.model.pulsesBetween(from, horizon)) this.modelPulse(n, p);
      } else {
        this.applyGlide(now);
        if (this.timbre === "radio") rampSafe(n.post.frequency, smootherCutoff(1 / this.st.periodS), n.g.ctx.currentTime, 0.02);
        for (const p of plan.planPulses(this.st, now, horizon)) this.plannedPulse(n, p);
      }
      this.scheduledUntil = Math.max(this.scheduledUntil, horizon);
      this.pruneClicks(n);
    } catch {
      /* ein fehlerhafter Takt darf nichts blockieren */
    }
  }

  /**
   * Einmal-Rendering einer festen Spur (Hochdrehen in „launch“/„achievement“):
   * plant sofort alles von t0 bis t1, blendet am Ende in fadeOut aus und gibt danach frei.
   */
  renderOnce(track: SpinSource, t0: number, t1: number, fadeOut = 0.04): void {
    const g = this.host.audibleGraph();
    if (!g || this.disposed) return;
    try {
      const now = this.host.clock.now();
      this.model = track;
      this.running = true;
      const n = this.ensureNodes(g);
      const c0 = this.ct(Math.max(now, t0), n);
      const c1 = this.ct(t1, n);
      if (c0 === null || c1 === null) return;
      n.fade.gain.setValueAtTime(1, c0);
      this.knotCursor = t0 - 1e-6;
      this.renderKnots(n, now, t1 + 0.02);
      for (const p of track.pulsesBetween(Math.max(now, t0), t1)) this.modelPulse(n, p);
      n.fade.gain.setValueAtTime(1, Math.max(c0, c1 - fadeOut));
      n.fade.gain.linearRampToValueAtTime(0, c1);
      if (n.tone) stopSafe(n.tone.osc, c1 + 0.01);
      this.running = false;
      const my = ++this.gen;
      this.host.later(Math.max(0, t1 - now) * 1000 + 100, () => {
        if (this.gen === my) this.teardown();
      });
    } catch {
      /* ignorieren */
    }
  }

  // ---------------------------------------------------------------- intern

  private levelTarget(): number {
    return this.hidden ? 0 : this.st.level;
  }

  private ct(t: number, n: VoiceNodes): number | null {
    const c = this.host.clock.ctxTimeFor(t);
    if (c === null) return null;
    return Math.max(n.g.ctx.currentTime, c);
  }

  private emit(e: PulseEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch {
        /* Hörer-Fehler nicht weiterreichen */
      }
    }
  }

  private applyGlide(now: number): void {
    const gl = this.glide;
    if (!gl) return;
    const u = clamp((now - gl.t0) / Math.max(1e-6, gl.t1 - gl.t0), 0, 1);
    plan.setPeriod(this.st, gl.from * Math.pow(gl.to / gl.from, u));
    if (u >= 1) this.glide = null;
  }

  private ensureNodes(g: Graph): VoiceNodes {
    if (this.nodes && this.nodes.g === g) return this.nodes;
    if (this.nodes) this.teardown();
    const ctx = g.ctx;
    const input = makeGain(ctx, 1);
    const norm = makeGain(ctx, cachedNorm(g, this.timbre, this.step));
    const filters: AudioNode[] = [];
    let core: BiquadFilterNode | null = null;
    const spec = TIMBRES[this.timbre];
    for (const b of spec.branches) {
      let f = b.f;
      let q = b.q;
      if (b.role === "core" && this.step !== null) {
        f = F_STAR * STEP_HARMONICS[this.step];
        q = STEP_Q;
      }
      const flt = makeFilter(ctx, { type: b.type, f, q });
      const bg = makeGain(ctx, dbToGain(b.gainDb));
      input.connect(flt);
      flt.connect(bg);
      bg.connect(norm);
      filters.push(flt, bg);
      if (b.role === "core") core = flt;
    }
    const post = makeFilter(ctx, spec.post === "smoother" ? { type: "lowpass", f: smootherCutoff(1), q: -3.01 } : spec.post);
    const level = makeGain(ctx, this.levelTarget());
    const fade = makeGain(ctx, 0);
    norm.connect(post);
    post.connect(level);
    level.connect(fade);
    let pan: StereoPannerNode | null = null;
    try {
      if (this.panValue !== 0 && typeof ctx.createStereoPanner === "function") {
        pan = ctx.createStereoPanner();
        pan.pan.value = this.panValue;
      }
    } catch {
      pan = null;
    }
    if (pan) {
      fade.connect(pan);
      pan.connect(g.voiceBus);
    } else fade.connect(g.voiceBus);
    this.nodes = { g, input, core, filters, norm, post, level, fade, pan, clicks: [], tone: null };
    return this.nodes;
  }

  /** Ausblenden und danach Knoten freigeben (läuft der Takt wieder, bleibt alles). */
  private releaseNodes(fadeS: number, cutPending = false): void {
    const n = this.nodes;
    if (!n) return;
    try {
      const ct = n.g.ctx.currentTime;
      rampParam(n.fade.gain, 0, ct, fadeS);
      // geplante Klicks nach dem Ausblenden (bei dispose: alle noch nicht begonnenen) entfallen
      const cut = cutPending ? ct : ct + fadeS;
      for (const c of n.clicks) if (c.at > cut) stopSafe(c.src);
      n.clicks = n.clicks.filter((c) => c.at <= cut);
      if (n.tone) stopSafe(n.tone.osc, ct + fadeS + 0.01);
    } catch {
      /* ignorieren */
    }
    const my = ++this.gen;
    this.host.later((fadeS + 0.05) * 1000, () => {
      if (this.gen === my && this.nodes === n && !(this.running && this.host.audibleGraph() === n.g)) this.teardown();
    });
  }

  private teardown(): void {
    const n = this.nodes;
    if (!n) return;
    this.nodes = null;
    for (const c of n.clicks) {
      stopSafe(c.src);
      disconnectAll([c.src, c.gain]);
    }
    if (n.tone) {
      stopSafe(n.tone.osc);
      disconnectAll([n.tone.osc, n.tone.gain]);
    }
    disconnectAll([n.input, ...n.filters, n.norm, n.post, n.level, n.fade, n.pan]);
  }

  private pruneClicks(n: VoiceNodes): void {
    const limit = n.g.ctx.currentTime - 0.1;
    if (!n.clicks.length || n.clicks[0].at > limit) return;
    const keep: Click[] = [];
    for (const c of n.clicks) {
      if (c.at < limit) disconnectAll([c.src, c.gain]);
      else keep.push(c);
    }
    n.clicks = keep;
  }

  private click(n: VoiceNodes, t: number, amp: number, exc: ExcitationName): void {
    if (!(amp > 0)) return;
    let ct = this.host.clock.ctxTimeFor(t);
    if (ct === null) return;
    const min = n.g.ctx.currentTime + MIN_LEAD;
    if (ct < min) {
      if (min - ct > MAX_LATE) return; // zu spät → verwerfen
      ct = min;
    }
    const ctx = n.g.ctx;
    const src = ctx.createBufferSource();
    src.buffer = n.g.exc[exc];
    const gain = makeGain(ctx, amp);
    src.connect(gain);
    gain.connect(n.input);
    ct = snapToSample(ct, n.g.sr);
    src.start(ct);
    n.clicks.push({ src, gain, at: ct });
  }

  private modelPulse(n: VoiceNodes, p: SpinPulse): void {
    const gate = plan.gatePulse(this.st, p.t);
    this.emit({ atModel: p.t, index: p.index, dropped: gate.dropped, level: gate.level });
    if (gate.dropped) return;
    const wc = this.toneOn && n.g.pulseWave ? crossfade(p.f).wc : 1;
    if (wc <= 1e-4) return; // ab 48 Hz nur noch der Ton
    const ratio = this.st.level > 0 ? gate.level / this.st.level : 1;
    const a = this.loudnessComp ? pulseAmp(p.f) : 1;
    this.click(n, p.t, this.unit * a * wc * ratio, excitationFor(p.f));
  }

  private plannedPulse(n: VoiceNodes, p: plan.PlannedPulse): void {
    this.emit({ atModel: p.t, index: p.index, dropped: p.dropped, level: p.level });
    if (p.dropped) return;
    const f = 1 / this.st.periodS;
    const ratio = this.st.level > 0 ? p.level / this.st.level : 1;
    const a = this.loudnessComp ? pulseAmp(f) : 1;
    this.click(n, p.t, this.unit * a * ratio, excitationFor(f));
  }

  /** Knoten der Drehquelle → Glätter, Tonschicht-Frequenz und -Gain (linearRamp). */
  private renderKnots(n: VoiceNodes, now: number, until: number): void {
    const model = this.model;
    if (!model) return;
    for (const k of model.knotsSince(this.knotCursor)) {
      if (k.t > until) break;
      this.knotCursor = k.t;
      if (k.t <= now) continue;
      const ct = this.host.clock.ctxTimeFor(k.t);
      if (ct === null || ct <= n.g.ctx.currentTime) continue;
      if (this.timbre === "radio") rampTo(n.post.frequency, smootherCutoff(k.f), ct);
      if (!this.toneOn || !n.g.pulseWave) continue;
      const wt = crossfade(k.f).wt;
      const ke = n.g.excEnergy[excitationFor(k.f)];
      const drop = plan.dropoutAt(this.st, k.t);
      const gain = wt > 0 ? toneGain(k.f, n.g.sr, ke, this.loudnessComp) * this.unit * (1 - drop) : 0;
      if (!n.tone) {
        if (wt <= 0) continue;
        this.startTone(n, model, k.t, k.f, gain, ct);
        continue;
      }
      rampTo(n.tone.osc.frequency, k.f, ct);
      rampTo(n.tone.gain.gain, gain, ct);
      if (wt > 0) n.tone.lastAudible = k.t;
      else if (k.t - n.tone.lastAudible > TONE_IDLE_S) this.stopTone(n, ct);
    }
  }

  /** Tonschicht startet genau an einem Pulszeitpunkt (Kosinus-Phase 0 = Impuls). */
  private startTone(n: VoiceNodes, model: SpinSource, kt: number, kf: number, gain: number, ct: number): void {
    const ctx = n.g.ctx;
    const minModel = this.host.clock.modelTimeFor(ctx.currentTime + MIN_LEAD);
    if (minModel === null || !n.g.pulseWave) return;
    const p = model.pulsesBetween(Math.max(kt, minModel), kt + 0.2)[0];
    if (!p) return;
    const startCt = this.host.clock.ctxTimeFor(p.t);
    if (startCt === null) return;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(n.g.pulseWave);
    const tg = makeGain(ctx, 0);
    osc.frequency.setValueAtTime(kf, ct);
    tg.gain.setValueAtTime(gain, ct);
    osc.connect(tg);
    tg.connect(n.input);
    osc.start(Math.max(ctx.currentTime, startCt));
    n.tone = { osc, gain: tg, startT: p.t, lastAudible: kt };
  }

  private stopTone(n: VoiceNodes, at: number): void {
    const tone = n.tone;
    if (!tone) return;
    n.tone = null;
    try {
      tone.gain.gain.setTargetAtTime(0, at, 0.01);
    } catch {
      /* ignorieren */
    }
    stopSafe(tone.osc, at + 0.08);
    this.host.later(Math.max(0, at - n.g.ctx.currentTime + 0.15) * 1000, () => disconnectAll([tone.osc, tone.gain]));
  }
}

function normStep(step: number | null | undefined): number | null {
  if (step === null || step === undefined || !Number.isFinite(step)) return null;
  return clamp(Math.round(step), 0, STEP_HARMONICS.length - 1);
}

function rampTo(p: AudioParam, v: number, at: number): void {
  try {
    p.linearRampToValueAtTime(v, at);
  } catch {
    /* ignorieren */
  }
}

function rampSafe(p: AudioParam, v: number, at: number, dur: number): void {
  try {
    p.setTargetAtTime(v, at, dur);
  } catch {
    /* ignorieren */
  }
}

/** Stumme Stimme: identische API, keine Knoten, keine Ereignisse. */
export class SilentPulseVoice implements PulseVoice {
  private p: number;
  constructor(o: PulseVoiceOptions = {}) {
    this.p = plan.clampPeriod(o.periodS ?? DEFAULT_PERIOD);
  }
  get active(): boolean {
    return false;
  }
  get periodS(): number {
    return this.p;
  }
  start(): void {}
  stop(): void {}
  setPeriod(periodS: number): void {
    if (Number.isFinite(periodS)) this.p = plan.clampPeriod(periodS);
  }
  setJitter(): void {}
  setDropout(): void {}
  skipNext(): void {}
  accentNext(): void {}
  setLevel(): void {}
  setStep(): void {}
  pulse(): void {}
  follow(): void {}
  onPulse(): () => void {
    return () => undefined;
  }
  dispose(): void {}
}
