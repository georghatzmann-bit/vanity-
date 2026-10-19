import { useId } from 'react';

/**
 * Eindeutige, CSS-/URL-sichere ID für SVG-Ressourcen (Verläufe, Masken). React-IDs können
 * Sonderzeichen enthalten, die in `url(#…)` stören – daher bereinigt und mit Präfix.
 */
export function useSvgId(prefix: string): string {
  const raw = useId();
  return `${prefix}-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
