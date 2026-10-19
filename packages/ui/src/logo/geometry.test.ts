// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  fillShape,
  formatNumber,
  innerMark,
  lockup,
  lockupViewBox,
  markGeometry,
  markStrokeWidth,
  outline,
  outlineLeft,
  outlineRight,
  reveal,
  scanLine,
  scanLineSpan,
  wordmarkFill,
  wordmarkGlyphs,
  wordmarkStroke,
  wordmarkViewBox,
  wordmarkWidth,
} from './geometry.ts';

/** Liest alle Zahlenpaare eines Pfads aus M/L-Befehlen (nur absolute Koordinaten). */
function numbers(path: string): number[] {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

function mirrorX(path: string): string {
  return path.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, cmd: string, x: string, y: string) => {
    return `${cmd}${formatNumber(64 - Number(x))} ${y}`;
  });
}

describe('Bildzeichen-Geometrie', () => {
  it('besteht aus zwei exakt gespiegelten Schildhälften, die sich an der Spitze treffen', () => {
    expect(mirrorX(outlineLeft)).toBe(outlineRight);
    expect(outlineLeft.startsWith('M32 4')).toBe(true);
    expect(outlineLeft.endsWith('L32 60')).toBe(true);
    expect(outlineRight.endsWith('L32 60')).toBe(true);
    expect(fillShape).toBe(outline);
    expect(outline.endsWith('Z')).toBe(true);
  });

  it('legt senkrechte und waagerechte Kanten auf das Pixelraster (16 px und 32 px)', () => {
    // Seitenkanten bei x = 10 und 54 → äußere/innere Kante 8/12 bzw. 52/56: Vielfache von 4.
    for (const x of [10, 54]) {
      expect((x - markStrokeWidth / 2) % 4).toBe(0);
      expect((x + markStrokeWidth / 2) % 4).toBe(0);
    }
    expect(outline).toContain('L54 10 V34');
    // Scan-Balken von y = 32 bis 36.
    expect(scanLine).toBe('M18 32 H46 V36 H18 Z');
    expect(scanLineSpan.start).toBeCloseTo(18 / 64);
    expect(scanLineSpan.end).toBeCloseTo(46 / 64);
  });

  it('hat ein symmetrisches Λ mit Strichstärke 4 und waagerechten Füßen', () => {
    const [
      apexX,
      apexY,
      outerFootX,
      footY,
      innerFootX,
      innerApexX,
      innerApexY,
      mirroredInner,
      footY2,
      mirroredOuter,
    ] = numbers(innerMark);
    expect(apexX).toBe(32);
    expect(innerApexX).toBe(32);
    expect(footY).toBe(41);
    expect(footY2).toBe(41);
    expect((outerFootX ?? 0) + (mirroredOuter ?? 0)).toBeCloseTo(64, 1);
    expect((innerFootX ?? 0) + (mirroredInner ?? 0)).toBeCloseTo(64, 1);
    // Senkrechter Abstand der parallelen Schenkelkanten = Strichstärke.
    const dx = (outerFootX ?? 0) - (apexX ?? 0);
    const dy = (footY ?? 0) - (apexY ?? 0);
    const length = Math.hypot(dx, dy);
    const distance =
      Math.abs(dy * ((innerApexX ?? 0) - (apexX ?? 0)) - dx * ((innerApexY ?? 0) - (apexY ?? 0))) /
      length;
    expect(distance).toBeCloseTo(markStrokeWidth, 1);
  });

  it('führt alle Teile in markGeometry zusammen', () => {
    expect(markGeometry).toMatchObject({ viewBox: '0 0 64 64', size: 64, strokeWidth: 4 });
    expect(Object.values(markGeometry).every((v) => v !== '')).toBe(true);
  });

  it('lässt die Zeichen-Masken über Scheitel und Spitze hinauslaufen (vollständige Gehrungen)', () => {
    expect(reveal.outlineLeft).toBe('M32 -2 V4 L10 10 V34 L32 60 V66');
    expect(mirrorX(reveal.outlineLeft)).toBe(reveal.outlineRight);
    expect(mirrorX(reveal.innerLeft)).toBe(reveal.innerRight);
    expect(reveal.outlineWidth).toBeGreaterThan(markStrokeWidth * 2);
  });
});

describe('Schriftzug und Lockup', () => {
  it('setzt die fünf Buchstaben A-E-G-I-S nebeneinander ohne Überlappung', () => {
    expect(wordmarkGlyphs.map((g) => g.char).join('')).toBe('AEGIS');
    for (let i = 1; i < wordmarkGlyphs.length; i += 1) {
      const previous = wordmarkGlyphs[i - 1];
      const current = wordmarkGlyphs[i];
      expect(current && previous && current.x - (previous.x + previous.width)).toBeGreaterThan(5);
    }
    expect(wordmarkViewBox).toBe(`0 0 ${formatNumber(wordmarkWidth)} 20`);
    expect(wordmarkFill.length).toBeGreaterThan(0);
    expect(wordmarkStroke).toMatch(/^M/);
  });

  it('liegt vollständig im eigenen viewBox (0–Breite, 0–20)', () => {
    const fillNumbers = numbers(wordmarkFill);
    expect(Math.min(...fillNumbers)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...fillNumbers)).toBeLessThanOrEqual(wordmarkWidth);
  });

  it('zentriert den Schriftzug vertikal im Lockup', () => {
    expect(lockup.wordmarkY * 2 + 20 * lockup.wordmarkScale).toBeCloseTo(64);
    expect(lockupViewBox).toBe(`0 0 ${formatNumber(lockup.width)} 64`);
  });

  it('formatiert Zahlen kompakt', () => {
    expect(formatNumber(13.1476)).toBe('13.15');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(4)).toBe('4');
  });
});
