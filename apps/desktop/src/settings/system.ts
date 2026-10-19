/**
 * Systemvorlieben (Farbschema, Sprache) als externe Stores für `useSyncExternalStore` –
 * „System“ in den Einstellungen folgt ihnen live, ohne Neustart.
 */
import { useMemo, useSyncExternalStore } from 'react';

export type ColorScheme = 'dark' | 'light';

export const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

function mediaQuery(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  try {
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

function subscribeMedia(query: string, onChange: () => void): () => void {
  const list = mediaQuery(query);
  if (list === null) {
    return () => undefined;
  }
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }
  list.addListener(onChange);
  return () => list.removeListener(onChange);
}

/** Farbschema des Systems; ohne Angabe dunkel (Standard von AEGIS). */
export function systemColorScheme(): ColorScheme {
  return mediaQuery(LIGHT_SCHEME_QUERY)?.matches === true ? 'light' : 'dark';
}

function subscribeColorScheme(onChange: () => void): () => void {
  return subscribeMedia(LIGHT_SCHEME_QUERY, onChange);
}

export function useSystemColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeColorScheme, systemColorScheme, () => 'dark');
}

/** Bevorzugte Sprachen des Systems (Reihenfolge wie `navigator.languages`). */
export function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') {
    return [];
  }
  const list = navigator.languages;
  if (Array.isArray(list) && list.length > 0) {
    return list;
  }
  return typeof navigator.language === 'string' ? [navigator.language] : [];
}

/** Stabiler Schnappschuss (Text), damit React nur bei echten Änderungen neu zeichnet. */
function languagesSnapshot(): string {
  return systemLanguages().join(',');
}

function subscribeLanguages(onChange: () => void): () => void {
  window.addEventListener('languagechange', onChange);
  return () => window.removeEventListener('languagechange', onChange);
}

export function useSystemLanguages(): readonly string[] {
  const snapshot = useSyncExternalStore(subscribeLanguages, languagesSnapshot, () => '');
  return useMemo(() => (snapshot === '' ? [] : snapshot.split(',')), [snapshot]);
}
