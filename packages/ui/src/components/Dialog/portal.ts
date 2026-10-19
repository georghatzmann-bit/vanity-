import { createContext, use } from 'react';

/**
 * Ziel für Portale (Tooltips u. Ä.). Ein offener Dialog stellt hier seinen eigenen Wurzel-
 * knoten bereit, damit Overlays darin nicht im (inerten) Hintergrund landen.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

/** Aktuelles Portal-Ziel: der umgebende Dialog oder `document.body`. */
export function usePortalContainer(): HTMLElement | null {
  const container = use(PortalContainerContext);
  if (container !== null) {
    return container;
  }
  return typeof document === 'undefined' ? null : document.body;
}
