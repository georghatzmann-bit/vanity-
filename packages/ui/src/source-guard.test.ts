import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * „Trojan Source“-Schutz: Der Quelltext des Design-Systems enthält keine rohen Bidi-Steuer-
 * oder Nullbreite-Zeichen. Wo Tests oder Beispiele sie brauchen, stehen sie als Escape.
 * Die verbotenen Zeichen sind hier bewusst nur als Zahlen notiert.
 */
const FORBIDDEN_CODE_POINTS = new Set([
  // Bidi: LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI, ALM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c,
  // Nullbreite und Richtungsmarken: ZWSP, ZWNJ, ZWJ, LRM, RLM, WJ, BOM
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff,
]);

function containsForbidden(text: string): boolean {
  for (const character of text) {
    if (FORBIDDEN_CODE_POINTS.has(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

const root = join(import.meta.dirname, '..');
const folders = ['src', 'showcase', 'scripts'];

function sourceFiles(folder: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      entries.push(...sourceFiles(path));
    } else if (/\.(tsx?|css|mjs|html)$/.test(name)) {
      entries.push(path);
    }
  }
  return entries;
}

describe('Quelltext-Wächter', () => {
  it('erkennt verbotene Zeichen', () => {
    expect(containsForbidden(`a${String.fromCodePoint(0x202e)}b`)).toBe(true);
    expect(containsForbidden('Überspringen ⟨U+202E⟩')).toBe(false);
  });

  it('enthält keine rohen Bidi- oder Nullbreite-Zeichen', () => {
    const files = folders.flatMap((folder) => sourceFiles(join(root, folder)));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files
      .filter((file) => containsForbidden(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
