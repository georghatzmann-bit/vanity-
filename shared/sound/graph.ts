/**
 * Knotengraph (E.2): Busse, Hall „Kuppel“, HP 30 Hz, Master, Limiter, Puffer und Rauschbett.
 * Wird erst in ensure() gebaut, nie beim Import.
 */
import {
  BUFFER_SPECS,
  Q_BUTTER,
  dbToGain,
  excitationEnergy,
  filteredNoiseRms,
  makeExcitations,
  makeReverbIR,
  mulberry32,
  pinkNoise,
  renderResponse,
  type BufferName,
  type ExcitationName,
  type FilterSpec,
} from "./dsp";

export interface Graph {
  ctx: AudioContext;
  sr: number;
  /** Summe vor HP und Master */
  sum: GainNode;
  voiceBus: GainNode;
  uiBus: GainNode;
  bedBus: GainNode;
  chordBus: GainNode;
  /** Eingang des Halls (Sends hängen sich hier an) */
  reverbIn: GainNode;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  /** Anregungen als Float32 (für reine Simulationen) und als AudioBuffer */
  excData: Record<ExcitationName, Float32Array>;
  exc: Record<ExcitationName, AudioBuffer>;
  /** k_e = √(Σ e²) je Anregung */
  excEnergy: Record<ExcitationName, number>;
  buffers: Record<BufferName, AudioBuffer>;
  /** 4 s rosa Rauschen, RMS 0,25 */
  noise: AudioBuffer;
  /** Tonschicht: real[n] = 1 für n = 1…256, ohne Normierung */
  pulseWave: PeriodicWave | null;
}

const toBuffer = (ctx: AudioContext, data: Float32Array): AudioBuffer => {
  const b = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate);
  b.getChannelData(0).set(data);
  return b;
};

export function makeFilter(ctx: BaseAudioContext, spec: FilterSpec): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = spec.type;
  f.frequency.value = spec.f;
  f.Q.value = spec.q;
  return f;
}

export function makeGain(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** Baut den kompletten Graphen. Wirft, wenn der Kontext etwas nicht kann (Aufrufer fängt). */
export function buildGraph(ctx: AudioContext): Graph {
  const sr = ctx.sampleRate;

  // Limiter: nur Sicherheit
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  limiter.connect(ctx.destination);

  const master = makeGain(ctx, 0);
  master.connect(limiter);

  const hp = makeFilter(ctx, { type: "highpass", f: 30, q: Q_BUTTER });
  hp.connect(master);

  const sum = makeGain(ctx, 1);
  sum.connect(hp);

  const voiceBus = makeGain(ctx, 1);
  const uiBus = makeGain(ctx, 1);
  const bedBus = makeGain(ctx, 1);
  const chordBus = makeGain(ctx, 1);
  for (const b of [voiceBus, uiBus, bedBus]) b.connect(sum);
  // Akkord-Bus: LP 3 kHz (Q −3,01); Hall-Sends (−12 dB) hängen an den Teiltönen
  const chordLp = makeFilter(ctx, { type: "lowpass", f: 3000, q: Q_BUTTER });
  chordBus.connect(chordLp);
  chordLp.connect(sum);

  // Hall „Kuppel“: IR 0,8 s, selbst erzeugt
  const reverbIn = makeGain(ctx, 1);
  const conv = ctx.createConvolver();
  conv.normalize = false;
  const [l, r] = makeReverbIR(sr, mulberry32(1967));
  const ir = ctx.createBuffer(2, l.length, sr);
  ir.getChannelData(0).set(l);
  ir.getChannelData(1).set(r);
  conv.buffer = ir;
  reverbIn.connect(conv);
  conv.connect(sum);

  const excData = makeExcitations(sr);
  const exc = {
    A: toBuffer(ctx, excData.A),
    "0.30": toBuffer(ctx, excData["0.30"]),
    "0.15": toBuffer(ctx, excData["0.15"]),
    "0.05": toBuffer(ctx, excData["0.05"]),
  };
  const excEnergy = {
    A: excitationEnergy(excData.A),
    "0.30": excitationEnergy(excData["0.30"]),
    "0.15": excitationEnergy(excData["0.15"]),
    "0.05": excitationEnergy(excData["0.05"]),
  };

  const buffers = {} as Record<BufferName, AudioBuffer>;
  for (const name of Object.keys(BUFFER_SPECS) as BufferName[]) {
    const s = BUFFER_SPECS[name];
    buffers[name] = toBuffer(ctx, renderResponse(excData[s.exc], s.spec, sr));
  }

  const noise = toBuffer(ctx, pinkNoise(Math.round(4 * sr), mulberry32(4)));

  let pulseWave: PeriodicWave | null = null;
  try {
    const real = new Float32Array(257);
    const imag = new Float32Array(257);
    for (let n = 1; n <= 256; n++) real[n] = 1;
    pulseWave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  } catch {
    pulseWave = null; // ältere WebView: Tonschicht entfällt, Klicks laufen weiter
  }

  return { ctx, sr, sum, voiceBus, uiBus, bedBus, chordBus, reverbIn, master, limiter, excData, exc, excEnergy, buffers, noise, pulseWave };
}

/** Hall-Send mit Pegel in dB von node in den Hall. */
export function sendToReverb(g: Graph, node: AudioNode, db: number): GainNode {
  const s = makeGain(g.ctx, dbToGain(db));
  node.connect(s);
  s.connect(g.reverbIn);
  return s;
}

/**
 * Startzeit auf das Abtastraster runden: Chrome interpoliert BufferSources mit Bruchteil-Start
 * (sub-sample), das verschmiert den Ein-Sample-Impuls der Anregung und kostet bis zu 6 dB Spitze.
 */
export const snapToSample = (t: number, sr: number): number => Math.ceil(t * sr - 1e-6) / sr;

/** Löst Knoten sicher (Fehler beim Trennen sind egal). */
export function disconnectAll(nodes: (AudioNode | null | undefined)[]): void {
  for (const n of nodes) {
    try {
      n?.disconnect();
    } catch {
      /* schon getrennt */
    }
  }
}

export const stopSafe = (src: AudioScheduledSourceNode | null | undefined, at?: number): void => {
  try {
    src?.stop(at);
  } catch {
    /* nicht gestartet oder schon gestoppt */
  }
};

/** Pegel-Kalibrierung des Rauschbetts: Zweig 1 BP (Anteil 0,7), Zweig 2 LP 900 (Anteil 0,3). */
export function bedRms(sr: number, centerHz: number, q: number): number {
  return filteredNoiseRms(
    [
      { spec: { type: "bandpass", f: centerHz, q }, share: 0.7 },
      { spec: { type: "lowpass", f: 900, q: Q_BUTTER }, share: 0.3 },
    ],
    sr,
  );
}
