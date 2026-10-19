import { describe, expect, it } from 'vitest';
import {
  compositeOver,
  contrastRatio,
  formatContrastRatio,
  meetsContrast,
  minimumContrast,
  parseColor,
  relativeLuminance,
} from './contrast.ts';

describe('parseColor', () => {
  it('liest Hex-Kurz- und Langformen inkl. Alpha', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#22D3EE')).toEqual({ r: 34, g: 211, b: 238, a: 1 });
    expect(parseColor('#00000080').a).toBeCloseTo(128 / 255);
    expect(parseColor('#0008').a).toBeCloseTo(136 / 255);
  });

  it('liest rgb()/rgba() in moderner und klassischer Syntax', () => {
    expect(parseColor('rgb(34 211 238 / 0.35)')).toEqual({ r: 34, g: 211, b: 238, a: 0.35 });
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('rgb(0 0 0 / 50%)').a).toBe(0.5);
    expect(parseColor(' rgb(300 -5 0) ')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('lehnt unbekannte oder kaputte Angaben ab', () => {
    expect(() => parseColor('cyan')).toThrow(TypeError);
    expect(() => parseColor('#12345')).toThrow(TypeError);
    expect(() => parseColor('rgb(1 2)')).toThrow(TypeError);
    expect(() => parseColor('rgb(a b c)')).toThrow(TypeError);
    expect(() => parseColor('rgb(1 2 3 / x)')).toThrow(TypeError);
  });
});

describe('Leuchtdichte und Kontrast', () => {
  it('liefert die Referenzwerte der WCAG', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#22d3ee', '#22d3ee')).toBe(1);
    // Bekannter Grenzfall: #777 auf Weiß verfehlt AA knapp (≈ 4,48).
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.478, 2);
  });

  it('legt transparente Vordergründe über den Hintergrund', () => {
    const half = compositeOver(parseColor('rgb(255 255 255 / 0.5)'), parseColor('#000'));
    expect(half.r).toBeCloseTo(127.5);
    expect(contrastRatio('rgb(255 255 255 / 0)', '#000')).toBe(1);
  });

  it('verlangt deckende Hintergründe', () => {
    expect(() => contrastRatio('#fff', 'rgb(0 0 0 / 0.5)')).toThrow(RangeError);
    expect(() => relativeLuminance('rgb(0 0 0 / 0.5)')).toThrow(RangeError);
  });

  it('kennt die Schwellen von AA/AAA für normalen und großen Text', () => {
    expect(minimumContrast()).toBe(4.5);
    expect(minimumContrast('AA', 'large')).toBe(3);
    expect(minimumContrast('AAA')).toBe(7);
    expect(minimumContrast('AAA', 'large')).toBe(4.5);
    expect(meetsContrast('#767676', '#fff')).toBe(true);
    expect(meetsContrast('#777777', '#fff')).toBe(false);
    expect(meetsContrast('#777777', '#fff', 'AA', 'large')).toBe(true);
  });

  it('formatiert Verhältnisse deutsch und rundet nie zu Gunsten des Kontrasts auf', () => {
    expect(formatContrastRatio(21)).toBe('21,00 : 1');
    expect(formatContrastRatio(4.4999)).toBe('4,49 : 1');
  });
});
