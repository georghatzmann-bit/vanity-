/**
 * Einstellungen der Oberfläche: Form, Standardwerte, Prüfung und Migration.
 *
 * Gespeichert wird unter genau einem Schlüssel (`aegis.settings`) als
 * `{ "version": 1, "settings": { … } }`. Beim Laden wird jedes Feld einzeln geprüft: Ein
 * kaputtes Feld fällt auf seinen Standard zurück, die übrigen bleiben erhalten. Nichts davon
 * berührt das System – es sind reine Darstellungs-Vorlieben der App.
 */

export const SETTINGS_STORAGE_KEY = 'aegis.settings';
export const SETTINGS_VERSION = 1;
/** P0-Schlüssel des Klang-Schalters aus @aegis/ui – wird einmalig übernommen. */
export const LEGACY_SOUND_KEY = 'aegis.sound';

export const languageSettings = ['system', 'de', 'en'] as const;
export const themeSettings = ['system', 'dark', 'light'] as const;
export const motionSettings = ['system', 'reduced'] as const;

export type LanguageSetting = (typeof languageSettings)[number];
export type ThemeSetting = (typeof themeSettings)[number];
export type MotionSetting = (typeof motionSettings)[number];

export interface Settings {
  readonly language: LanguageSetting;
  readonly theme: ThemeSetting;
  readonly sound: boolean;
  readonly motion: MotionSetting;
  /** Start-Animation beim App-Start zeigen. */
  readonly bootAnimation: boolean;
  /** Schließen-Knopf der Titelleiste versteckt das Fenster (nur Desktop-App). */
  readonly closeToTray: boolean;
  /** Seitenleiste nur mit Symbolen. */
  readonly sidebarCollapsed: boolean;
}

export const defaultSettings: Settings = {
  language: 'system',
  theme: 'system',
  sound: true,
  motion: 'system',
  bootAnimation: true,
  closeToTray: true,
  sidebarCollapsed: false,
};

export type SettingKey = keyof Settings;

function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Prüfregel je Feld. */
export const settingValidators: {
  readonly [K in SettingKey]: (value: unknown) => value is Settings[K];
} = {
  language: oneOf(languageSettings),
  theme: oneOf(themeSettings),
  sound: isBoolean,
  motion: oneOf(motionSettings),
  bootAnimation: isBoolean,
  closeToTray: isBoolean,
  sidebarCollapsed: isBoolean,
};

export const settingKeys = Object.keys(defaultSettings) as readonly SettingKey[];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Übernimmt jedes gültige Feld; ungültige oder fehlende Felder bekommen den Standard. */
export function sanitizeSettings(value: unknown, base: Settings = defaultSettings): Settings {
  const source: Readonly<Record<string, unknown>> = isRecord(value) ? value : {};
  const pick = <K extends SettingKey>(key: K): Settings[K] => {
    // Nur eigene Eigenschaften – nie Werte aus der Prototyp-Kette.
    const candidate = Object.hasOwn(source, key) ? source[key] : undefined;
    return settingValidators[key](candidate) ? candidate : base[key];
  };
  return {
    language: pick('language'),
    theme: pick('theme'),
    sound: pick('sound'),
    motion: pick('motion'),
    bootAnimation: pick('bootAnimation'),
    closeToTray: pick('closeToTray'),
    sidebarCollapsed: pick('sidebarCollapsed'),
  };
}

/** Ergebnis des Ladens. */
export interface LoadedSettings {
  readonly settings: Settings;
  /**
   * `current` – aktuelles Format (oder nichts gespeichert); `migrated` – aus älterem Format
   * übernommen; `corrupt` – unlesbar, Standardwerte; `newer` – von einer neueren Version
   * (lesbare Felder übernommen, aber nie überschreiben).
   */
  readonly origin: 'empty' | 'current' | 'migrated' | 'corrupt' | 'newer';
}

/**
 * Migrationen: Version n → n + 1. Version 0 = P0 (kein eigener Schlüssel, nur `aegis.sound`
 * von @aegis/ui). Neue Versionen ergänzen hier eine Stufe und erhöhen `SETTINGS_VERSION`.
 */
export const migrations: Readonly<
  Record<number, (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>>
> = {
  0: (legacy) => ({ ...defaultSettings, ...legacy }),
};

/** Wendet alle Migrationen ab `fromVersion` an. */
export function migrate(
  fromVersion: number,
  settings: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  let current: Record<string, unknown> = { ...settings };
  for (let version = fromVersion; version < SETTINGS_VERSION; version += 1) {
    const step = migrations[version];
    if (step === undefined) {
      throw new Error(`Einstellungen: keine Migration von Version ${version}.`);
    }
    current = step(current);
  }
  return current;
}

/** Liest den alten Klang-Schalter (`on`/`off`) als Version-0-Einstellungen. */
export function legacySettings(legacySound: string | null): Record<string, unknown> | null {
  if (legacySound === 'on' || legacySound === 'off') {
    return { sound: legacySound === 'on' };
  }
  return null;
}

/**
 * Wertet den gespeicherten Text aus (`raw` = Inhalt von `aegis.settings`, `legacySound` =
 * Inhalt von `aegis.sound`). Wirft nie – unlesbare Daten ergeben Standardwerte.
 */
export function parseStoredSettings(
  raw: string | null,
  legacySound: string | null,
): LoadedSettings {
  if (raw === null) {
    const legacy = legacySettings(legacySound);
    if (legacy === null) {
      return { settings: defaultSettings, origin: 'empty' };
    }
    return { settings: sanitizeSettings(migrate(0, legacy)), origin: 'migrated' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { settings: defaultSettings, origin: 'corrupt' };
  }
  if (!isRecord(parsed) || !isRecord(parsed['settings'])) {
    return { settings: defaultSettings, origin: 'corrupt' };
  }
  const version = parsed['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { settings: defaultSettings, origin: 'corrupt' };
  }
  const stored = parsed['settings'];
  if (version > SETTINGS_VERSION) {
    return { settings: sanitizeSettings(stored), origin: 'newer' };
  }
  if (version < SETTINGS_VERSION) {
    try {
      return { settings: sanitizeSettings(migrate(version, stored)), origin: 'migrated' };
    } catch {
      return { settings: defaultSettings, origin: 'corrupt' };
    }
  }
  return { settings: sanitizeSettings(stored), origin: 'current' };
}

/** Gespeicherte Form (immer vollständig, aktuelle Version). */
export function serializeSettings(settings: Settings): string {
  return JSON.stringify({ version: SETTINGS_VERSION, settings: sanitizeSettings(settings) });
}
