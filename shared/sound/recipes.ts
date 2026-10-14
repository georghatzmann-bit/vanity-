/**
 * Alle 19 SoundNames im Vokabular der Pulsar-Sonifikation (E.12) – als Daten.
 * Keine Melodien: Tonhöhen nur als n·F_STAR (Resonatoren, Teiltöne), Teiltöne setzen
 * gleichzeitig ein, Sweeps fallen. recipes.test.ts prüft das (Regeln A–E).
 */
import { BUFFER_SPECS, F_STAR, dbToGain, harmonic, progressBuffer, type BufferName, type Rng, type Timbre } from "./dsp";

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

/** Einzelklang-Puffer (vorgerendert, Spitze 1) */
export interface BufferEvent {
  kind: "buffer";
  at: number;
  buffer: BufferName;
  gainDb: number;
  /** zufällige Pegelstreuung ± dB */
  randDb?: number;
  reverb?: boolean;
}
/** Einzelpuls einer Klangfarbe (Puffer pulse-<timbre>) */
export interface PulseHitEvent {
  kind: "pulse";
  at: number;
  timbre: Timbre;
  gainDb: number;
  reverb?: boolean;
}
/** progress: Puls radio mit Kern-Q aus value (q3/q6/q9/q12) */
export interface ProgressEvent {
  kind: "progress";
  at: number;
  gainDb: number;
}
/** Teilton n·F_STAR, Spitze gainDb, setTargetAtTime(Ziel, at, Anstieg/3), Halten ab Einsatz, Ausklang τ */
export interface PartialEvent {
  kind: "partial";
  at: number;
  n: number;
  gainDb: number;
  attackS: number;
  holdS: number;
  tauS: number;
  reverb?: boolean;
}
/** fallender Dispersions-Sweep (E.7) */
export interface SweepEvent {
  kind: "sweep";
  at: number;
  fHi: number;
  fLo: number;
  durS: number;
  gainDb: number;
  noiseShare?: number;
  reverb?: boolean;
}
/** Rauschstoß: rosa Rauschen → BP (Mitte/Q optional gleitend), Pegel in dBFS RMS */
export interface NoiseEvent {
  kind: "noise";
  at: number;
  /** Halten (nach dem Anstieg) */
  durS: number;
  levelDb: number;
  centerHz: number;
  q: number;
  centerToHz?: number;
  qTo?: number;
  glideS?: number;
  attackS: number;
  releaseS: number;
}
/** RFI-Störung (Fehler): Sägezahn 50 Hz → BP 300 Q 1,2 → LP 900, in Stößen */
export interface RfiEvent {
  kind: "rfi";
  at: number;
  bursts: [number, number][];
  attackS: number;
  releaseS: number;
  gainDb: number;
}
/** Hochdrehen mit temporärer Stimme: P(u) = P₀·(P₁/P₀)^(u^shape) über durS, danach toneS konstant */
export interface SpinEvent {
  kind: "spin";
  at: number;
  p0: number;
  p1: number;
  durS: number;
  shape: number;
  toneS: number;
  gainDb: number;
  timbre: Timbre;
}

export type RecipeEvent = BufferEvent | PulseHitEvent | ProgressEvent | PartialEvent | SweepEvent | NoiseEvent | RfiEvent | SpinEvent;

export interface Recipe {
  /** Gesamtdauer laut E.12 (s) */
  durS: number;
  /** Sperre gegen Wiederholung (ms) */
  lockMs?: number;
  events: RecipeEvent[];
}

/** Abschluss-Akkord (E.8): Obertöne des Endtons, gleichzeitig, nur die Anstiegszeit unterscheidet sich. */
export const CHORD_PARTIALS = [1, 2, 3, 4, 5, 6, 8] as const;
export const CHORD_LEVELS_DB = [-42, -36, -39, -41, -44, -45, -50] as const;
export const CHORD_ATTACKS_S = [0.3, 0.3, 0.6, 0.6, 0.9, 0.9, 1.2] as const;
export const CHORD_HOLD_S = 2.4;
export const CHORD_TAU_S = 0.7;

