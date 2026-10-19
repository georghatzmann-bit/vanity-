import { isSoundEnabled } from './preference.ts';

/**
 * Winziger WebAudio-Synthesizer für dezente UI-Klänge – ohne Audiodateien.
 *
 * Grundsätze: sehr leise, kurze weiche Hüllkurven, keine Wiederholungen. Fehlt WebAudio
 * oder blockiert die Autoplay-Richtlinie den AudioContext („suspended“), passiert still
 * nichts: Klänge werden nicht nachgeholt (ein verspäteter Start-Klang wäre irritierend).
 */
export interface UiSound {
  /** Weicher, aufsteigender Zweiklang für den App-Start. */
  bootChime(): void;
  /** Sehr kurzer, leiser Klick für Bestätigungen. */
  click(): void;
  /** Zurückhaltender, absteigender Zweiklang für Warnungen. */
  alert(): void;
}

export interface UiSoundOptions {
  /** Gesamtlautstärke 0–1 (Standard 0,6 – die Klänge selbst sind bereits leise). */
  readonly volume?: number;
  /** Schalter-Abfrage; Standard: globale Einstellung (isSoundEnabled). */
  readonly isEnabled?: () => boolean;
}

type AudioContextConstructor = new () => AudioContext;

function resolveAudioContext(): AudioContextConstructor | undefined {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

interface ToneSpec {
  readonly type: OscillatorType;
  readonly frequency: number;
  /** Zielfrequenz am Ende (optional, exponentiell). */
  readonly endFrequency?: number;
  /** Startversatz in Sekunden. */
  readonly offset: number;
  readonly attack: number;
  readonly decay: number;
  /** Spitzenpegel (linear), bewusst klein. */
  readonly peak: number;
}

const SILENCE = 0.0001;

function scheduleTone(context: AudioContext, output: AudioNode, start: number, spec: ToneSpec) {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  const begin = start + spec.offset;
  const end = begin + spec.attack + spec.decay;

  oscillator.type = spec.type;
  oscillator.frequency.setValueAtTime(spec.frequency, begin);
  if (spec.endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(spec.endFrequency, end);
  }
  envelope.gain.setValueAtTime(SILENCE, begin);
  envelope.gain.exponentialRampToValueAtTime(spec.peak, begin + spec.attack);
  envelope.gain.exponentialRampToValueAtTime(SILENCE, end);

  oscillator.connect(envelope);
  envelope.connect(output);
  oscillator.onended = () => {
    oscillator.disconnect();
    envelope.disconnect();
  };
  oscillator.start(begin);
  oscillator.stop(end + 0.05);
}

const BOOT_CHIME: readonly ToneSpec[] = [
  // Tiefe, kaum hörbare Grundierung + Quinte (E5 → H5), weich ausklingend.
  { type: 'sine', frequency: 329.63, offset: 0, attack: 0.04, decay: 1.1, peak: 0.018 },
  { type: 'sine', frequency: 659.25, offset: 0, attack: 0.02, decay: 0.9, peak: 0.045 },
  { type: 'sine', frequency: 987.77, offset: 0.11, attack: 0.02, decay: 1.0, peak: 0.035 },
  { type: 'triangle', frequency: 1975.53, offset: 0.11, attack: 0.01, decay: 0.35, peak: 0.006 },
];

const CLICK: readonly ToneSpec[] = [
  {
    type: 'triangle',
    frequency: 1900,
    endFrequency: 1300,
    offset: 0,
    attack: 0.002,
    decay: 0.04,
    peak: 0.03,
  },
];

const ALERT: readonly ToneSpec[] = [
  { type: 'triangle', frequency: 880, offset: 0, attack: 0.01, decay: 0.22, peak: 0.05 },
  { type: 'triangle', frequency: 659.25, offset: 0.16, attack: 0.01, decay: 0.3, peak: 0.045 },
];

/** Erzeugt einen UI-Synthesizer. Der AudioContext entsteht erst beim ersten Klang. */
export function createUiSound(options: UiSoundOptions = {}): UiSound {
  const volume = Math.min(1, Math.max(0, options.volume ?? 0.6));
  const isEnabled = options.isEnabled ?? isSoundEnabled;
  let context: AudioContext | null = null;
  let output: AudioNode | null = null;
  let unavailable = false;

  const ensureContext = (): { context: AudioContext; output: AudioNode } | null => {
    if (context !== null && output !== null) {
      return { context, output };
    }
    if (unavailable) {
      return null;
    }
    const AudioContextCtor = resolveAudioContext();
    if (AudioContextCtor === undefined) {
      unavailable = true;
      return null;
    }
    const created = new AudioContextCtor();
    // Sanfter Tiefpass gegen Härte, darüber die Gesamtlautstärke.
    const filter = created.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 4200;
    const master = created.createGain();
    master.gain.value = volume;
    filter.connect(master);
    master.connect(created.destination);
    context = created;
    output = filter;
    return { context, output };
  };

  const play = (tones: readonly ToneSpec[]): void => {
    if (!isEnabled()) {
      return;
    }
    try {
      const audio = ensureContext();
      if (audio === null) {
        return;
      }
      if (audio.context.state !== 'running') {
        // Autoplay-Sperre: nur das Fortsetzen anstoßen, nichts nachholen.
        if (audio.context.state === 'suspended') {
          Promise.resolve(audio.context.resume()).catch(() => undefined);
        }
        return;
      }
      const start = audio.context.currentTime + 0.01;
      for (const tone of tones) {
        scheduleTone(audio.context, audio.output, start, tone);
      }
    } catch {
      // WebAudio nicht nutzbar (Richtlinie, Treiber, Test-Umgebung): still bleiben.
      unavailable = context === null;
    }
  };

  return {
    bootChime: () => play(BOOT_CHIME),
    click: () => play(CLICK),
    alert: () => play(ALERT),
  };
}

let sharedSound: UiSound | null = null;

/** Gemeinsame Instanz für die App (ein AudioContext statt vieler). */
export function getUiSound(): UiSound {
  sharedSound ??= createUiSound();
  return sharedSound;
}
