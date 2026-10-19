import { describe, expect, it } from 'vitest';
import { foldForSearch, foldWithMap, scoreSearchable, tokenizeQuery } from './search.ts';

describe('Falten für die Suche', () => {
  it('ist akzent- und großschreibungsunabhängig, ß → ss', () => {
    expect(foldForSearch('Überspringen')).toBe('uberspringen');
    expect(foldForSearch('Straße')).toBe('strasse');
    expect(foldForSearch('STRAẞE')).toBe('strasse');
    expect(foldForSearch('Ærø Œuvre Łódź Đakovo ı')).toBe('aero oeuvre lodz dakovo i');
    expect(foldForSearch('Ｆｕｌｌ')).toBe('full');
  });

  it('ordnet gefaltete Stellen dem Original zu', () => {
    const folded = foldWithMap('aßb');
    expect(folded.text).toBe('assb');
    expect(folded.map).toEqual([0, 1, 1, 2]);
    expect(folded.lengths).toEqual([1, 1, 1, 1]);
    const emoji = foldWithMap('😀x');
    expect(emoji.map).toEqual([0, 0, 2]);
    expect(emoji.lengths).toEqual([2, 2, 1]);
  });

  it('zerlegt Anfragen in Wörter', () => {
    expect(tokenizeQuery('  Quarantäne   Wieder ')).toEqual(['quarantane', 'wieder']);
    expect(tokenizeQuery('   ')).toEqual([]);
  });
});

describe('Bewertung', () => {
  const item = { label: 'Überspringen', group: 'Aktionen', keywords: ['skip'] };

  it('findet akzentunabhängig und markiert im Original', () => {
    const result = scoreSearchable('uberspringen', item);
    expect(result).not.toBeNull();
    expect(result?.labelRanges).toEqual([[0, 12]]);
  });

  it('bewertet Anfang > Wortanfang > Teilwort > Teilfolge', () => {
    const exact = scoreSearchable('scan', { label: 'Scan' })?.score ?? 0;
    const prefix = scoreSearchable('scan', { label: 'Scan starten' })?.score ?? 0;
    const word = scoreSearchable('scan', { label: 'Schnell-Scan' })?.score ?? 0;
    const inner = scoreSearchable('scan', { label: 'Virenscanner' })?.score ?? 0;
    const fuzzy = scoreSearchable('sct', { label: 'Scan starten' })?.score ?? 0;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });

  it('findet Teilfolgen über Wortanfänge („qw“ → „Quarantäne-Wiederherstellung“)', () => {
    const result = scoreSearchable('qw', { label: 'Quarantäne-Wiederherstellung' });
    expect(result?.labelRanges).toEqual([
      [0, 1],
      [11, 12],
    ]);
  });

  it('bewertet Abkürzungen unter Teilwörtern, aber über losen Teilfolgen', () => {
    const acronym = scoreSearchable('qw', { label: 'Quarantäne-Wiederherstellung' })?.score ?? 0;
    const inner = scoreSearchable('ran', { label: 'Quarantäne' })?.score ?? 0;
    const loose = scoreSearchable('qrt', { label: 'Quarantäne' })?.score ?? 0;
    expect(acronym).toBeLessThan(inner + 20);
    expect(acronym).toBeGreaterThan(loose);
  });

  it('verwirft zu verstreute Treffer', () => {
    expect(scoreSearchable('ae', { label: 'ab-----------------xe' })).toBeNull();
    expect(scoreSearchable('xyz', { label: 'Dashboard' })).toBeNull();
  });

  it('verlangt jedes Wort (UND) und nutzt Stichwörter und Gruppe schwächer', () => {
    expect(scoreSearchable('skip', item)?.labelRanges).toEqual([]);
    expect(scoreSearchable('aktionen', item)).not.toBeNull();
    expect(scoreSearchable('ueber skip', item)).toBeNull();
    const both = scoreSearchable('spring skip', item);
    expect(both).not.toBeNull();
    const label = scoreSearchable('ueberspringen', { label: 'ueberspringen' })?.score ?? 0;
    const keyword = scoreSearchable('skip', item)?.score ?? 0;
    expect(label).toBeGreaterThan(keyword);
  });

  it('gibt bei leerer Anfrage 0 Punkte und keine Markierung', () => {
    expect(scoreSearchable('', item)).toEqual({ score: 0, labelRanges: [] });
  });

  it('fasst überlappende Markierungen mehrerer Wörter zusammen', () => {
    const result = scoreSearchable('quar quarant', { label: 'Quarantäne' });
    expect(result?.labelRanges).toEqual([[0, 7]]);
  });

  it('markiert bei ß-Faltung den ganzen Original-Buchstaben', () => {
    const result = scoreSearchable('strasse', { label: 'Straße' });
    expect(result?.labelRanges).toEqual([[0, 6]]);
  });
});
