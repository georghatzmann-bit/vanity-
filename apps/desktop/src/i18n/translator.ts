import { de } from './de.ts';
import { en } from './en.ts';
import type {
  MessageParams,
  MessageTree,
  Messages,
  PluralKeyOf,
  PluralMessage,
  TextKeyOf,
} from './types.ts';

/** Sprachen der Oberfläche (Deutsch zuerst). */
export const languages = ['de', 'en'] as const;
export type Language = (typeof languages)[number];

/** Schlüssel eines einfachen Textes, z. B. `nav.label`. */
export type TextKey = TextKeyOf<typeof de>;
/** Schlüssel einer Mehrzahl-Form, z. B. `dashboard.activity.count`. */
export type PluralKey = PluralKeyOf<typeof de>;

export const catalogs: Readonly<Record<Language, Messages<typeof de>>> = { de, en };

/** Standard-Gebietsschema je Sprache (Datum/Uhrzeit, Mehrzahl-Regeln). */
const defaultLocales: Readonly<Record<Language, string>> = { de: 'de-DE', en: 'en-US' };

export function isPluralMessage(value: unknown): value is PluralMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 2 &&
    typeof (value as Partial<PluralMessage>).one === 'string' &&
    typeof (value as Partial<PluralMessage>).other === 'string'
  );
}

/** Flacht den Baum zu `pfad → Text | Mehrzahl-Form` ab (einmal je Sprache). */
export function flattenMessages(
  tree: MessageTree,
  prefix = '',
): Map<string, string | PluralMessage> {
  const result = new Map<string, string | PluralMessage>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string' || isPluralMessage(value)) {
      result.set(path, value);
    } else {
      for (const [childPath, childValue] of flattenMessages(value, path)) {
        result.set(childPath, childValue);
      }
    }
  }
  return result;
}

/** Platzhalter `{name}` in einem Text (für Tests und die Paritätsprüfung). */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1] ?? '').sort();
}

/** Ersetzt `{name}` durch den Wert; fehlende Werte bleiben sichtbar stehen (kein Absturz). */
export function interpolate(text: string, params: MessageParams | undefined): string {
  if (params === undefined) {
    return text;
  }
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * Sprache des Systems aus `navigator.languages` (in Reihenfolge der Vorlieben): die erste
 * deutsche oder englische Angabe gewinnt; kommt keine vor, gilt Deutsch (Deutsch zuerst).
 */
export function detectLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (base === 'de' || base === 'en') {
      return base;
    }
  }
  return 'de';
}

/** Gebietsschema: das bevorzugte des Systems, wenn es zur Sprache passt, sonst der Standard. */
export function localeFor(language: Language, preferred: readonly string[]): string {
  for (const tag of preferred) {
    if (tag.toLowerCase().split(/[-_]/)[0] === language) {
      try {
        return Intl.getCanonicalLocales(tag)[0] ?? defaultLocales[language];
      } catch {
        // Ungültige Angabe des Systems: nächste versuchen.
      }
    }
  }
  return defaultLocales[language];
}

export interface Translator {
  readonly language: Language;
  readonly locale: string;
  /** Einfacher Text mit optionalen Platzhaltern. */
  t(key: TextKey, params?: MessageParams): string;
  /** Mehrzahl-Form; `{count}` wird mit der (lokal formatierten) Zahl ersetzt. */
  tp(key: PluralKey, count: number, params?: MessageParams): string;
}

const flatCatalogs = new Map<Language, Map<string, string | PluralMessage>>();

function flatCatalog(language: Language): Map<string, string | PluralMessage> {
  let flat = flatCatalogs.get(language);
  if (flat === undefined) {
    flat = flattenMessages(catalogs[language]);
    flatCatalogs.set(language, flat);
  }
  return flat;
}

export function createTranslator(
  language: Language,
  locale = defaultLocales[language],
): Translator {
  const flat = flatCatalog(language);
  const plurals = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);
  return {
    language,
    locale,
    t(key, params) {
      const message = flat.get(key);
      return typeof message === 'string' ? interpolate(message, params) : key;
    },
    tp(key, count, params) {
      const message = flat.get(key);
      if (!isPluralMessage(message)) {
        return key;
      }
      const form = plurals.select(count) === 'one' ? message.one : message.other;
      return interpolate(form, { ...params, count: numbers.format(count) });
    },
  };
}
