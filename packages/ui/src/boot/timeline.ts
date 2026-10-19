/**
 * Zeitplan der Start-Animation. Die Phasen werden von JavaScript getaktet (nicht von
 * Animations-Callbacks), damit Tests sie mit Fake-Timern exakt steuern können; Motion
 * stellt nur dar, was die aktuelle Phase verlangt.
 */

export type BootPhase = 'idle' | 'draw' | 'inner' | 'sweep' | 'word' | 'static' | 'exit' | 'done';

export interface TimelineStep {
  readonly phase: BootPhase;
  /** Startzeit in ms (bei durationScale = 1). */
  readonly at: number;
}

/**
 * Normale Sequenz (≈ 1,5 s):
 * 0–700 ms Umriss zeichnet sich (beide Hälften von oben zur Spitze), ab 200 ms das Λ;
 * 600–1000 ms Lichtlinie wandert über das Zeichen, Scan-Balken + Füllung erscheinen;
 * 900–1300 ms Schriftzug gleitet ein; 1300–1500 ms Ebene blendet aus.
 */
export const bootTimeline: readonly TimelineStep[] = [
  { phase: 'draw', at: 0 },
  { phase: 'inner', at: 200 },
  { phase: 'sweep', at: 600 },
  { phase: 'word', at: 900 },
  { phase: 'exit', at: 1300 },
  { phase: 'done', at: 1500 },
];

/** Reduzierte Bewegung: statisches Logo, nur kurze Deckkraft-Blende (≤ 300 ms gesamt). */
export const reducedBootTimeline: readonly TimelineStep[] = [
  { phase: 'static', at: 0 },
  { phase: 'exit', at: 150 },
  { phase: 'done', at: 300 },
];

/** Dauer der Blende nach „Überspringen“. */
export const BOOT_SKIP_FADE_MS = 150;
/** Harte Obergrenze: spätestens dann ist die Animation fertig, egal was hängt. */
export const BOOT_FALLBACK_MS = 4000;
/** Größter erlaubter Zeitfaktor (1,5 s × 2,5 = 3,75 s < Obergrenze). */
export const MAX_DURATION_SCALE = 2.5;

const phaseOrder: readonly BootPhase[] = [
  'idle',
  'draw',
  'inner',
  'sweep',
  'word',
  'static',
  'exit',
  'done',
];

/** Rang einer Phase für „ist erreicht“-Vergleiche. */
export function phaseRank(phase: BootPhase): number {
  return phaseOrder.indexOf(phase);
}

/** Ist `target` in der aktuellen Phase bereits erreicht? */
export function hasReached(current: BootPhase, target: BootPhase): boolean {
  return phaseRank(current) >= phaseRank(target);
}

/** Begrenzt den Zeitfaktor auf [0, MAX_DURATION_SCALE]; ungültige Werte → 1. */
export function normalizeDurationScale(scale: number | undefined): number {
  if (scale === undefined || !Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(MAX_DURATION_SCALE, Math.max(0, scale));
}

type FrameCallback = (timestamp: number) => void;

function requestFrame(callback: FrameCallback): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(() => callback(Date.now()), 16);
  return () => clearTimeout(id);
}

/**
 * Taktet die Schritte über requestAnimationFrame (synchron zum Bild). Pausiert rAF – etwa
 * in einem minimierten Fenster –, greift die harte Obergrenze (BOOT_FALLBACK_MS) per Timer.
 * Gibt eine Abbruchfunktion zurück.
 */
export function runTimeline(
  steps: readonly TimelineStep[],
  scale: number,
  onPhase: (phase: BootPhase) => void,
): () => void {
  let start: number | null = null;
  let index = 0;
  let cancelFrame: (() => void) | null = null;

  const tick: FrameCallback = (timestamp) => {
    start ??= timestamp;
    const elapsed = timestamp - start;
    let step = steps[index];
    while (step !== undefined && step.at * scale <= elapsed) {
      onPhase(step.phase);
      index += 1;
      step = steps[index];
    }
    cancelFrame = step === undefined ? null : requestFrame(tick);
  };

  cancelFrame = requestFrame(tick);
  return () => {
    cancelFrame?.();
    cancelFrame = null;
  };
}