export function chordEvents(at: number, o: { gainDb?: number; holdS?: number; tauS?: number; reverb?: boolean } = {}): PartialEvent[] {
  return CHORD_PARTIALS.map((n, i) => ({
    kind: "partial" as const,
    at,
    n,
    gainDb: CHORD_LEVELS_DB[i] + (o.gainDb ?? 0),
    attackS: CHORD_ATTACKS_S[i],
    holdS: o.holdS ?? CHORD_HOLD_S,
    tauS: o.tauS ?? CHORD_TAU_S,
    reverb: o.reverb ?? true,
  }));
}

/** Vela-Abstand (89,33 ms) und Crab-Zwischenpuls (≈ 0,40·33,7 ms) */
export const VELA_S = 0.08933;
export const INTERPULSE_S = 0.013;
/** B1919-Periode */
export const B1919_S = 1.3373;

const farewellEvents = (): RecipeEvent[] => {
  const gaps = [0.0893, 0.1304, 0.1904, 0.278, 0.4059];
  const times = [0];
  for (const g of gaps) times.push(times[times.length - 1] + g);
  const out: RecipeEvent[] = [];
  times.forEach((at, i) => {
    if (i === 3 || i === 5) return; // Puls 4 und 6 fallen aus (fest)
    out.push({ kind: "pulse", at, timbre: "radio", gainDb: -24 - (6 * i) / 5 });
  });
  out.push({ kind: "noise", at: 1.15, durS: 0.5, levelDb: -38, centerHz: harmonic(6), q: 0.7, attackS: 0.1, releaseS: 0.6 });
  return out;
};

const diceEvents = (): RecipeEvent[] => {
  const out: RecipeEvent[] = [];
  let at = 0;
  for (let i = 0; i < 16; i++) {
    out.push({ kind: "pulse", at, timbre: "glass", gainDb: -28 - 0.3 * i });
    at += 0.035 * Math.pow(1.16, i);
  }
  return out;
};

