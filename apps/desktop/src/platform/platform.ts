/**
 * Plattform-Adapter: die einzige Stelle, an der die Oberfläche mit Tauri spricht.
 *
 * - In der Desktop-App (`isTauri()`) gehen die Aufrufe an die Fenster-API und den App-Befehl
 *   `app_info` – genau die Rechte aus `src-tauri/capabilities/default.json`, nicht mehr.
 * - In einem normalen Browser (Vite-Vorschau, Playwright) gibt es keinen Rust-Teil: Fenster-
 *   steuerung fehlt (`window: null`), `app_info` liefert gekennzeichnete Vorschau-Werte und
 *   Tray-Ereignisse kommen nie. So läuft die Oberfläche überall, ohne etwas vorzutäuschen.
 *
 * Bewusst nicht vorhanden: Senden von Ereignissen an das Backend, Zerstören von Fenstern,
 * `onCloseRequested` (bräuchte `allow-destroy`, siehe README „Bewusst nicht gewährt“).
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { version as configuredVersion } from '../../src-tauri/tauri.conf.json';
import { parseAppInfo, previewAppInfo, type AppInfo } from './appInfo.ts';

/** Meldet einen Empfänger wieder ab. */
export type Unlisten = () => void;

/** Seiten, die das Tray-Menü öffnen kann (`aegis://navigate`, Rust: `tray::Page`). */
export type NavigateTarget = 'dashboard' | 'settings';

/** Ereignis Rust → Oberfläche aus dem Tray-Menü. */
export const NAVIGATE_EVENT = 'aegis://navigate';

/** Fenstersteuerung der eigenen Titelleiste (rahmenloses Fenster). */
export interface WindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  /** Nur lesend – für das passende Symbol (Maximieren / Wiederherstellen). */
  isMaximized(): Promise<boolean>;
  /** Größenänderung des Fensters (auch nach Maximieren, Andocken …). */
  onResized(handler: () => void): Promise<Unlisten>;
  /** Fenster verstecken – AEGIS läuft im Infobereich weiter. */
  hide(): Promise<void>;
  /** Fenster schließen – beendet AEGIS vollständig (Rust: jede Schließ-Anforderung = Ende). */
  close(): Promise<void>;
}

export interface Platform {
  readonly kind: 'tauri' | 'browser';
  /** `null` in der Browser-Vorschau: dort gibt es keine Fensterknöpfe. */
  readonly window: WindowApi | null;
  /** Version, Build-Profil, Plattform (einmal ermittelt, danach aus dem Zwischenspeicher). */
  appInfo(): Promise<AppInfo>;
  /** Tray-Menü „Dashboard“ / „Einstellungen“. In der Vorschau kommt nie ein Ereignis. */
  onNavigate(handler: (target: NavigateTarget) => void): Promise<Unlisten>;
}

/** Prüft die Nutzdaten von `aegis://navigate`; Unbekanntes wird ignoriert (`null`). */
export function parseNavigatePayload(payload: unknown): NavigateTarget | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const page = (payload as { readonly page?: unknown }).page;
  return page === 'dashboard' || page === 'settings' ? page : null;
}

/** Merkt sich ein einmal begonnenes Ergebnis; ein Fehlschlag darf später erneut versucht werden. */
function memoize<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/** Echte Desktop-App: Aufrufe über `@tauri-apps/api` an das Hauptfenster. */
export function createTauriPlatform(): Platform {
  const current = getCurrentWindow();
  return {
    kind: 'tauri',
    window: {
      minimize: () => current.minimize(),
      toggleMaximize: () => current.toggleMaximize(),
      isMaximized: () => current.isMaximized(),
      onResized: (handler) => current.onResized(() => handler()),
      hide: () => current.hide(),
      close: () => current.close(),
    },
    appInfo: memoize(async () => parseAppInfo(await invoke<unknown>('app_info'))),
    onNavigate: (handler) =>
      current.listen<unknown>(NAVIGATE_EVENT, (event) => {
        const target = parseNavigatePayload(event.payload);
        if (target !== null) {
          handler(target);
        }
      }),
  };
}

/** Browser-Vorschau: keine Fensterknöpfe, keine Tray-Ereignisse, gekennzeichnete Werte. */
export function createBrowserPlatform(info: AppInfo): Platform {
  return {
    kind: 'browser',
    window: null,
    appInfo: () => Promise.resolve(info),
    onNavigate: () => Promise.resolve(() => undefined),
  };
}

/** Wählt den Adapter passend zur Laufzeit (Tauri-WebView oder normaler Browser). */
export function detectPlatform(): Platform {
  if (isTauri()) {
    return createTauriPlatform();
  }
  return createBrowserPlatform(previewAppInfo(configuredVersion, import.meta.env.DEV));
}

/** Meldet einen Fehler eines Plattform-Aufrufs, ohne die Oberfläche abstürzen zu lassen. */
export function reportPlatformError(action: string, error: unknown): void {
  console.error(`AEGIS: ${action} fehlgeschlagen`, error);
}

/** Ruft eine Abmeldung auf und fängt synchrone wie asynchrone Fehler ab. */
function callUnlisten(unlisten: Unlisten): void {
  try {
    const result: unknown = unlisten();
    if (result instanceof Promise) {
      result.catch((error: unknown) => reportPlatformError('Abmelden', error));
    }
  } catch (error) {
    reportPlatformError('Abmelden', error);
  }
}

/**
 * Meldet einen asynchronen Empfänger an und gibt eine synchrone Aufräumfunktion zurück
 * (für `useEffect`). Wird schon vor dem Anmelden aufgeräumt (StrictMode, schneller
 * Seitenwechsel), meldet sie den Empfänger nach dem Anmelden sofort wieder ab.
 */
export function listenWhileMounted(action: string, start: () => Promise<Unlisten>): () => void {
  let disposed = false;
  let stop: Unlisten | undefined;
  start().then(
    (unlisten) => {
      if (disposed) {
        callUnlisten(unlisten);
      } else {
        stop = unlisten;
      }
    },
    (error: unknown) => reportPlatformError(action, error),
  );
  return () => {
    disposed = true;
    if (stop !== undefined) {
      callUnlisten(stop);
      stop = undefined;
    }
  };
}
