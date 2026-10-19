import { describe, expect, it } from 'vitest';
import {
  containsRightToLeft,
  formatCodePoint,
  hasInvisibleCharacters,
  invisibleCharacterName,
  invisibleMarker,
  middleTruncateUnits,
  revealInvisibleCharacters,
  splitInvisibleCharacters,
  toSafeTextUnits,
  type SafeTextUnit,
} from './text.ts';

const text = (units: readonly SafeTextUnit[]): string =>
  units.map((unit) => (unit.kind === 'text' ? unit.text : unit.marker)).join('');

describe('unsichtbare Zeichen', () => {
  it('formatiert Code-Points und Marken', () => {
    expect(formatCodePoint(0x202e)).toBe('U+202E');
    expect(formatCodePoint(0x9)).toBe('U+0009');
    expect(formatCodePoint(0xe0041)).toBe('U+E0041');
    expect(invisibleMarker(0x202e)).toBe('⟨U+202E⟩');
    expect(invisibleCharacterName(0x202e)).toBe('RLO');
    expect(invisibleCharacterName(0x41)).toBeUndefined();
  });

  it.each([
    ['RLO (Bidi-Override)', '\u202E'],
    ['LRO', '\u202D'],
    ['RLE', '\u202B'],
    ['PDF', '\u202C'],
    ['LRI', '\u2066'],
    ['RLI', '\u2067'],
    ['FSI', '\u2068'],
    ['PDI', '\u2069'],
    ['LRM', '\u200E'],
    ['RLM', '\u200F'],
    ['ALM', '\u061C'],
    ['Nullbreite (ZWSP)', '\u200B'],
    ['ZWNJ', '\u200C'],
    ['ZWJ', '\u200D'],
    ['Wortverbinder', '\u2060'],
    ['BOM', '\uFEFF'],
    ['weiches Trennzeichen', '\u00AD'],
    ['geschütztes Leerzeichen', '\u00A0'],
    ['Geviert-Leerzeichen', '\u2003'],
    ['Ideogramm-Leerzeichen', '\u3000'],
    ['Zeilentrenner', '\u2028'],
    ['Absatztrenner', '\u2029'],
    ['Tab', '\t'],
    ['Zeilenumbruch', '\n'],
    ['NUL', '\0'],
    ['DEL', '\u007F'],
    ['C1-Steuerzeichen', '\u0085'],
    ['Hangul-Füller', '\u3164'],
    ['Variantenselektor', '\uFE0F'],
    ['Tag-Zeichen', '\u{E0041}'],
    ['einzelnes Surrogat', '\uD800'],
  ])('maskiert %s', (_name, character) => {
    const value = `a${character}b`;
    expect(hasInvisibleCharacters(value)).toBe(true);
    const revealed = revealInvisibleCharacters(value);
    expect(revealed).not.toContain(character);
    expect(revealed).toMatch(/^a⟨U\+[0-9A-F]{4,6}⟩b$/);
  });

  it('lässt normale Zeichen inklusive Leerzeichen, Umlauten und Pfadzeichen unverändert', () => {
    const value = 'C:\\Users\\Jörg Müller\\Übersicht (2).pdf';
    expect(hasInvisibleCharacters(value)).toBe(false);
    expect(revealInvisibleCharacters(value)).toBe(value);
    expect(splitInvisibleCharacters(value)).toEqual([{ kind: 'text', text: value }]);
  });

  it('zerlegt in Text und Marken', () => {
    expect(splitInvisibleCharacters('x\u202Eyz\u200B')).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'invisible', codePoint: 0x202e, marker: '⟨U+202E⟩', name: 'RLO' },
      { kind: 'text', text: 'yz' },
      { kind: 'invisible', codePoint: 0x200b, marker: '⟨U+200B⟩', name: 'ZWSP' },
    ]);
    expect(splitInvisibleCharacters('')).toEqual([]);
  });

  it('erkennt Schrift mit Leserichtung rechts-nach-links', () => {
    expect(containsRightToLeft('Bericht_שלום.pdf')).toBe(true);
    expect(containsRightToLeft('تقرير.exe')).toBe(true);
    expect(containsRightToLeft('Bericht.pdf')).toBe(false);
  });
});

describe('Kürzung in der Mitte', () => {
  it('lässt kurze Werte unverändert', () => {
    const units = toSafeTextUnits('C:\\kurz.txt');
    expect(middleTruncateUnits(units, 40)).toEqual({ head: units, tail: [], truncated: false });
  });

  it('behält bei Pfaden den Dateinamen vollständig', () => {
    const path = 'C:\\Users\\Beispiel\\AppData\\Local\\Temp\\ordner\\ordner\\setup_v2.4.1.exe';
    const result = middleTruncateUnits(toSafeTextUnits(path), 32);
    expect(result.truncated).toBe(true);
    expect(text(result.tail)).toBe('\\setup_v2.4.1.exe');
    expect(text(result.head)).toBe('C:\\Users\\Beisp');
    expect(result.head.length + result.tail.length + 1).toBe(32);
  });

  it('teilt sehr lange Dateinamen ohne Pfad 40/60', () => {
    const name = 'x'.repeat(100);
    const result = middleTruncateUnits(toSafeTextUnits(name), 21);
    expect(result.head.length).toBe(8);
    expect(result.tail.length).toBe(12);
  });

  it('zerteilt weder Marken noch Grapheme', () => {
    const value = `${'a'.repeat(20)}\u202E${'👍🏽'.repeat(10)}`;
    const units = toSafeTextUnits(value);
    expect(units.filter((unit) => unit.kind === 'invisible')).toHaveLength(1);
    expect(units.filter((unit) => unit.kind === 'text' && unit.text === '👍🏽')).toHaveLength(10);
    const result = middleTruncateUnits(units, 12);
    for (const unit of [...result.head, ...result.tail]) {
      if (unit.kind === 'text') {
        expect(['a', '👍🏽']).toContain(unit.text);
      }
    }
  });

  it('erzwingt eine Mindestlänge', () => {
    const result = middleTruncateUnits(toSafeTextUnits('abcdefghijkl'), 1);
    expect(result.head.length + result.tail.length + 1).toBe(5);
  });

  it('fällt ohne Intl.Segmenter auf Code-Points zurück', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
    try {
      expect(toSafeTextUnits('äb')).toEqual([
        { kind: 'text', text: 'ä' },
        { kind: 'text', text: 'b' },
      ]);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(Intl, 'Segmenter', descriptor);
      }
    }
  });
});
