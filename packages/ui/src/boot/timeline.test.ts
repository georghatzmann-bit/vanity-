import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_FALLBACK_MS,
  MAX_DURATION_SCALE,
  bootTimeline,
  hasReached,
  normalizeDurationScale,
  reducedBootTimeline,
  runTimeline,
  type BootPhase,
} from './timeline.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Zeitplan', () => {
  it('dauert ≈ 1,5 s, reduziert ≤ 300 ms, und bleibt mit maximalem Faktor unter der Obergrenze', () => {
    expect(bootTimeline.at(-1)).toEqual({ phase: 'done', at: 1500 });
    expect(reducedBootTimeline.at(-1)).toEqual({ phase: 'done', at: 300 });
    expect(1500 * MAX_DURATION_SCALE).toBeLessThan(BOOT_FALLBACK_MS);
    const times = bootTimeline.map((step) => step.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('begrenzt den Zeitfaktor', () => {
    expect(normalizeDurationScale(undefined)).toBe(1);
    expect(normalizeDurationScale(Number.NaN)).toBe(1);
    expect(normalizeDurationScale(-1)).toBe(0);
    expect(normalizeDurationScale(0.5)).toBe(0.5);
    expect(normalizeDurationScale(99)).toBe(MAX_DURATION_SCALE);
  });

  it('vergleicht Phasen nach ihrer Reihenfolge', () => {
    expect(hasReached('sweep', 'draw')).toBe(true);
    expect(hasReached('draw', 'sweep')).toBe(false);
    expect(hasReached('done', 'exit')).toBe(true);
  });
});

describe('runTimeline', () => {
  it('meldet alle Phasen der Reihe nach im Bildtakt', () => {
    const phases: BootPhase[] = [];
    runTimeline(bootTimeline, 1, (phase) => phases.push(phase));
    vi.advanceTimersByTime(20);
    expect(phases).toEqual(['draw']);
    vi.advanceTimersByTime(700);
    expect(phases).toEqual(['draw', 'inner', 'sweep']);
    vi.advanceTimersByTime(1000);
    expect(phases).toEqual(['draw', 'inner', 'sweep', 'word', 'exit', 'done']);
  });

  it('skaliert die Zeiten und lässt sich abbrechen', () => {
    const phases: BootPhase[] = [];
    const cancel = runTimeline(bootTimeline, 2, (phase) => phases.push(phase));
    vi.advanceTimersByTime(1000);
    expect(phases).toEqual(['draw', 'inner']);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(phases).toEqual(['draw', 'inner']);
  });

  it('läuft ohne requestAnimationFrame über Timer weiter', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const phases: BootPhase[] = [];
    const cancel = runTimeline(reducedBootTimeline, 1, (phase) => phases.push(phase));
    vi.advanceTimersByTime(400);
    expect(phases).toEqual(['static', 'exit', 'done']);
    cancel();
  });

  it('kann vor dem ersten Bild abgebrochen werden (ohne rAF)', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const onPhase = vi.fn();
    runTimeline(bootTimeline, 1, onPhase)();
    vi.advanceTimersByTime(2000);
    expect(onPhase).not.toHaveBeenCalled();
  });
});