export const RECIPES = {
  hover: { durS: 0.01, lockMs: 50, events: [{ kind: "buffer", at: 0, buffer: "hover", gainDb: -34, randDb: 1.5 }] },
  click: {
    durS: 0.03,
    lockMs: 30,
    events: [
      { kind: "buffer", at: 0, buffer: "click", gainDb: -22 },
      { kind: "buffer", at: INTERPULSE_S, buffer: "click", gainDb: -34 },
    ],
  },
  tick: { durS: 0.01, lockMs: 18, events: [{ kind: "buffer", at: 0, buffer: "tick", gainDb: -30 }] },
  switch: { durS: 0.18, lockMs: 60, events: [{ kind: "sweep", at: 0, fHi: 2400, fLo: 700, durS: 0.18, gainDb: -28 }] },
  whoosh: { durS: 0.32, events: [{ kind: "sweep", at: 0, fHi: 3200, fLo: 400, durS: 0.32, gainDb: -28, noiseShare: 0.7 }] },
  open: {
    durS: 0.16,
    events: [
      { kind: "pulse", at: 0, timbre: "radio", gainDb: -26 },
      // Das Band öffnet sich (Q 6 → 1), die Mitte bleibt fest
      { kind: "noise", at: 0, durS: 0.095, levelDb: -38, centerHz: harmonic(6), q: 6, qTo: 1, glideS: 0.14, attackS: 0.005, releaseS: 0.06 },
    ],
  },
  close: { durS: 0.12, events: [{ kind: "sweep", at: 0, fHi: harmonic(12), fLo: harmonic(4), durS: 0.12, gainDb: -32 }] },
  toggleOn: {
    durS: 0.045,
    events: [
      { kind: "pulse", at: 0, timbre: "glass", gainDb: -24 },
      { kind: "pulse", at: INTERPULSE_S, timbre: "glass", gainDb: -34 },
    ],
  },
  // Unterschied liegt in der Klangfarbe, nicht in der Tonhöhe
  toggleOff: { durS: 0.03, events: [{ kind: "pulse", at: 0, timbre: "soft", gainDb: -26 }] },
  success: {
    durS: 0.9,
    events: [
      { kind: "pulse", at: 0, timbre: "radio", gainDb: -24 },
      { kind: "partial", at: 0.03, n: 2, gainDb: -34, attackS: 0.12, holdS: 0.2, tauS: 0.25 },
      { kind: "partial", at: 0.03, n: 3, gainDb: -36, attackS: 0.2, holdS: 0.2, tauS: 0.25 },
      { kind: "partial", at: 0.03, n: 4, gainDb: -38, attackS: 0.28, holdS: 0.2, tauS: 0.25 },
    ],
  },
  error: {
    durS: 0.26,
    events: [
      { kind: "rfi", at: 0, bursts: [[0, 0.09], [0.14, 0.23]], attackS: 0.006, releaseS: 0.025, gainDb: -24 },
      { kind: "pulse", at: 0.18, timbre: "soft", gainDb: -28 },
    ],
  },
  notify: {
    durS: 0.12,
    events: [
      { kind: "pulse", at: 0, timbre: "radio", gainDb: -24, reverb: true },
      { kind: "pulse", at: VELA_S, timbre: "radio", gainDb: -24, reverb: true },
    ],
  },
  progress: { durS: 0.03, lockMs: 90, events: [{ kind: "progress", at: 0, gainDb: -28 }] },
  startup: {
    durS: 2.2,
    events: [
      // Suchfilter: Mitte gleitet auf die 6. Harmonische, das Band wird weit
      { kind: "noise", at: 0, durS: 0.52, levelDb: -34, centerHz: 300, q: 4, centerToHz: harmonic(6), qTo: 0.7, glideS: 0.5, attackS: 0.08, releaseS: 1.6 },
      { kind: "buffer", at: 0.5, buffer: "tick", gainDb: -40 },
      { kind: "pulse", at: 0.5, timbre: "radio", gainDb: -20 },
      { kind: "pulse", at: 0.5 + B1919_S, timbre: "radio", gainDb: -20 },
    ],
  },
  launch: {
    durS: 2.4,
    events: [
      { kind: "spin", at: 0, p0: 0.12, p1: 1 / F_STAR, durS: 0.9, shape: 1.6, toneS: 0.25, gainDb: -22, timbre: "radio" },
      { kind: "partial", at: 1.15, n: 1, gainDb: -30, attackS: 0.2, holdS: 0.6, tauS: 0.4 },
      { kind: "partial", at: 1.15, n: 2, gainDb: -28, attackS: 0.2, holdS: 0.6, tauS: 0.4 },
      { kind: "partial", at: 1.15, n: 3, gainDb: -31, attackS: 0.2, holdS: 0.6, tauS: 0.4 },
      { kind: "partial", at: 1.15, n: 4, gainDb: -33, attackS: 0.2, holdS: 0.6, tauS: 0.4 },
    ],
  },
  achievement: {
    durS: 3.3,
    events: [
      { kind: "spin", at: 0, p0: VELA_S, p1: 1 / F_STAR, durS: 0.5, shape: 1.6, toneS: 0.08, gainDb: -24, timbre: "radio" },
      ...chordEvents(0.5, { gainDb: -3, holdS: 0.8, tauS: 0.7 }),
    ],
  },
  jingle: { durS: 4, events: chordEvents(0, { holdS: 1.2 }) },
  farewell: { durS: 2.5, events: farewellEvents() },
  dice: { durS: 2.3, events: diceEvents() },
} satisfies Record<SoundName, Recipe>;

export const SOUND_NAMES = Object.keys(RECIPES) as SoundName[];

/** Nominale Länge der vorgerenderten Puffer (Ausklang bis ≈ −60 dB). */
export const BUFFER_LEN_S: Record<BufferName, number> = {
  hover: 0.01,
  tick: 0.01,
  click: 0.02,
  "pulse-radio": 0.03,
  "pulse-glass": 0.03,
  "pulse-soft": 0.03,
  "progress-q3": 0.03,
  "progress-q6": 0.03,
  "progress-q9": 0.03,
  "progress-q12": 0.03,
};

