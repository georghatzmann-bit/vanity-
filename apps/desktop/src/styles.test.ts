// @vitest-environment node
/**
 * App-Vorgabe „Bewegung: Reduziert“ in CSS: Tailwinds `motion-reduce:*`-Varianten sind
 * Media-Queries und kennen die App-Einstellung nicht. `styles.css` spiegelt deshalb jede
 * benutzte Variante für `:root[data-motion='reduced']` – kommt eine neue hinzu, fällt es hier auf.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repo = new URL('../../../', import.meta.url);
const styles = readFileSync(new URL('styles.css', import.meta.url), 'utf8');

/** Quelldateien (ohne Tests) der App und von @aegis/ui. */
function sources(): string[] {
  return ['apps/desktop/src/', 'packages/ui/src/'].flatMap((dir) =>
    readdirSync(new URL(dir, repo), { recursive: true, encoding: 'utf8' })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => readFileSync(new URL(`${dir}${file}`, repo), 'utf8')),
  );
}

describe('styles.css: „Bewegung: Reduziert“ erreicht auch motion-reduce:*', () => {
  const used = [
    ...new Set(sources().flatMap((text) => [...text.matchAll(/motion-reduce:([\w-]+)/g)])),
  ]
    .map(([, utility]) => utility ?? '')
    .filter((utility, index, all) => all.indexOf(utility) === index)
    .sort();

  it('findet die Varianten in den Quellen', () => {
    expect(used).toEqual(expect.arrayContaining(['animate-none', 'hidden']));
  });

  it('spiegelt jede benutzte Variante für data-motion="reduced"', () => {
    for (const utility of used) {
      const selector = `:root[data-motion='reduced'] .motion-reduce\\:${utility} {`;
      expect(styles, `fehlt: ${selector}`).toContain(selector);
    }
  });

  it('die Spiegelregeln schalten wirklich ab (!important, wie die Media-Query)', () => {
    expect(styles).toMatch(/\.motion-reduce\\:hidden \{\s*display: none !important;/);
    expect(styles).toMatch(/\.motion-reduce\\:animate-none \{\s*animation: none !important;/);
  });
});
