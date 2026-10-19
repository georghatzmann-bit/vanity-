import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_SOUND_KEY,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  defaultSettings,
  isNewerVersion,
  migrate,
  parseStoredSettings,
  sanitizeSettings,
  serializeSettings,
  type Settings,
} from './schema.ts';
import { browserStorage, createSettingsStore, type StorageLike } from './store.ts';

/** Speicher im Arbeitsspeicher mit protokollierten Schreibzugriffen. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  const storage: StorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      writes.push([key, value]);
      data.set(key, value);
    },
  };
  return { storage, data, writes };
}

function stored(settings: Partial<Settings> | Record<string, unknown>, version = SETTINGS_VERSION) {
  return JSON.stringify({ version, settings });
}

describe('Einstellungen – Schema', () => {
  it('Standard: System-Sprache/-Darstellung/-Bewegung, Klang an, Start-Animation an, Infobereich an', () => {
    expect(defaultSettings).toEqual({
      language: 'system',
      theme: 'system',
      sound: true,
      motion: 'system',
      bootAnimation: true,
      closeToTray: true,
      sidebarCollapsed: false,
    });
  });

  it('prüft jedes Feld einzeln: ungültige fallen auf den Standard, gültige bleiben', () => {
    expect(
      sanitizeSettings({
        language: 'fr',
        theme: 'light',
        sound: 'yes',
        motion: 'reduced',
        bootAnimation: 0,
        closeToTray: false,
        sidebarCollapsed: null,
        extra: 'wird ignoriert',
      }),
    ).toEqual({ ...defaultSettings, theme: 'light', motion: 'reduced', closeToTray: false });
  });

  it('übernimmt keine geerbten Eigenschaften (Prototyp) als Werte', () => {
    const tricky = Object.create({ theme: 'light', sound: false }) as Record<string, unknown>;
    expect(sanitizeSettings(tricky)).toEqual(defaultSettings);
    expect(sanitizeSettings(JSON.parse('{"__proto__": {"theme": "light"}}'))).toEqual(
      defaultSettings,
    );
  });

  it('serialisiert vollständig und versioniert', () => {
    expect(JSON.parse(serializeSettings({ ...defaultSettings, theme: 'dark' }))).toEqual({
      version: SETTINGS_VERSION,
      settings: { ...defaultSettings, theme: 'dark' },
    });
  });
});

describe('Einstellungen – Laden und Migration', () => {
  it('ohne Daten: Standardwerte', () => {
    expect(parseStoredSettings(null, null)).toEqual({ settings: defaultSettings, origin: 'empty' });
  });

  it('aktuelles Format wird gelesen', () => {
    expect(parseStoredSettings(stored({ ...defaultSettings, language: 'en' }), null)).toEqual({
      settings: { ...defaultSettings, language: 'en' },
      origin: 'current',
    });
  });

  it('fehlende Felder (älterer Stand derselben Version) werden ergänzt', () => {
    expect(parseStoredSettings(stored({ theme: 'light' }), null).settings).toEqual({
      ...defaultSettings,
      theme: 'light',
    });
  });

  it('übernimmt den Klang-Schalter aus P0 (aegis.sound) als Version 0', () => {
    expect(parseStoredSettings(null, 'off')).toEqual({
      settings: { ...defaultSettings, sound: false },
      origin: 'migrated',
    });
    expect(parseStoredSettings(null, 'on').settings.sound).toBe(true);
    // Unbekannter Wert im alten Schlüssel: keine Migration, Standard.
    expect(parseStoredSettings(null, 'vielleicht')).toEqual({
      settings: defaultSettings,
      origin: 'empty',
    });
    // Sind schon Einstellungen da, zählt der alte Schlüssel nicht mehr.
    expect(parseStoredSettings(stored({ sound: true }), 'off').settings.sound).toBe(true);
  });

  it('migriert gespeicherte Version 0 und prüft danach jedes Feld', () => {
    expect(parseStoredSettings(stored({ theme: 'dark', sound: 'kaputt' }, 0), null)).toEqual({
      settings: { ...defaultSettings, theme: 'dark' },
      origin: 'migrated',
    });
  });

  it('wirft bei fehlender Migrationsstufe (statt still falsch zu laden)', () => {
    expect(() => migrate(-1, {})).toThrow(/keine Migration/);
    expect(migrate(SETTINGS_VERSION, { theme: 'x' })).toEqual({ theme: 'x' });
  });

  it('unlesbare Daten ergeben Standardwerte („corrupt“)', () => {
    for (const raw of [
      '{kaputt',
      'null',
      '42',
      '"text"',
      '[]',
      '{}',
      '{"version":1}',
      '{"version":1,"settings":[]}',
      '{"version":"1","settings":{}}',
      '{"version":0.5,"settings":{}}',
      '{"version":-1,"settings":{}}',
      '{"version":true,"settings":{}}',
      '{"version":"v2","settings":{}}',
    ]) {
      expect(parseStoredSettings(raw, 'off'), raw).toEqual({
        settings: defaultSettings,
        origin: 'corrupt',
      });
    }
  });

  it('Daten einer neueren Version: lesbare Felder übernehmen, als „newer“ kennzeichnen', () => {
    expect(
      parseStoredSettings(stored({ theme: 'light', zukunft: true }, SETTINGS_VERSION + 1), null),
    ).toEqual({ settings: { ...defaultSettings, theme: 'light' }, origin: 'newer' });
  });

  it('neuere Version mit anderem Format bleibt „newer“ (nicht „corrupt“)', () => {
    for (const raw of [
      // Container umbenannt, fehlt oder ist kein Objekt.
      '{"version":2,"prefs":{"theme":"light"}}',
      '{"version":2}',
      '{"version":2,"settings":[1,2]}',
      // Nicht ganzzahlig, unendlich, als Text.
      '{"version":1.5,"settings":{}}',
      '{"version":2.5,"settings":{}}',
      '{"version":1e999,"settings":{}}',
      '{"version":"2","settings":{}}',
      '{"version":"1.1","settings":{}}',
      '{"version":" 3.0.1 ","settings":{}}',
    ]) {
      expect(parseStoredSettings(raw, null), raw).toEqual({
        settings: defaultSettings,
        origin: 'newer',
      });
    }
    expect(
      parseStoredSettings('{"version":2.5,"settings":{"theme":"light"}}', null).settings.theme,
    ).toBe('light');
    expect(isNewerVersion(SETTINGS_VERSION)).toBe(false);
    expect(isNewerVersion('1')).toBe(false);
    expect(isNewerVersion('1.0')).toBe(false);
    expect(isNewerVersion(null)).toBe(false);
  });
});

describe('Einstellungs-Speicher', () => {
  it('liest beim Start, schreibt dabei aber nie', () => {
    const { storage, writes } = memoryStorage({
      [SETTINGS_STORAGE_KEY]: stored({ theme: 'light' }),
    });
    const store = createSettingsStore(storage);
    expect(store.getSnapshot()).toEqual({
      settings: { ...defaultSettings, theme: 'light' },
      persistence: 'persistent',
      origin: 'current',
    });
    expect(writes).toEqual([]);
  });

  it('speichert jede Änderung sofort, meldet sie und liefert die geänderten Felder', () => {
    const { storage, data } = memoryStorage();
    const store = createSettingsStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.update({ theme: 'dark', language: 'en' }).changed).toEqual(['language', 'theme']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(data.get(SETTINGS_STORAGE_KEY) ?? '')).toEqual({
      version: SETTINGS_VERSION,
      settings: { ...defaultSettings, theme: 'dark', language: 'en' },
    });
  });

  it('ignoriert unveränderte und ungültige Werte (kein Schreiben, keine Meldung)', () => {
    const { storage, writes } = memoryStorage();
    const store = createSettingsStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    expect(store.update({ theme: 'system' }).changed).toEqual([]);
    expect(store.update({ theme: 'neon' as never, sound: 'laut' as never }).changed).toEqual([]);
    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('volles Speicherkontingent: Änderung gilt trotzdem, Zustand „memory-only“, später wieder „persistent“', () => {
    const { storage } = memoryStorage();
    let full = true;
    const setItem = vi.fn((key: string, value: string) => {
      if (full) {
        throw new DOMException('Speicher voll', 'QuotaExceededError');
      }
      storage.setItem(key, value);
    });
    const store = createSettingsStore({ getItem: storage.getItem, setItem });

    store.update({ sound: false });
    expect(store.getSnapshot().settings.sound).toBe(false);
    expect(store.getSnapshot().persistence).toBe('memory-only');

    full = false;
    store.update({ sound: true });
    expect(store.getSnapshot().persistence).toBe('persistent');
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('Lesefehler (gesperrter Speicher): Standardwerte, nur im Arbeitsspeicher', () => {
    const store = createSettingsStore({
      getItem: () => {
        throw new DOMException('verboten', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('verboten', 'SecurityError');
      },
    });
    expect(store.getSnapshot()).toEqual({
      settings: defaultSettings,
      persistence: 'memory-only',
      origin: 'unavailable',
    });
    store.update({ theme: 'light' });
    expect(store.getSnapshot().settings.theme).toBe('light');
    expect(store.getSnapshot().persistence).toBe('memory-only');
  });

  it('ohne Speicher (null): Änderungen wirken, bleiben aber im Arbeitsspeicher', () => {
    const store = createSettingsStore(null);
    expect(store.getSnapshot().origin).toBe('unavailable');
    store.update({ motion: 'reduced' });
    expect(store.getSnapshot()).toMatchObject({
      settings: { motion: 'reduced' },
      persistence: 'memory-only',
    });
  });

  it('Daten einer neueren Version werden nie überschrieben', () => {
    const newer = stored({ theme: 'light', zukunft: 1 }, SETTINGS_VERSION + 1);
    const { storage, data, writes } = memoryStorage({ [SETTINGS_STORAGE_KEY]: newer });
    const store = createSettingsStore(storage);
    expect(store.getSnapshot().persistence).toBe('read-only-newer');

    store.update({ theme: 'dark' });
    expect(store.getSnapshot().settings.theme).toBe('dark');
    expect(store.getSnapshot().persistence).toBe('read-only-newer');
    expect(writes).toEqual([]);
    expect(data.get(SETTINGS_STORAGE_KEY)).toBe(newer);
  });

  it('neuere Version mit anderem Format wird ebenfalls nie überschrieben', () => {
    for (const newer of [
      '{"version":2,"prefs":{"theme":"light"}}',
      '{"version":"2","settings":{}}',
      '{"version":2.5,"settings":{}}',
    ]) {
      const { storage, data, writes } = memoryStorage({ [SETTINGS_STORAGE_KEY]: newer });
      const store = createSettingsStore(storage);
      expect(store.getSnapshot().persistence, newer).toBe('read-only-newer');
      store.update({ sidebarCollapsed: true });
      expect(store.getSnapshot().settings.sidebarCollapsed).toBe(true);
      expect(writes, newer).toEqual([]);
      expect(data.get(SETTINGS_STORAGE_KEY)).toBe(newer);
    }
  });

  it('kaputte Daten werden beim ersten Speichern durch gültige ersetzt', () => {
    const { storage, data } = memoryStorage({
      [SETTINGS_STORAGE_KEY]: '{kaputt',
      [LEGACY_SOUND_KEY]: 'off',
    });
    const store = createSettingsStore(storage);
    expect(store.getSnapshot().origin).toBe('corrupt');
    store.update({ theme: 'light' });
    expect(JSON.parse(data.get(SETTINGS_STORAGE_KEY) ?? '')).toMatchObject({
      version: SETTINGS_VERSION,
      settings: { theme: 'light' },
    });
  });

  it('browserStorage: localStorage, falls zugänglich – sonst null statt Ausnahme', () => {
    expect(browserStorage()).toBe(window.localStorage);
    const spy = vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('verboten', 'SecurityError');
    });
    try {
      expect(browserStorage()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
