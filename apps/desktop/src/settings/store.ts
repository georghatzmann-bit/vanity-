import {
  LEGACY_SOUND_KEY,
  SETTINGS_STORAGE_KEY,
  parseStoredSettings,
  sanitizeSettings,
  serializeSettings,
  settingKeys,
  type LoadedSettings,
  type SettingKey,
  type Settings,
} from './schema.ts';

/** Ausschnitt aus `Storage` – in Tests ersetzbar. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `persistent` – Änderungen werden gespeichert; `memory-only` – Speicher fehlt oder ist voll,
 * Änderungen gelten bis zum Beenden; `read-only-newer` – die Daten stammen von einer neueren
 * Version und werden nie überschrieben.
 */
export type Persistence = 'persistent' | 'memory-only' | 'read-only-newer';

export interface SettingsSnapshot {
  readonly settings: Settings;
  readonly persistence: Persistence;
  /** Wie die Einstellungen beim Start geladen wurden. */
  readonly origin: LoadedSettings['origin'] | 'unavailable';
}

export interface SettingsUpdate {
  /** Tatsächlich geänderte Felder (leer, wenn alles gleich blieb oder ungültig war). */
  readonly changed: readonly SettingKey[];
}

export interface SettingsStore {
  getSnapshot(): SettingsSnapshot;
  subscribe(listener: () => void): () => void;
  /** Übernimmt gültige Werte, wirkt sofort und speichert (falls möglich). */
  update(patch: Partial<Settings>): SettingsUpdate;
}

/** `localStorage`, falls zugänglich – schon der Zugriff kann werfen (Richtlinien, Sandbox). */
export function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function load(storage: StorageLike | null): SettingsSnapshot {
  if (storage === null) {
    return {
      ...parseStoredSettings(null, null),
      persistence: 'memory-only',
      origin: 'unavailable',
    };
  }
  try {
    const loaded = parseStoredSettings(
      storage.getItem(SETTINGS_STORAGE_KEY),
      storage.getItem(LEGACY_SOUND_KEY),
    );
    return {
      ...loaded,
      persistence: loaded.origin === 'newer' ? 'read-only-newer' : 'persistent',
    };
  } catch {
    return {
      ...parseStoredSettings(null, null),
      persistence: 'memory-only',
      origin: 'unavailable',
    };
  }
}

/**
 * Einstellungs-Speicher (extern, für `useSyncExternalStore`). Liest einmal beim Erzeugen,
 * schreibt nur bei einer Änderung durch den Nutzer – nie beim Laden. Jeder Speicherzugriff
 * ist abgefangen; ein Fehler kostet nur die Dauerhaftigkeit, nie die Änderung selbst.
 */
export function createSettingsStore(storage: StorageLike | null): SettingsStore {
  let snapshot = load(storage);
  const listeners = new Set<() => void>();

  const persist = (settings: Settings): Persistence => {
    if (snapshot.persistence === 'read-only-newer') {
      return 'read-only-newer';
    }
    if (storage === null) {
      return 'memory-only';
    }
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, serializeSettings(settings));
      return 'persistent';
    } catch {
      // Speicher voll oder gesperrt: die Änderung gilt trotzdem (bis zum Beenden).
      return 'memory-only';
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(patch) {
      const next = sanitizeSettings({ ...snapshot.settings, ...patch }, snapshot.settings);
      const changed = settingKeys.filter((key) => next[key] !== snapshot.settings[key]);
      if (changed.length === 0) {
        return { changed };
      }
      snapshot = { ...snapshot, settings: next, persistence: persist(next) };
      for (const listener of [...listeners]) {
        listener();
      }
      return { changed };
    },
  };
}
