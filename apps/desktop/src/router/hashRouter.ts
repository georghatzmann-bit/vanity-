/**
 * Kleiner, typisierter Hash-Router (keine Abhängigkeit): Die Adresse `#/seite` ist die einzige
 * Quelle der aktuellen Seite. Vor/Zurück funktionieren über die Browser-Historie; unbekannte
 * Adressen werden (ohne neuen Historien-Eintrag) auf das Dashboard umgeleitet.
 */
import { DEFAULT_ROUTE, hashFor, parseHash, type RouteId } from './routes.ts';

export interface HashRouter {
  getSnapshot(): RouteId;
  subscribe(listener: () => void): () => void;
  /** Wechselt die Seite; `replace` ersetzt den Historien-Eintrag statt einen neuen anzulegen. */
  navigate(route: RouteId, options?: { readonly replace?: boolean }): void;
  /** Meldet den `hashchange`-Empfänger ab (für Tests). */
  dispose(): void;
}

export function createHashRouter(win: Window): HashRouter {
  const listeners = new Set<() => void>();
  let current: RouteId = DEFAULT_ROUTE;

  const replaceHash = (route: RouteId): void => {
    win.history.replaceState(win.history.state, '', hashFor(route));
  };

  const sync = (): boolean => {
    const parsed = parseHash(win.location.hash);
    if (parsed === null) {
      replaceHash(DEFAULT_ROUTE);
    }
    const next = parsed ?? DEFAULT_ROUTE;
    if (next === current) {
      return false;
    }
    current = next;
    return true;
  };

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const onHashChange = (): void => {
    if (sync()) {
      notify();
    }
  };

  sync();
  win.addEventListener('hashchange', onHashChange);

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigate(route, options) {
      if (options?.replace === true) {
        replaceHash(route);
        onHashChange();
        return;
      }
      if (route === current && parseHash(win.location.hash) === route) {
        return;
      }
      // Setzt einen neuen Historien-Eintrag; `hashchange` meldet den Wechsel.
      win.location.hash = hashFor(route);
    },
    dispose() {
      win.removeEventListener('hashchange', onHashChange);
      listeners.clear();
    },
  };
}
