// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.ts';
import { riskLevels } from './risk.ts';
import {
  colorTokenNames,
  colorVar,
  colorVarName,
  cubicBezierToCss,
  durations,
  easings,
  fonts,
  msToSeconds,
  radii,
  shadowTokenNames,
  springs,
  themeNames,
  themes,
  tracking,
  typeScale,
  type ColorToken,
  type ThemeName,
} from './tokens.ts';

type Declarations = ReadonlyMap<string, string>;

/** Minimaler CSS-Leser: liefert je innerstem Block (Selektor) die Custom Properties. */
function parseCustomProperties(css: string): Map<string, Declarations> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = new Map<string, Declarations>();
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ');
    const declarations = new Map<string, string>();
    for (const declaration of (match[2] ?? '').split(';')) {
      const colon = declaration.indexOf(':');
      const name = declaration.slice(0, colon).trim();
      if (colon < 0 || !name.startsWith('--')) {
        continue;
      }
      declarations.set(
        name,
        declaration
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, ' '),
      );
    }
    blocks.set(selector, declarations);
  }
  return blocks;
}

// Hinweis: Vitest ersetzt CSS-Importe (auch ?raw) durch leere Strings – daher direkt lesen.
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const blocks = parseCustomProperties(css);

function block(selector: string): Declarations {
  const found = blocks.get(selector);
  if (found === undefined) {
    throw new Error(`Block „${selector}“ fehlt in tokens.css`);
  }
  return found;
}

const staticBlock = block(':root');
const themeBlocks: Record<ThemeName, Declarations> = {
  dark: block(":root, [data-theme='dark']"),
  light: block("[data-theme='light']"),
};
const tailwindTheme = block('@theme inline');

function expectedStaticProperties(): Map<string, string> {
  const expected = new Map<string, string>();
  for (const [name, value] of Object.entries(radii)) {
    expected.set(`--aegis-radius-${name}`, value);
  }
  for (const [name, value] of Object.entries(fonts)) {
    expected.set(`--aegis-font-${name}`, value);
  }
  for (const [name, step] of Object.entries(typeScale)) {
    expected.set(`--aegis-font-size-${name}`, step.size);
    expected.set(`--aegis-line-height-${name}`, step.lineHeight);
  }
  for (const [name, value] of Object.entries(tracking)) {
    expected.set(`--aegis-tracking-${name}`, value);
  }
  for (const [name, value] of Object.entries(durations)) {
    expected.set(`--aegis-duration-${name}`, `${value}ms`);
  }
  for (const [name, curve] of Object.entries(easings)) {
    expected.set(`--aegis-ease-${name}`, cubicBezierToCss(curve));
  }
  return expected;
}

function expectedThemeProperties(theme: ThemeName): Map<string, string> {
  const expected = new Map<string, string>();
  for (const token of colorTokenNames) {
    expected.set(colorVarName(token), themes[theme].colors[token]);
  }
  for (const token of shadowTokenNames) {
    expected.set(`--aegis-shadow-${token}`, themes[theme].shadows[token]);
  }
  return expected;
}

describe('tokens.css ↔ tokens.ts (eine Quelle der Wahrheit)', () => {
  it('themenunabhängige Werte stimmen exakt überein (in beide Richtungen)', () => {
    expect(Object.fromEntries(staticBlock)).toEqual(Object.fromEntries(expectedStaticProperties()));
  });

  it.each(themeNames)('Theme „%s“: Farben und Schatten stimmen exakt überein', (theme) => {
    expect(Object.fromEntries(themeBlocks[theme])).toEqual(
      Object.fromEntries(expectedThemeProperties(theme)),
    );
  });

  it('beide Themes definieren dieselben Tokens', () => {
    expect([...themeBlocks.light.keys()].sort()).toEqual([...themeBlocks.dark.keys()].sort());
  });

  it('jedes Farb-Token ist als Tailwind-Farbe abgebildet (inline → Teilbaum-Theming)', () => {
    for (const token of colorTokenNames) {
      expect(tailwindTheme.get(`--color-${token}`)).toBe(`var(--aegis-${token})`);
    }
    for (const token of shadowTokenNames) {
      expect(tailwindTheme.get(`--shadow-${token}`)).toBe(`var(--aegis-shadow-${token})`);
    }
    expect(tailwindTheme.get('--color-*')).toBe('initial');
  });

  it('jede Tailwind-Abbildung verweist auf eine definierte --aegis-Variable', () => {
    const defined = new Set([...staticBlock.keys(), ...themeBlocks.dark.keys()]);
    for (const [name, value] of tailwindTheme) {
      if (name === '--color-*') {
        continue;
      }
      const reference = /^var\((--aegis-[a-z0-9-]+)\)$/.exec(value)?.[1];
      expect(reference, `${name} muss auf eine --aegis-Variable zeigen`).toBeDefined();
      expect(defined.has(reference ?? ''), `${reference ?? name} ist nicht definiert`).toBe(true);
    }
  });

  it('Hilfsfunktionen liefern konsistente Werte', () => {
    expect(colorVar('accent')).toBe(`var(--aegis-accent, ${themes.dark.colors.accent})`);
    expect(msToSeconds(durations.fast)).toBe(0.15);
    expect(springs.snappy.type).toBe('spring');
    expect(cubicBezierToCss(easings.standard)).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });
});

describe('WCAG-AA-Kontrast in beiden Themes', () => {
  const surfaces = ['bg', 'surface-1', 'surface-2', 'surface-3'] as const satisfies ColorToken[];

  describe.each(themeNames)('Theme „%s“', (theme) => {
    const c = themes[theme].colors;
    const ratio = (fg: ColorToken, bg: ColorToken): number => contrastRatio(c[fg], c[bg]);

    it.each(surfaces)('text und text-muted auf %s ≥ 4,5', (surface) => {
      expect(ratio('text', surface)).toBeGreaterThanOrEqual(4.5);
      expect(ratio('text-muted', surface)).toBeGreaterThanOrEqual(4.5);
    });

    it('text-subtle auf bg ≥ 3,0', () => {
      expect(ratio('text-subtle', 'bg')).toBeGreaterThanOrEqual(3);
    });

    it('accent auf bg ≥ 4,5 und on-accent auf accent/accent-strong ≥ 4,5', () => {
      expect(ratio('accent', 'bg')).toBeGreaterThanOrEqual(4.5);
      expect(ratio('on-accent', 'accent')).toBeGreaterThanOrEqual(4.5);
      expect(ratio('on-accent', 'accent-strong')).toBeGreaterThanOrEqual(4.5);
    });

    it.each(['success', 'warn', 'danger'] as const)('%s auf bg ≥ 4,5', (token) => {
      expect(ratio(token, 'bg')).toBeGreaterThanOrEqual(4.5);
    });

    it.each(riskLevels)(
      'Risikostufe „%s“ als Text auf bg, surface-1 und eigener Fläche ≥ 4,5',
      (level) => {
        expect(ratio(`risk-${level}`, 'bg')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(`risk-${level}`, 'surface-1')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(`risk-${level}`, `risk-${level}-subtle`)).toBeGreaterThanOrEqual(4.5);
        expect(ratio('text', `risk-${level}-subtle`)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it('Fokusring und kräftige Rahmen erfüllen 3 : 1 (WCAG 1.4.11)', () => {
      for (const surface of surfaces) {
        expect(ratio('focus', surface)).toBeGreaterThanOrEqual(3);
      }
      expect(ratio('border-strong', 'bg')).toBeGreaterThanOrEqual(3);
      expect(ratio('border-strong', 'surface-1')).toBeGreaterThanOrEqual(3);
    });
  });
});