/** Hörbares Ende eines Ereignisses relativ zum Rezeptstart (Teiltöne: Halten + 2,5 τ). */
export function eventEnd(e: RecipeEvent): number {
  switch (e.kind) {
    case "buffer":
      return e.at + BUFFER_LEN_S[e.buffer];
    case "pulse":
      return e.at + BUFFER_LEN_S[`pulse-${e.timbre}`];
    case "progress":
      return e.at + BUFFER_LEN_S["progress-q6"];
    case "partial":
      return e.at + e.holdS + 2.5 * e.tauS;
    case "sweep":
      return e.at + e.durS;
    case "noise":
      return e.at + e.attackS + e.durS + e.releaseS;
    case "rfi":
      return e.at + Math.max(...e.bursts.map((b) => b[1])) + e.releaseS;
    case "spin":
      return e.at + e.durS + e.toneS;
  }
}

export const recipeEnd = (r: Recipe): number => Math.max(...r.events.map(eventEnd));

/** Spitze eines Ereignisses in dBFS (Rauschen: RMS + Crest 12 dB). */
export function eventPeakDb(e: RecipeEvent): number {
  switch (e.kind) {
    case "buffer":
      return e.gainDb + (e.randDb ?? 0);
    case "noise":
      return e.levelDb + 12;
    default:
      return e.gainDb;
  }
}

/** Was ein Rezept zum Klingen braucht (Engine). Zeiten in Modellzeit (s), Gains linear. */
export interface RecipeTarget {
  buffer(name: BufferName, at: number, gain: number, reverb: boolean): void;
  partial(o: { f: number; at: number; gain: number; attackS: number; holdS: number; tauS: number; reverb: boolean }): void;
  sweep(o: { at: number; fHi: number; fLo: number; durS: number; gain: number; noiseShare?: number; reverb: boolean }): void;
  noise(o: Omit<NoiseEvent, "kind" | "levelDb"> & { rms: number }): void;
  rfi(o: Omit<RfiEvent, "kind" | "gainDb"> & { peak: number }): void;
  spin(o: Omit<SpinEvent, "kind" | "gainDb"> & { gainDb: number }): void;
}

/** Spielt ein Rezept ab t0 (Modellzeit). gain = linearer Faktor, value für progress. */
export function renderRecipe(target: RecipeTarget, name: SoundName, t0: number, o: { gain?: number; value?: number } = {}, rng: Rng = Math.random): void {
  const r: Recipe = RECIPES[name];
  const k = Math.max(0, Number.isFinite(o.gain) ? (o.gain as number) : 1);
  if (k <= 0) return;
  const kDb = 20 * Math.log10(k);
  for (const e of r.events) {
    const at = t0 + e.at;
    switch (e.kind) {
      case "buffer": {
        const jitter = e.randDb ? (rng() * 2 - 1) * e.randDb : 0;
        target.buffer(e.buffer, at, k * dbToGain(e.gainDb + jitter), e.reverb ?? false);
        break;
      }
      case "pulse":
        target.buffer(`pulse-${e.timbre}`, at, k * dbToGain(e.gainDb), e.reverb ?? false);
        break;
      case "progress":
        target.buffer(progressBuffer(o.value ?? 0.5), at, k * dbToGain(e.gainDb), false);
        break;
      case "partial":
        target.partial({ f: harmonic(e.n), at, gain: k * dbToGain(e.gainDb), attackS: e.attackS, holdS: e.holdS, tauS: e.tauS, reverb: e.reverb ?? false });
        break;
      case "sweep":
        target.sweep({ at, fHi: e.fHi, fLo: e.fLo, durS: e.durS, gain: k * dbToGain(e.gainDb), noiseShare: e.noiseShare, reverb: e.reverb ?? true });
        break;
      case "noise": {
        const { kind: _k, levelDb, ...rest } = e;
        void _k;
        target.noise({ ...rest, at, rms: k * dbToGain(levelDb) });
        break;
      }
      case "rfi": {
        const { kind: _k, gainDb, ...rest } = e;
        void _k;
        target.rfi({ ...rest, at, peak: k * dbToGain(gainDb) });
        break;
      }
      case "spin": {
        const { kind: _k, ...rest } = e;
        void _k;
        target.spin({ ...rest, at, gainDb: e.gainDb + kDb });
        break;
      }
    }
  }
}

/** Resonator-Mitten (BP) eines Puffers – für Regel A. */
export const bufferPitches = (b: BufferName): number[] =>
  BUFFER_SPECS[b].spec.branches.filter((x) => x.type === "bandpass").map((x) => x.f);
