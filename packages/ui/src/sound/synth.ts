import { isSoundEnabled } from './preference.ts';

/**
 * Winziger WebAudio-Synthesizer für dezente UI-Klänge – ohne Audiodateien.
 *
 * Grundsätze: sehr leise, kurze weiche Hüllkurven, keine Wiederholungen. Fehlt WebAudio
 * oder blockiert die Autoplay-Richtlinie den AudioContext, passiert still nichts: Klänge
 * werden nicht nachgeholt (ein verspäteter Start-Klang wäre irritierend).
 *
 * Autoplay (über `navigator.userActivation`, falls vorhanden):
 * - Gab es auf der Seite noch keine Nutzergeste, wird gar kein AudioContext angelegt. Ein
 *   so früh erzeugter Kontext bliebe „suspended“ und verschluckte sonst auch den ersten
 *   Klang der späteren Geste (Chromium warnt zudem in der Konsole).
 * - Ist der Kontext „suspended“, läuft aber gerade eine Nutzergeste (z. B. im Klick-Handler),
 *   wird fortgesetzt und der Klang trotzdem eingeplant – er beginnt, sobald der Kontext
 *   läuft. Ohne aktive Geste wird nur das Fortsetzen angestoßen, nichts nachgeholt.
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
  /**
   * Gesamtlautstärke 0–1 (Standard 0,6 – die Klänge selbst sind bereits leise). Werte
   * außerhalb werden begrenzt; ungültige Werte (NaN, ±∞) ergeben den Standard.
   */
  readonly volume?: number;
  /** Schalter-Abfrage; Standard: globale Einstellung (isSoundEnabled). */
  readonly isEnabled?: () => boolean;
}

type AudioContextConstructor = new () => AudioContext;

/** Standard-Gesamtlautstärke. */
const DEFAULT_VOLUME = 0.6;

/** Begrenzt die Lautstärke auf 0–1; fehlende oder nicht endliche Werte → Standard. */
function normalizeVolume(volume: number | undefined): number {
  if (volume === undefined || !Number.isFinite(volume)) {
    return DEFAULT_VOLUME;
  }
  return Math.min(1, Math.max(0, volume));
}

/** Ausschnitt aus `navigator.userActivation` (HTML „User Activation“). */
interface UserActivationState {
  /** Gab es auf der Seite schon eine Nutzergeste (klebrige Aktivierung)? */
  readonly hasBeenActive: boolean;
  /** Läuft gerade eine Nutzergeste (vorübergehende Aktivierung, z. B. im Klick-Handler)? */
  readonly isActive: boolean;
}

/** `undefined`, wenn die Umgebung die Nutzer-Aktivierung nicht meldet (dann wie bisher). */
function userActivation(): UserActivationState | undefined {
  const scope = globalThis as { navigator?: { userActivation?: UserActivationState } };
  return scope.navigator?.userActivation;
}

/** Schließt einen AudioContext, ohne zu werfen (Aufräumen nach Fehlern). */
function closeQuietly(context: AudioContext): void {
  try {
    Promise.resolve(context.close()).catch(() => undefined);
  } catch {
    // Bereits geschlossen oder close() fehlt: nichts weiter zu tun.
  }
}

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
  const volume = normalizeVolume(options.volume);
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
    try {
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
    } catch (error) {
      // Aufbau gescheitert: den schon erzeugten Kontext nicht verwaist offen lassen.
      closeQuietly(created);
      throw error;
    }
  };

  const play = (tones: readonly ToneSpec[]): void => {
    if (!isEnabled()) {
      return;
    }
    const activation = userActivation();
    if (activation?.hasBeenActive === false) {
      // Noch keine Nutzergeste: Die Autoplay-Richtlinie ließe den Kontext nicht starten.
      // Keinen anlegen – er bliebe „suspended“ und verschluckte den nächsten Klang.
      return;
    }
    try {
      const audio = ensureContext();
      if (audio === null) {
        return;
      }
      const { state } = audio.context;
      if (state === 'suspended') {
        Promise.resolve(audio.context.resume()).catch(() => undefined);
        // In einer Nutzergeste gelingt das Fortsetzen sofort: trotzdem einplanen (die Töne
        // beginnen, sobald der Kontext läuft). Ohne aktive Geste nichts nachholen.
        if (activation?.isActive !== true) {
          return;
        }
      } else if (state !== 'running') {
        // Geschlossen oder vom System unterbrochen: still bleiben.
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
