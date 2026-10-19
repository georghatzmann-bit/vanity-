import { describe, expect, it } from 'vitest';
import { de } from './de.ts';
import { en } from './en.ts';
import {
  catalogs,
  createTranslator,
  detectLanguage,
  flattenMessages,
  interpolate,
  isPluralMessage,
  languages,
  localeFor,
  placeholdersOf,
} from './translator.ts';
import type { MessageTree } from './types.ts';

const flatDe = flattenMessages(de);
const flatEn = flattenMessages(en);

/** Alle Texte eines Eintrags (einfacher Text oder beide Mehrzahl-Formen). */
function textsOf(value: string | { one: string; other: string }): string[] {
  return typeof value === 'string' ? [value] : [value.one, value.other];
}

describe('Übersetzungen – Vollständigkeit', () => {
  it('Deutsch und Englisch haben genau dieselben Schlüssel', () => {
    expect([...flatEn.keys()].sort()).toEqual([...flatDe.keys()].sort());
    expect(flatDe.size).toBeGreaterThan(100);
  });

  it('kein leerer Text und kein Text nur aus Leerraum', () => {
    for (const [language, flat] of [
      ['de', flatDe],
      ['en', flatEn],
    ] as const) {
      for (const [key, value] of flat) {
        for (const text of textsOf(value)) {
          expect(text.trim(), `${language}: ${key}`).not.toBe('');
          expect(text, `${language}: ${key} (Leerraum am Rand)`).toBe(text.trim());
        }
      }
    }
  });

  it('Mehrzahl-Formen stehen in beiden Sprachen an denselben Stellen', () => {
    for (const [key, value] of flatDe) {
      expect(isPluralMessage(flatEn.get(key)), key).toBe(isPluralMessage(value));
    }
  });

  it('Platzhalter stimmen je Schlüssel überein (keine fehlenden oder zusätzlichen)', () => {
    for (const [key, value] of flatDe) {
      const other = flatEn.get(key);
      expect(other, key).toBeDefined();
      if (other === undefined) {
        continue;
      }
      const deTexts = textsOf(value);
      const enTexts = textsOf(other);
      deTexts.forEach((text, index) => {
        expect(placeholdersOf(enTexts[index] ?? ''), key).toEqual(placeholdersOf(text));
      });
    }
  });

  it('Mehrzahl-Formen enthalten {count}; kein gewöhnlicher Unterbaum heißt one/other', () => {
    const visit = (tree: MessageTree, path: string): void => {
      for (const [key, value] of Object.entries(tree)) {
        if (typeof value === 'string') {
          continue;
        }
        if (isPluralMessage(value)) {
          expect(value.other, `${path}${key}`).toContain('{count}');
          continue;
        }
        expect(Object.keys(value), `${path}${key}`).not.toContain('one');
        visit(value, `${path}${key}.`);
      }
    };
    visit(de, '');
    visit(en, '');
  });

  it('englische Texte sind übersetzt (keine deutschen Umlaute außer in Sprachnamen)', () => {
    const allowed = new Set(['settings.language.de', 'palette.languageSwitch']);
    for (const [key, value] of flatEn) {
      if (allowed.has(key)) {
        continue;
      }
      for (const text of textsOf(value)) {
        expect(text, key).not.toMatch(/[äöüÄÖÜß]/);
      }
    }
  });

  it('beide Kataloge sind registriert', () => {
    expect(languages).toEqual(['de', 'en']);
    expect(catalogs.de).toBe(de);
    expect(catalogs.en).toBe(en);
  });
});

describe('Übersetzer', () => {
  it('liefert Texte der Sprache und setzt Platzhalter ein', () => {
    const deT = createTranslator('de');
    const enT = createTranslator('en');
    expect(deT.t('nav.label')).toBe('Hauptnavigation');
    expect(enT.t('nav.label')).toBe('Main navigation');
    expect(deT.t('phase.comingIn', { phase: 'P3' })).toBe('Folgt in P3');
    expect(enT.t('phase.comingIn', { phase: 'P3' })).toBe('Coming in P3');
    expect(deT.locale).toBe('de-DE');
    expect(enT.locale).toBe('en-US');
  });

  it('wählt die Mehrzahl-Form und formatiert die Zahl', () => {
    const deT = createTranslator('de');
    const enT = createTranslator('en');
    expect(deT.tp('dashboard.activity.count', 1)).toBe('1 Ereignis');
    expect(deT.tp('dashboard.activity.count', 0)).toBe('0 Ereignisse');
    expect(deT.tp('dashboard.activity.count', 1200)).toBe('1.200 Ereignisse');
    expect(enT.tp('dashboard.activity.count', 1)).toBe('1 event');
    expect(enT.tp('dashboard.activity.count', 1200)).toBe('1,200 events');
  });

  it('unbekannte Schlüssel ergeben den Schlüssel selbst (sichtbar, kein Absturz)', () => {
    const translator = createTranslator('de');
    expect(translator.t('gibt.es.nicht' as never)).toBe('gibt.es.nicht');
    expect(translator.tp('nav.label' as never, 2)).toBe('nav.label');
    expect(translator.t('dashboard.activity.count' as never)).toBe('dashboard.activity.count');
  });

  it('interpolate: fehlende Werte bleiben stehen, Zahlen werden Text', () => {
    expect(interpolate('{a} und {b}', { a: 1 })).toBe('1 und {b}');
    expect(interpolate('ohne', undefined)).toBe('ohne');
    expect(interpolate('{x}{x}', { x: 'y' })).toBe('yy');
  });

  it('Systemsprache: erste deutsche oder englische Angabe gewinnt, sonst Deutsch', () => {
    expect(detectLanguage(['de-AT', 'en-US'])).toBe('de');
    expect(detectLanguage(['fr-FR', 'en-GB', 'de'])).toBe('en');
    expect(detectLanguage(['EN_us'])).toBe('en');
    expect(detectLanguage(['fr', 'es'])).toBe('de');
    expect(detectLanguage([])).toBe('de');
  });

  it('Gebietsschema: das passende des Systems, sonst der Standard der Sprache', () => {
    expect(localeFor('de', ['de-CH', 'en-US'])).toBe('de-CH');
    expect(localeFor('en', ['de-DE', 'en-GB'])).toBe('en-GB');
    expect(localeFor('en', ['fr-FR'])).toBe('en-US');
    expect(localeFor('de', ['de-!!'])).toBe('de-DE');
  });
});
