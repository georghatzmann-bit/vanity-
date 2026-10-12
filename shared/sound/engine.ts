/**
 * NOVA Klangwelt "Glas & Sterne"
 * ------------------------------
 * Alle Töne werden live per Web Audio erzeugt - keine Sound-Dateien, keine fremden Rechte.
 * Grundlage ist eine pentatonische Tonleiter (F-Dur-Pentatonik). Dadurch klingen auch
 * schnell hintereinander gespielte Töne nie schief.
 *
 * Bausteine:
 *  - FM-Glocke (Träger + Modulator mit abklingendem Index) -> kristallin
 *  - Weiches Pad (verstimmte Sägezähne durch sich öffnenden Tiefpass)
 *  - Gefiltertes Rauschen für "Whoosh"-Effekte
 *  - Künstlicher Hall (selbst erzeugte Impulsantwort)
 */

export type SoundName =
  | "startup"
  | "click"
  | "hover"
  | "switch"
  | "success"
  | "error"
  | "launch"
  | "achievement"
  | "toggleOn"
  | "toggleOff"
  | "open"
  | "close"
  | "tick"
  | "notify"
  | "whoosh"
  | "progress"
  | "jingle"
  | "farewell"
  | "dice";

export interface PlayOptions {
  /** 0..1, z. B. Fortschritt für "progress" */
  value?: number;
  /** Lautstärke-Faktor nur für diesen Aufruf */
  gain?: number;
}

// F-Dur-Pentatonik über mehrere Oktaven (Hz)
const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const PENTA_STEPS = [0, 2, 4, 7, 9]; // F G A C D
const pentatonic = (degree: number, baseMidi = 77 /* F5 */) => {
  const oct = Math.floor(degree / PENTA_STEPS.length);
  const step = PENTA_STEPS[((degree % PENTA_STEPS.length) + PENTA_STEPS.length) % PENTA_STEPS.length];
  return midiToHz(baseMidi + oct * 12 + step);
};

type Ctx = AudioContext;

