import { detectLanguage, localeFor, type Language } from '../i18n/translator.ts';
import type { Settings } from './schema.ts';
import type { ColorScheme } from './system.ts';

/** Was gerade tatsächlich gilt (Einstellung „System“ aufgelöst). */
export interface EffectivePreferences {
  readonly language: Language;
  readonly locale: string;
  readonly colorScheme: ColorScheme;
  readonly reducedMotion: boolean;
}

export interface SystemPreferences {
  readonly colorScheme: ColorScheme;
  readonly languages: readonly string[];
  readonly reducedMotion: boolean;
}

export function resolvePreferences(
  settings: Settings,
  system: SystemPreferences,
): EffectivePreferences {
  const language: Language =
    settings.language === 'system' ? detectLanguage(system.languages) : settings.language;
  return {
    language,
    locale: localeFor(language, system.languages),
    colorScheme: settings.theme === 'system' ? system.colorScheme : settings.theme,
    reducedMotion: settings.motion === 'reduced' || system.reducedMotion,
  };
}

/**
 * Überträgt die Vorlieben auf `<html>`: `data-theme` (Tokens von @aegis/ui), `lang`
 * (Screenreader, Silbentrennung) und `data-motion` (CSS-Abschaltung der Animationen).
 */
export function applyDocumentPreferences(
  root: HTMLElement,
  preferences: EffectivePreferences,
): void {
  root.dataset['theme'] = preferences.colorScheme;
  root.lang = preferences.language;
  if (preferences.reducedMotion) {
    root.dataset['motion'] = 'reduced';
  } else {
    delete root.dataset['motion'];
  }
}
