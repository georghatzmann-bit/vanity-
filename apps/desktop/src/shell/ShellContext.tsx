import { createContext, use, type RefObject } from 'react';

/** Aktionen der Shell, die Seiten auslösen dürfen (z. B. Schnellzugriff im Dashboard). */
export interface ShellActions {
  readonly openPalette: () => void;
  readonly replayBoot: () => void;
  /** Ziel für den Fokus nach dem Start und nach einem Seitenwechsel (h1 der Seite). */
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}

export const ShellContext = createContext<ShellActions | null>(null);

export function useShell(): ShellActions {
  const shell = use(ShellContext);
  if (shell === null) {
    throw new Error('useShell: keine Shell vorhanden.');
  }
  return shell;
}
