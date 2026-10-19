import { useState, useSyncExternalStore } from 'react';

/** Sichtbarkeit der Seite und Fokus des Fensters als ein Wert (stabil für React). */
function readWindowAttention(): string {
  const visible = document.visibilityState !== 'hidden';
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  return `${visible ? 'visible' : 'hidden'}:${focused ? 'focused' : 'blurred'}`;
}

function subscribeWindowAttention(onChange: () => void): () => void {
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

function serverWindowAttention(): string {
  return 'visible:focused';
}

export interface ConsentAttention {
  /** Der Dialog liegt gerade wirklich vor dem Nutzer – nur dann läuft die Sperrzeit. */
  readonly active: boolean;
  /**
   * Zählt jeden Übergang zu „aktiv“. Steigt der Wert, beginnt die Sperr- bzw. Wartezeit neu
   * (z. B. wenn ein darüberliegender Dialog schließt oder das Fenster wieder nach vorn kommt).
   */
  readonly activation: number;
}

/**
 * Liegt ein Freigabe-Dialog wirklich vor dem Nutzer? Nur dann darf seine Sperrzeit laufen:
 * Er ist der oberste offene Dialog (`onTop`), die Seite ist sichtbar und das Fenster hat den
 * Fokus. Sonst könnte die Sperrzeit verstreichen, während der Dialog verdeckt, minimiert oder
 * im Hintergrund liegt – und der erste Klick beim Hervorholen landete auf „Ja“.
 */
export function useConsentAttention(open: boolean, onTop: boolean): ConsentAttention {
  const attention = useSyncExternalStore(
    subscribeWindowAttention,
    readWindowAttention,
    serverWindowAttention,
  );
  const active = open && onTop && attention === 'visible:focused';
  const [tracked, setTracked] = useState<ConsentAttention>({
    active,
    activation: active ? 1 : 0,
  });
  let current = tracked;
  if (current.active !== active) {
    current = { active, activation: active ? current.activation + 1 : current.activation };
    setTracked(current);
  }
  return current;
}

interface TrackedSession {
  readonly open: boolean;
  /** Zählt die Öffnungen. */
  readonly generation: number;
  readonly fingerprint: string;
  /** Zählt Änderungen am angezeigten Inhalt. */
  readonly revision: number;
  /** Revision beim letzten Öffnen. */
  readonly openedRevision: number;
}

export interface ConsentSession {
  /** Eine Öffnung mit genau diesem Inhalt – höchstens eine Antwort je Sitzung. */
  readonly session: string;
  /** Der angezeigte Inhalt hat sich geändert, während der Dialog offen war. */
  readonly changedWhileOpen: boolean;
}

/**
 * Sitzung eines Freigabe-Dialogs: Jede Öffnung und jede Änderung am angezeigten Inhalt
 * (`fingerprint`) beginnt eine neue – mit neuer Sperrzeit und neuer Antwort. So gilt eine
 * Antwort nie für eine Fassung, die der Nutzer nicht mindestens die Sperrzeit lang gesehen
 * hat, auch wenn die App bei gleicher ID andere Ziele unterschiebt.
 */
export function useConsentSession(open: boolean, fingerprint: string): ConsentSession {
  const [tracked, setTracked] = useState<TrackedSession>(() => ({
    open,
    generation: open ? 1 : 0,
    fingerprint,
    revision: 0,
    openedRevision: 0,
  }));
  let current = tracked;
  if (current.fingerprint !== fingerprint) {
    current = { ...current, fingerprint, revision: current.revision + 1 };
  }
  if (current.open !== open) {
    current = {
      ...current,
      open,
      generation: open ? current.generation + 1 : current.generation,
      openedRevision: open ? current.revision : current.openedRevision,
    };
  }
  if (current !== tracked) {
    setTracked(current);
  }
  return {
    session: `${current.generation}:${current.revision}`,
    changedWhileOpen: open && current.revision !== current.openedRevision,
  };
}
