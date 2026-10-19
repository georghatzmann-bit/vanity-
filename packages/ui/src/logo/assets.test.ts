// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { themes } from '../tokens/tokens.ts';
import {
  fillShape,
  innerMark,
  outline,
  scanLine,
  wordmarkFill,
  wordmarkStroke,
} from './geometry.ts';
import { appIconSize, renderLogoAssets } from './svg.ts';

const assets = renderLogoAssets();

function readAsset(name: string): string {
  return readFileSync(new URL(`../../assets/${name}`, import.meta.url), 'utf8');
}

describe('Logo-Assets (packages/ui/assets)', () => {
  it.each(Object.keys(assets))(
    '%s entspricht exakt der Ausgabe des Generators (sonst: pnpm --filter @aegis/ui export-logo)',
    (name) => {
      expect(readAsset(name)).toBe(assets[name]);
    },
  );

  it('enthalten die Pfaddaten aus geometry.ts', () => {
    for (const name of ['logo-mark.svg', 'logo-mark-mono.svg']) {
      const svg = readAsset(name);
      expect(svg).toContain(`d="${fillShape}"`);
      expect(svg).toContain(`d="${innerMark}"`);
      expect(svg).toContain(`d="${scanLine}"`);
    }
    const full = readAsset('logo-full.svg');
    for (const path of [outline, innerMark, scanLine, wordmarkFill, wordmarkStroke]) {
      expect(full).toContain(`d="${path}"`);
    }
  });

  it('App-Icon: 1024 × 1024, Farben aus den Tokens, ohne CSS-Variablen oder Schriften', () => {
    const icon = readAsset('logo-mark.svg');
    expect(appIconSize).toBe(1024);
    expect(icon).toContain('width="1024" height="1024" viewBox="0 0 1024 1024"');
    expect(icon).toContain(themes.dark.colors.accent);
    expect(icon).toContain(themes.dark.colors['accent-strong']);
    expect(icon).not.toMatch(/var\(|<text|font-family|<image|href="http/);
  });

  it('Mono-Zeichen nutzt ausschließlich currentColor', () => {
    const mono = readAsset('logo-mark-mono.svg');
    expect(mono).toContain('fill="currentColor"');
    expect(mono).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
