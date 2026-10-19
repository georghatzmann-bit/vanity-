import { useSyncExternalStore } from 'react';

/** Media-Query des Betriebssystems für „Bewegung reduzieren“. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return null;
  }
}

/** Momentaufnahme: wünscht das System reduzierte Bewegung? (ohne matchMedia: nein) */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const query = mediaQuery();
  if (query === null) {
    return () => undefined;
  }
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  // Ältere WebViews kennen nur addListener/removeListener.
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

/** React-Hook: reagiert live auf die Systemeinstellung „Bewegung reduzieren“. */
export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
