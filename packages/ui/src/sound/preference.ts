import { useSyncExternalStore } from 'react';

/** Schlüssel im localStorage; Werte „on“ / „off“. Standard: an. */
export const SOUND_STORAGE_KEY = 'aegis.sound';

const listeners = new Set<() => void>();
/** Gilt, wenn der Speicher fehlt oder gesperrt ist (privater Modus, Richtlinien …). */
let memoryEnabled = true;
let storageUnavailable = false;

function readStoredPreference(): boolean | null {
  if (storageUnavailable) {
    return null;
  }
  try {
    const value = globalThis.localStorage?.getItem(SOUND_STORAGE_KEY);
    if (value === 'on') {
      return true;
    }
    if (value === 'off') {
      return false;
    }
    return null;
  } catch {
    storageUnavailable = true;
    return null;
  }
}

/** Sind UI-Klänge eingeschaltet? Ohne gespeicherte Wahl: ja. */
export function isSoundEnabled(): boolean {
  return readStoredPreference() ?? memoryEnabled;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Schaltet UI-Klänge global ein/aus und merkt sich die Wahl (falls Speicher verfügbar). */
export function setSoundEnabled(enabled: boolean): void {
  memoryEnabled = enabled;
  if (!storageUnavailable) {
    try {
      globalThis.localStorage?.setItem(SOUND_STORAGE_KEY, enabled ? 'on' : 'off');
    } catch {
      // Speicher gesperrt oder voll: Wahl gilt dann nur für diese Sitzung.
      storageUnavailable = true;
    }
  }
  notify();
}

function onStorage(event: StorageEvent): void {
  if (event.key === SOUND_STORAGE_KEY || event.key === null) {
    notify();
  }
}

/** Benachrichtigt bei Änderungen (auch aus anderen Fenstern). Gibt die Abmeldung zurück. */
export function subscribeSoundEnabled(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

/** React-Hook: aktueller Klang-Schalter und Setzer. */
export function useSoundEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeSoundEnabled, isSoundEnabled, () => true);
  return [enabled, setSoundEnabled] as const;
}
