/**
 * Minimaler Fake-AudioContext für die Engine-Tests (vitest, node).
 * Zeichnet erzeugte Knoten, Verbindungen, start/stop und AudioParam-Automationen auf.
 */

export type ParamCall = { m: string; args: number[] };

export class FakeParam {
  value: number;
  calls: ParamCall[] = [];
  constructor(v = 0) {
    this.value = v;
  }
  private rec(m: string, args: number[], v?: number) {
    this.calls.push({ m, args });
    if (v !== undefined) this.value = v;
    return this;
  }
  setValueAtTime(v: number, t: number) {
    return this.rec("setValueAtTime", [v, t], v);
  }
  linearRampToValueAtTime(v: number, t: number) {
    return this.rec("linearRampToValueAtTime", [v, t], v);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (v <= 0) throw new RangeError("exp ramp ≤ 0");
    return this.rec("exponentialRampToValueAtTime", [v, t], v);
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    return this.rec("setTargetAtTime", [v, t, tau], v);
  }
  setValueCurveAtTime(c: Float32Array, t: number, d: number) {
    return this.rec("setValueCurveAtTime", [c[0], t, d, c[c.length - 1]], c[c.length - 1]);
  }
  cancelScheduledValues(t: number) {
    return this.rec("cancelScheduledValues", [t]);
  }
  /** letztes Ziel eines Aufrufs m */
  last(m: string): ParamCall | undefined {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i].m === m) return this.calls[i];
    return undefined;
  }
}

export class FakeNode {
  outputs = new Set<FakeNode>();
  disconnected = false;
  constructor(
    readonly ctx: FakeAudioContext,
    readonly kind: string,
  ) {
    ctx.created.push(this);
  }
  connect<T extends FakeNode>(n: T): T {
    this.outputs.add(n);
    this.disconnected = false;
    return n;
  }
  disconnect() {
    this.outputs.clear();
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, "gain");
  }
}

export class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  gain = new FakeParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, "biquad");
  }
}

export class FakeSource extends FakeNode {
  startAt: number | null = null;
  stopAt: number | null = null;
  onended: (() => void) | null = null;
  constructor(ctx: FakeAudioContext, kind: string) {
    super(ctx, kind);
  }
  start(t = 0) {
    if (this.startAt !== null) throw new Error("InvalidStateError: start twice");
    this.startAt = t;
  }
  stop(t = 0) {
    if (this.startAt === null) throw new Error("InvalidStateError: stop before start");
    this.stopAt = t;
  }
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  playbackRate = new FakeParam(1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, "bufferSource");
  }
}

export class FakeOscillator extends FakeSource {
  type = "sine";
  frequency = new FakeParam(440);
  detune = new FakeParam(0);
  wave: unknown = null;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "oscillator");
  }
  setPeriodicWave(w: unknown) {
    this.wave = w;
    this.type = "custom";
  }
}

export class FakeBuffer {
  private data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c: number) {
    return this.data[c];
  }
}

export class FakeAudioContext {
  created: FakeNode[] = [];
  state = "running";
  sampleRate = 48000;
  baseLatency = 0.01;
  outputLatency = 0.02;
  destination: FakeNode;
  /** Kontextzeit = Modellzeit − 100 s (fester Abstand) */
  constructor(
    private readonly nowFn: () => number,
    readonly ctxOffset = -100,
  ) {
    this.destination = new FakeNode(this, "destination");
  }
  get currentTime() {
    return Math.max(0, this.nowFn() + this.ctxOffset);
  }
  getOutputTimestamp() {
    return { contextTime: this.currentTime - 0.02, performanceTime: this.nowFn() * 1000 };
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  addEventListener() {}
  createGain() {
    return new FakeGain(this);
  }
  createBiquadFilter() {
    return new FakeBiquad(this);
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createOscillator() {
    return new FakeOscillator(this);
  }
  createBuffer(ch: number, len: number, sr: number) {
    return new FakeBuffer(ch, len, sr);
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array, o?: { disableNormalization?: boolean }) {
    return { real, imag, disableNormalization: o?.disableNormalization ?? false };
  }
  createConvolver() {
    const n = new FakeNode(this, "convolver") as FakeNode & { buffer: unknown; normalize: boolean };
    n.buffer = null;
    n.normalize = true;
    return n;
  }
  createDynamicsCompressor() {
    const n = new FakeNode(this, "compressor") as FakeNode & Record<string, FakeParam>;
    for (const k of ["threshold", "knee", "ratio", "attack", "release"]) n[k] = new FakeParam(0);
    return n;
  }
  createStereoPanner() {
    const n = new FakeNode(this, "panner") as FakeNode & { pan: FakeParam };
    n.pan = new FakeParam(0);
    return n;
  }

  // ---- Auswertung
  count(kind?: string): number {
    return kind ? this.created.filter((n) => n.kind === kind).length : this.created.length;
  }
  of<T extends FakeNode>(kind: string): T[] {
    return this.created.filter((n) => n.kind === kind) as T[];
  }
}

/** Manuelle Uhr + Zeitgeber (setInterval/setTimeout) für deterministische Tests. */
export class ManualTime {
  t: number;
  private seq = 0;
  private jobs = new Map<number, { at: number; every: number | null; fn: () => void }>();
  constructor(t0 = 1000) {
    this.t = t0;
  }
  now = (): number => this.t;
  timers = {
    setInterval: (fn: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.jobs.set(id, { at: this.t + ms / 1000, every: ms / 1000, fn });
      return id;
    },
    clearInterval: (h: unknown) => {
      this.jobs.delete(h as number);
    },
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.jobs.set(id, { at: this.t + ms / 1000, every: null, fn });
      return id;
    },
  };
  /** Zeit vorrücken und fällige Zeitgeber in Reihenfolge ausführen. */
  advance(s: number): void {
    const end = this.t + s;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, j] of this.jobs) if (j.at < nextAt) {
        nextAt = j.at;
        nextId = id;
      }
      if (nextId < 0 || nextAt > end + 1e-12) break;
      const j = this.jobs.get(nextId)!;
      this.t = Math.max(this.t, j.at);
      if (j.every !== null) j.at += j.every;
      else this.jobs.delete(nextId);
      j.fn();
    }
    this.t = end;
  }
  get pending(): number {
    return this.jobs.size;
  }
}

/** Fake-Dokument mit Sichtbarkeit */
export class FakeDoc {
  hidden = false;
  private fns: (() => void)[] = [];
  addEventListener(_t: string, fn: () => void) {
    this.fns.push(fn);
  }
  setHidden(h: boolean) {
    this.hidden = h;
    for (const f of this.fns) f();
  }
}