export class SoundEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastPlayed = new Map<SoundName, number>();
  private _volume = 0.6;
  private _muted = false;
  private _hoverEnabled = true;
  private unlockBound = false;

  get volume() {
    return this._volume;
  }
  get muted() {
    return this._muted;
  }
  get hoverEnabled() {
    return this._hoverEnabled;
  }

  setVolume(v: number) {
    this._volume = Math.min(1, Math.max(0, v));
    this.applyMaster();
  }
  setMuted(m: boolean) {
    this._muted = m;
    this.applyMaster();
  }
  setHoverEnabled(h: boolean) {
    this._hoverEnabled = h;
  }

  private applyMaster() {
    if (!this.ctx || !this.master) return;
    const target = this._muted ? 0 : this._volume * this._volume * 0.9; // wahrnehmungsgerechte Kurve
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
  }

  /** Erstellt den AudioContext bei Bedarf. Gibt null zurück, wenn Audio nicht verfügbar ist. */
  private ensure(): Ctx | null {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
      return this.ctx;
    }
    try {
      const AC: typeof AudioContext | undefined =
        typeof window !== "undefined"
          ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined;
      if (!AC) return null;
      const ctx = new AC({ latencyHint: "interactive" });
      this.ctx = ctx;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 3.5;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;

      const master = ctx.createGain();
      master.gain.value = 0;
      master.connect(comp).connect(ctx.destination);
      this.master = master;

      const dry = ctx.createGain();
      dry.gain.value = 1;
      dry.connect(master);
      this.dry = dry;

      const reverb = ctx.createConvolver();
      reverb.buffer = this.makeImpulse(ctx, 2.6, 2.8);
      const wet = ctx.createGain();
      wet.gain.value = 0.32;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 220;
      wet.connect(hp).connect(reverb).connect(master);
      this.wet = wet;

      this.noiseBuffer = this.makeNoise(ctx, 2);
      this.applyMaster();
      this.bindUnlock();
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      return ctx;
    } catch {
      this.ctx = null;
      return null;
    }
  }

  /** Browser blockieren Audio bis zur ersten Interaktion - dann sofort freischalten. */
  private bindUnlock() {
    if (this.unlockBound || typeof window === "undefined") return;
    this.unlockBound = true;
    const unlock = () => {
      if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    };
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
  }

  /** Bereitet Audio vor (z. B. beim Start), ohne einen Ton zu spielen. */
  warmup() {
    this.ensure();
  }

  private makeImpulse(ctx: Ctx, seconds: number, decay: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // frühe Reflexionen + diffuser, abklingender Schweif
        const early = i < rate * 0.03 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 0.8 : 0;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * 0.5 + early;
      }
    }
    return buf;
  }

  private makeNoise(ctx: Ctx, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      // leicht "rosa" gefärbtes Rauschen - weicher als weißes
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
    return buf;
  }

  /** Verteilt ein Signal auf trocken + Hall */
  private out(node: AudioNode, wetAmount = 0.35, pan = 0): void {
    if (!this.ctx || !this.dry || !this.wet) return;
    let src: AudioNode = node;
    if (pan !== 0 && typeof this.ctx.createStereoPanner === "function") {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      src = p;
    }
    src.connect(this.dry);
    if (wetAmount > 0) {
      const send = this.ctx.createGain();
      send.gain.value = wetAmount;
      src.connect(send).connect(this.wet);
    }
  }

  /** Kristalline FM-Glocke */
  private bell(freq: number, at: number, opts: { gain?: number; decay?: number; ratio?: number; index?: number; wet?: number; pan?: number } = {}) {
    const ctx = this.ctx!;
    const { gain = 0.2, decay = 1.2, ratio = 3.5, index = 2.2, wet = 0.4, pan = 0 } = opts;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const env = ctx.createGain();
    car.type = "sine";
    mod.type = "sine";
    car.frequency.setValueAtTime(freq, at);
    mod.frequency.setValueAtTime(freq * ratio, at);
    modGain.gain.setValueAtTime(freq * index, at);
    modGain.gain.exponentialRampToValueAtTime(Math.max(1, freq * 0.02), at + decay * 0.6);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    mod.connect(modGain).connect(car.frequency);
    car.connect(env);
    this.out(env, wet, pan);
    car.start(at);
    mod.start(at);
    car.stop(at + decay + 0.05);
    mod.stop(at + decay + 0.05);
  }

  /** Einfacher Ton mit Hüllkurve (optional Tonhöhen-Gleiten) */
  private tone(
    freq: number,
    at: number,
    opts: { type?: OscillatorType; gain?: number; attack?: number; decay?: number; to?: number; wet?: number; lp?: number; pan?: number } = {},
  ) {
    const ctx = this.ctx!;
    const { type = "sine", gain = 0.2, attack = 0.003, decay = 0.2, to, wet = 0.2, lp, pan = 0 } = opts;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, at + decay);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    let last: AudioNode = osc;
    if (lp) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = lp;
      osc.connect(f);
      last = f;
    }
    last.connect(env);
    this.out(env, wet, pan);
    osc.start(at);
    osc.stop(at + attack + decay + 0.05);
  }

  /** Gefiltertes Rauschen mit Frequenzfahrt ("Whoosh") */
  private noise(
    at: number,
    opts: { dur?: number; from?: number; to?: number; gain?: number; q?: number; type?: BiquadFilterType; attack?: number; wet?: number },
  ) {
    const ctx = this.ctx!;
    const { dur = 0.3, from = 400, to = 2400, gain = 0.1, q = 1.2, type = "bandpass", attack, wet = 0.3 } = opts;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, at);
    f.frequency.exponentialRampToValueAtTime(to, at + dur);
    const env = ctx.createGain();
    const a = attack ?? dur * 0.45;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + a);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(env);
    this.out(env, wet);
    src.start(at, Math.random());
    src.stop(at + dur + 0.05);
  }

  /** Warmes Pad aus verstimmten Oszillatoren mit sich öffnendem Filter */
  private pad(freqs: number[], at: number, opts: { dur?: number; gain?: number; attack?: number; cutoffFrom?: number; cutoffTo?: number } = {}) {
    const ctx = this.ctx!;
    const { dur = 3, gain = 0.06, attack = 0.9, cutoffFrom = 280, cutoffTo = 2600 } = opts;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(cutoffFrom, at);
    filter.frequency.exponentialRampToValueAtTime(cutoffTo, at + attack * 1.4);
    filter.frequency.exponentialRampToValueAtTime(cutoffFrom * 1.5, at + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + attack);
    env.gain.setValueAtTime(gain, at + dur * 0.55);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    filter.connect(env);
    this.out(env, 0.55);
    freqs.forEach((f, i) => {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = i === 0 ? "triangle" : "sawtooth";
        o.frequency.value = f;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 1 / (freqs.length * 2);
        o.connect(g).connect(filter);
        o.start(at);
        o.stop(at + dur + 0.1);
      }
    });
  }

  /** Tiefer, weicher Schlag (Sub) */
  private sub(at: number, from = 90, to = 38, gain = 0.32, dur = 1.1) {
    this.tone(from, at, { type: "sine", gain, attack: 0.01, decay: dur, to, wet: 0.05 });
  }

  private throttled(name: SoundName, ms: number): boolean {
    const now = performance.now();
    const last = this.lastPlayed.get(name) ?? 0;
    if (now - last < ms) return true;
    this.lastPlayed.set(name, now);
    return false;
  }

  play(name: SoundName, opts: PlayOptions = {}): void {
    if (this._muted || this._volume <= 0) return;
    if (name === "hover" && !this._hoverEnabled) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state === "closed") return;
    try {
      this.render(name, ctx.currentTime + 0.005, opts);
    } catch {
      /* Audio darf nie die App stören */
    }
  }

  private render(name: SoundName, t: number, opts: PlayOptions) {
    const g = opts.gain ?? 1;
    switch (name) {
      case "hover": {
        if (this.throttled("hover", 45)) return;
        const deg = 5 + Math.floor(Math.random() * 5);
        this.tone(pentatonic(deg), t, { gain: 0.022 * g, decay: 0.06, wet: 0.25 });
        break;
      }
      case "click": {
        if (this.throttled("click", 30)) return;
        this.tone(1250, t, { gain: 0.16 * g, decay: 0.05, to: 620, wet: 0.12 });
        this.noise(t, { dur: 0.025, from: 5000, to: 3000, gain: 0.05 * g, type: "highpass", attack: 0.002, wet: 0 });
        break;
      }
      case "tick": {
        if (this.throttled("tick", 18)) return;
        this.tone(2100 + Math.random() * 200, t, { gain: 0.06 * g, decay: 0.025, wet: 0.08 });
        break;
      }
      case "switch": {
        if (this.throttled("switch", 60)) return;
        this.noise(t, { dur: 0.22, from: 600, to: 3200, gain: 0.05 * g, q: 0.9, wet: 0.35 });
        this.bell(pentatonic(7), t + 0.03, { gain: 0.05 * g, decay: 0.5, index: 1.4, wet: 0.5, pan: -0.2 });
        this.bell(pentatonic(9), t + 0.09, { gain: 0.04 * g, decay: 0.6, index: 1.4, wet: 0.5, pan: 0.2 });
        break;
      }
      case "open": {
        this.noise(t, { dur: 0.28, from: 500, to: 4200, gain: 0.05 * g, q: 0.8 });
        this.bell(pentatonic(10), t + 0.06, { gain: 0.05 * g, decay: 0.7, index: 1.2 });
        break;
      }
      case "close": {
        this.noise(t, { dur: 0.22, from: 3600, to: 500, gain: 0.04 * g, q: 0.8 });
        break;
      }
      case "toggleOn": {
        this.bell(pentatonic(6), t, { gain: 0.08 * g, decay: 0.35, index: 1.6 });
        this.bell(pentatonic(8), t + 0.06, { gain: 0.08 * g, decay: 0.5, index: 1.6 });
        break;
      }
      case "toggleOff": {
        this.bell(pentatonic(8), t, { gain: 0.06 * g, decay: 0.3, index: 1.3 });
        this.bell(pentatonic(5), t + 0.06, { gain: 0.06 * g, decay: 0.4, index: 1.3 });
        break;
      }
      case "success": {
        [5, 7, 8, 10].forEach((d, i) => this.bell(pentatonic(d), t + i * 0.075, { gain: 0.09 * g, decay: 1.1, pan: -0.3 + i * 0.2 }));
        break;
      }
      case "error": {
        this.tone(311, t, { type: "triangle", gain: 0.14 * g, decay: 0.16, lp: 1400, wet: 0.2 });
        this.tone(233, t + 0.13, { type: "triangle", gain: 0.14 * g, decay: 0.28, lp: 1200, wet: 0.25 });
        break;
      }
      case "notify": {
        this.bell(pentatonic(7), t, { gain: 0.08 * g, decay: 0.9 });
        this.bell(pentatonic(11), t + 0.12, { gain: 0.07 * g, decay: 1.2 });
        break;
      }
      case "whoosh": {
        this.noise(t, { dur: 0.5, from: 300, to: 5000, gain: 0.07 * g, q: 0.7 });
        break;
      }
      case "dice": {
        // schnelle, langsamer werdende Klicks wie ein rollender Würfel
        let at = t;
        let gap = 0.035;
        for (let i = 0; i < 16; i++) {
          this.tone(1700 + Math.random() * 900, at, { gain: 0.05 * g, decay: 0.02, wet: 0.1 });
          at += gap;
          gap *= 1.16;
        }
        break;
      }
      case "progress": {
        // Tonhöhe steigt mit dem Fortschritt
        if (this.throttled("progress", 90)) return;
        const v = Math.min(1, Math.max(0, opts.value ?? 0));
        const deg = Math.round(v * 9);
        this.bell(pentatonic(deg, 72), t, { gain: 0.035 * g, decay: 0.45, index: 1.1, wet: 0.5 });
        break;
      }
      case "launch": {
        this.sub(t, 120, 40, 0.3 * g, 1.4);
        this.noise(t, { dur: 1.1, from: 180, to: 7000, gain: 0.09 * g, q: 0.6, attack: 0.85, wet: 0.5 });
        this.pad([midiToHz(53), midiToHz(60), midiToHz(65), midiToHz(69), midiToHz(72)], t + 0.15, {
          dur: 2.4,
          gain: 0.05 * g,
          attack: 0.7,
        });
        [0, 2, 4, 5, 7].forEach((d, i) => this.bell(pentatonic(d + 3), t + 0.75 + i * 0.06, { gain: 0.06 * g, decay: 1.4, pan: -0.4 + i * 0.2 }));
        break;
      }
      case "achievement": {
        [0, 2, 4, 5, 7, 9, 10, 12].forEach((d, i) =>
          this.bell(pentatonic(d + 2), t + i * 0.045, { gain: 0.06 * g, decay: 0.8, index: 1.8, pan: Math.sin(i) * 0.5 }),
        );
        this.bell(pentatonic(12), t + 0.45, { gain: 0.08 * g, decay: 2.2, index: 2.5, wet: 0.6 });
        this.bell(pentatonic(14), t + 0.45, { gain: 0.06 * g, decay: 2.2, index: 2.5, wet: 0.6 });
        this.noise(t + 0.4, { dur: 1.4, from: 6000, to: 9000, gain: 0.025 * g, type: "highpass", attack: 0.1, wet: 0.7 });
        break;
      }
      case "startup": {
        // "Nova": tiefer Atemzug, Akkord öffnet sich, Glocken funkeln auf
        this.sub(t, 70, 36, 0.28 * g, 2.2);
        this.noise(t, { dur: 1.6, from: 200, to: 4200, gain: 0.05 * g, q: 0.5, attack: 1.1, wet: 0.6 });
        this.pad([midiToHz(41), midiToHz(53), midiToHz(57), midiToHz(60), midiToHz(64), midiToHz(67)], t + 0.05, {
          dur: 3.6,
          gain: 0.055 * g,
          attack: 1.2,
          cutoffFrom: 220,
          cutoffTo: 3200,
        });
        [0, 2, 3, 5, 7, 10].forEach((d, i) =>
          this.bell(pentatonic(d), t + 0.9 + i * 0.11, { gain: 0.055 * g, decay: 1.8, index: 1.6, wet: 0.6, pan: -0.5 + i * 0.2 }),
        );
        this.bell(pentatonic(12), t + 1.65, { gain: 0.05 * g, decay: 2.6, index: 2.2, wet: 0.7 });
        break;
      }
      case "jingle": {
        // Erfolgs-Melodie des Installers
        const melody: Array<[number, number]> = [
          [0, 0],
          [2, 0.12],
          [4, 0.24],
          [7, 0.36],
          [5, 0.6],
          [7, 0.72],
          [10, 0.84],
        ];
        melody.forEach(([d, dt], i) => this.bell(pentatonic(d), t + dt, { gain: 0.08 * g, decay: 1.4, pan: -0.3 + (i % 3) * 0.3 }));
        this.pad([midiToHz(53), midiToHz(60), midiToHz(65), midiToHz(69)], t + 0.8, { dur: 2.8, gain: 0.05 * g, attack: 0.4 });
        this.bell(pentatonic(12), t + 1.05, { gain: 0.07 * g, decay: 2.8, index: 2.4, wet: 0.7 });
        this.noise(t + 1.0, { dur: 1.6, from: 5000, to: 9000, gain: 0.02 * g, type: "highpass", attack: 0.2, wet: 0.7 });
        break;
      }
      case "farewell": {
        [10, 7, 5, 2, 0].forEach((d, i) => this.bell(pentatonic(d), t + i * 0.16, { gain: 0.06 * g, decay: 1.6, index: 1.3, wet: 0.6 }));
        this.pad([midiToHz(50), midiToHz(57), midiToHz(62)], t + 0.3, { dur: 2.6, gain: 0.04 * g, attack: 0.6, cutoffTo: 1600 });
        break;
      }
    }
  }
}

/** Gemeinsame Instanz für die ganze Oberfläche */
export const sound = new SoundEngine();
