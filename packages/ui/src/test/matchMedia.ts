import { vi } from 'vitest';

export interface MatchMediaMock {
  readonly query: { matches: boolean; readonly media: string };
  /** Simuliert eine Änderung der Systemeinstellung. */
  change(matches: boolean): void;
  readonly listenerCount: () => number;
}

/**
 * Ersetzt window.matchMedia (fehlt in jsdom). `legacy` bildet ältere WebViews nach, die nur
 * addListener/removeListener kennen.
 */
export function mockMatchMedia(matches: boolean, legacy = false): MatchMediaMock {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn((listener: () => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: () => void) => listeners.delete(listener)),
    addEventListener: legacy
      ? undefined
      : vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: legacy
      ? undefined
      : vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(() => true),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    query,
    change(next) {
      query.matches = next;
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}
