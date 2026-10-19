/**
 * App-Vorgabe „Bewegung: Reduziert“ – wirkt überall, auch in @aegis/ui.
 *
 * Die Komponenten von @aegis/ui (und die Start-Animation) fragen die Systemeinstellung direkt
 * über `matchMedia('(prefers-reduced-motion: reduce)')` ab und bieten keinen Schalter dafür.
 * Damit die Einstellung der App trotzdem *überall* gilt, ersetzt diese Datei genau diese eine
 * Abfrage durch eine Liste, die „reduziert“ meldet, wenn das System *oder* die App es will –
 * live, mit `change`-Ereignissen. Alle anderen Media-Queries gehen unverändert an den Browser.
 * CSS-Media-Queries erreicht das nicht; dafür setzt die App `data-motion="reduced"` auf
 * `<html>` (siehe `styles.css`), und Motion bekommt die Vorgabe über `MotionConfig`.
 *
 * Rein darstellungsbezogen: Es ändert nichts am System und liest nichts aus.
 */
import { REDUCED_MOTION_QUERY } from '@aegis/ui';

type MatchMedia = (query: string) => MediaQueryList;

/** Vergleicht Media-Queries ohne Leerraum und Groß-/Kleinschreibung. */
function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, '').toLowerCase();
}

const reducedQuery = normalizeQuery(REDUCED_MOTION_QUERY);

function changeEvent(media: string, matches: boolean): MediaQueryListEvent {
  if (typeof MediaQueryListEvent === 'function') {
    return new MediaQueryListEvent('change', { media, matches });
  }
  return Object.assign(new Event('change'), { media, matches });
}

/** Media-Query-Liste mit berechnetem `matches` (System oder App-Vorgabe). */
class DerivedMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media: string;
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;
  readonly #read: () => boolean;

  constructor(media: string, read: () => boolean) {
    super();
    this.media = media;
    this.#read = read;
  }

  get matches(): boolean {
    return this.#read();
  }

  /** Veraltete API (ältere WebViews) – wie `addEventListener('change', …)`. */
  addListener(
    listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null,
  ): void {
    if (listener !== null) {
      this.addEventListener('change', listener as EventListener);
    }
  }

  removeListener(
    listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null,
  ): void {
    if (listener !== null) {
      this.removeEventListener('change', listener as EventListener);
    }
  }

  notify(): void {
    const event = changeEvent(this.media, this.matches);
    this.dispatchEvent(event);
    this.onchange?.call(this, event);
  }
}

export interface ReducedMotionController {
  /** Wünscht das *System* reduzierte Bewegung (ohne App-Vorgabe)? */
  systemPrefersReduced(): boolean;
  /** Änderungen der Systemeinstellung. */
  subscribeSystem(listener: () => void): () => void;
  /** App-Vorgabe: `true` = immer reduziert, `false` = wie im System. */
  setForced(forced: boolean): void;
  /** Gilt gerade reduzierte Bewegung (System oder App)? */
  isReduced(): boolean;
  /** Stellt `matchMedia` wieder her (für Tests). */
  uninstall(): void;
}

/**
 * Installiert die abgeleitete Abfrage auf `target.matchMedia`. Muss vor dem ersten Rendern
 * laufen – die Start-Animation liest den Wert beim Einhängen.
 */
export function installReducedMotionOverride(target: Window): ReducedMotionController {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, 'matchMedia');
  const original: MatchMedia | null =
    typeof target.matchMedia === 'function' ? target.matchMedia.bind(target) : null;

  let system: MediaQueryList | null = null;
  try {
    system = original?.(REDUCED_MOTION_QUERY) ?? null;
  } catch {
    system = null;
  }

  let forced = false;
  const systemListeners = new Set<() => void>();
  const derived = new DerivedMediaQueryList(
    REDUCED_MOTION_QUERY,
    () => forced || (system?.matches ?? false),
  );
  const onSystemChange = (): void => {
    for (const listener of [...systemListeners]) {
      listener();
    }
    derived.notify();
  };
  if (system !== null) {
    if (typeof system.addEventListener === 'function') {
      system.addEventListener('change', onSystemChange);
    } else {
      system.addListener(onSystemChange);
    }
  }

  /** Ohne Browser-`matchMedia` (z. B. jsdom): andere Abfragen treffen nie zu. */
  const inert = (query: string): MediaQueryList => new DerivedMediaQueryList(query, () => false);

  const matchMedia: MatchMedia = (query) =>
    normalizeQuery(query) === reducedQuery ? derived : (original ?? inert)(query);

  Object.defineProperty(target, 'matchMedia', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: matchMedia,
  });

  return {
    systemPrefersReduced: () => system?.matches ?? false,
    subscribeSystem(listener) {
      systemListeners.add(listener);
      return () => {
        systemListeners.delete(listener);
      };
    },
    setForced(next) {
      if (next !== forced) {
        forced = next;
        derived.notify();
      }
    },
    isReduced: () => derived.matches,
    uninstall() {
      if (system !== null) {
        if (typeof system.removeEventListener === 'function') {
          system.removeEventListener('change', onSystemChange);
        } else {
          system.removeListener(onSystemChange);
        }
      }
      if (ownDescriptor === undefined) {
        Reflect.deleteProperty(target, 'matchMedia');
      } else {
        Object.defineProperty(target, 'matchMedia', ownDescriptor);
      }
    },
  };
}
