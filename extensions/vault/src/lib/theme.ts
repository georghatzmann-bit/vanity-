/**
 * Design-Tokens für die Erweiterung: dieselben Farben und Schatten wie die App (aus `@aegis/ui/tokens`),
 * hell/dunkel nach Systemeinstellung. Keine hart codierten Farben in den Seiten.
 */

import { fonts, radii, themes, type ThemeName } from '@aegis/ui/tokens';

function vars(theme: ThemeName): string {
  const colors = Object.entries(themes[theme].colors).map(
    ([name, value]) => `--aegis-${name}:${value};`,
  );
  const shadows = Object.entries(themes[theme].shadows).map(
    ([name, value]) => `--aegis-shadow-${name}:${value};`,
  );
  return [...colors, ...shadows].join('');
}

/** CSS mit allen Farbvariablen für `scope` (z. B. `:root` oder `:host`). */
export function themeCss(scope: string): string {
  return [
    `${scope}{${vars('dark')}color-scheme:dark;--aegis-radius:${radii.lg};--aegis-font:${fonts.sans};}`,
    `@media (prefers-color-scheme: light){${scope}{${vars('light')}color-scheme:light;}}`,
  ].join('');
}

/** Hängt die Variablen an ein Dokument oder einen Schatten-Baum. */
export function applyTheme(target: Document | ShadowRoot, scope: string): void {
  const style = document.createElement('style');
  style.textContent = themeCss(scope);
  if (target instanceof Document) {
    target.head.append(style);
  } else {
    target.prepend(style);
  }
}
