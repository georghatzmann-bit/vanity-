/**
 * Test-Hilfen für die App (nur Vitest/jsdom – nicht Teil der WebView-Quelle).
 * Baut die echte App mit ersetzbarem Speicher und nachgebildeter Plattform.
 */
import { render, type RenderResult } from '@testing-library/react';
import { StrictMode } from 'react';
import { vi, type Mock } from 'vitest';
import { App } from '../App.tsx';
import { createAppServices } from '../app/createServices.ts';
import type { AppServices } from '../app/services.tsx';
import { previewAppInfo, type AppInfo } from '../platform/appInfo.ts';
import type {
  HideOutcome,
  NavigateTarget,
  Platform,
  Unlisten,
  WindowApi,
} from '../platform/platform.ts';
import type { ServiceApi } from '../platform/service.ts';
import { SETTINGS_STORAGE_KEY, SETTINGS_VERSION, type Settings } from '../settings/schema.ts';
import type { StorageLike } from '../settings/store.ts';

export interface FakeWindowApi extends WindowApi {
  readonly minimize: Mock<() => Promise<void>>;
  readonly toggleMaximize: Mock<() => Promise<void>>;
  readonly isMaximized: Mock<() => Promise<boolean>>;
  readonly hideToTray: Mock<() => Promise<HideOutcome>>;
  readonly close: Mock<() => Promise<void>>;
}

export interface FakePlatform extends Platform {
  readonly windowMock: FakeWindowApi | null;
  /** Simuliert `aegis://navigate` aus dem Tray-Menü. */
  emitNavigate(target: NavigateTarget): void;
  /** Simuliert eine Größenänderung (z. B. nach Maximieren). */
  emitResized(): void;
  /** Wie viele Empfänger gerade angemeldet sind. */
  listenerCount(): number;
}

export const desktopInfo: AppInfo = {
  source: 'tauri',
  version: '0.1.0',
  buildProfile: 'release',
  os: 'windows',
  osVersion: '10.0.22631.4317',
  arch: 'x86_64',
  tauriVersion: '2.12.4',
  trayAvailable: true,
};

/** Nachgebildete Plattform: Desktop (mit Fensterknöpfen) oder Browser-Vorschau. */
export function fakePlatform(
  kind: 'tauri' | 'browser',
  info?: AppInfo,
  service: ServiceApi | null = null,
  picked: readonly string[] = [],
): FakePlatform {
  const navigateHandlers = new Set<(target: NavigateTarget) => void>();
  const resizeHandlers = new Set<() => void>();
  let maximized = false;
  const windowMock: FakeWindowApi | null =
    kind === 'tauri'
      ? {
          minimize: vi.fn(() => Promise.resolve()),
          toggleMaximize: vi.fn(() => {
            maximized = !maximized;
            return Promise.resolve();
          }),
          isMaximized: vi.fn(() => Promise.resolve(maximized)),
          hideToTray: vi.fn(() => Promise.resolve<HideOutcome>('hidden')),
          close: vi.fn(() => Promise.resolve()),
          onResized: (handler) => {
            resizeHandlers.add(handler);
            return Promise.resolve(() => {
              resizeHandlers.delete(handler);
            });
          },
        }
      : null;
  return {
    kind,
    window: windowMock,
    windowMock,
    appInfo: () =>
      Promise.resolve(info ?? (kind === 'tauri' ? desktopInfo : previewAppInfo('0.1.0', true))),
    onNavigate(handler): Promise<Unlisten> {
      navigateHandlers.add(handler);
      return Promise.resolve(() => {
        navigateHandlers.delete(handler);
      });
    },
    emitNavigate(target) {
      for (const handler of navigateHandlers) {
        handler(target);
      }
    },
    emitResized() {
      for (const handler of resizeHandlers) {
        handler();
      }
    },
    listenerCount: () => navigateHandlers.size + resizeHandlers.size,
    service: kind === 'tauri' ? service : null,
    pickPaths: kind === 'tauri' ? vi.fn(() => Promise.resolve(picked)) : null,
  };
}

/** Speicher im Arbeitsspeicher (optional mit Fehlern beim Schreiben). */
export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  let failWrites = false;
  const storage: StorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) {
        throw new DOMException('Speicher voll', 'QuotaExceededError');
      }
      data.set(key, value);
    },
  };
  return {
    storage,
    data,
    failWrites(value: boolean) {
      failWrites = value;
    },
    settings(): Partial<Settings> | undefined {
      const raw = data.get(SETTINGS_STORAGE_KEY);
      return raw === undefined
        ? undefined
        : (JSON.parse(raw) as { settings: Partial<Settings> }).settings;
    },
  };
}

export interface RenderAppOptions {
  readonly settings?: Partial<Settings> | undefined;
  readonly platform?: FakePlatform | Platform | undefined;
  readonly hash?: string | undefined;
  readonly strict?: boolean | undefined;
  readonly storage?: ReturnType<typeof memoryStorage> | undefined;
}

export interface RenderedApp extends RenderResult {
  readonly services: AppServices;
  readonly memory: ReturnType<typeof memoryStorage>;
}

const mounted: AppServices[] = [];

/**
 * Rendert die echte App. Standard: Start-Animation aus (schnelle Tests), Sprache Deutsch,
 * Browser-Vorschau, Adresse `#/dashboard`.
 */
export function renderApp(options: RenderAppOptions = {}): RenderedApp {
  const memory =
    options.storage ??
    memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        version: SETTINGS_VERSION,
        settings: { bootAnimation: false, language: 'de', ...options.settings },
      }),
    });
  window.history.replaceState(null, '', options.hash ?? '#/dashboard');
  const services = createAppServices({
    window,
    storage: memory.storage,
    platform: options.platform ?? fakePlatform('browser'),
  });
  mounted.push(services);
  const app = <App services={services} />;
  const result = render(options.strict === true ? <StrictMode>{app}</StrictMode> : app);
  return { ...result, services, memory };
}

/** Nach jedem Test: matchMedia-Ersatz und Router abbauen. */
export function disposeApps(): void {
  for (const services of mounted.splice(0)) {
    services.motion.uninstall();
    services.router.dispose();
  }
  window.history.replaceState(null, '', '#');
  delete document.documentElement.dataset['theme'];
  delete document.documentElement.dataset['motion'];
  document.documentElement.removeAttribute('lang');
}

/** Bevorzugte Sprachen des Systems (jsdom: en-US) für einen Test festlegen. */
export function stubLanguages(list: readonly string[]): void {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue([...list]);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(list[0] ?? '');
}

/** Nachgebildetes System-`matchMedia` (jsdom hat keins) mit umschaltbaren Werten. */
export function stubMatchMedia(initial: Record<string, boolean> = {}) {
  const values = new Map(Object.entries(initial));
  const targets = new Map<string, EventTarget>();
  const matchMedia = vi.fn((query: string) => {
    let target = targets.get(query);
    if (target === undefined) {
      target = new EventTarget();
      targets.set(query, target);
    }
    const list = target;
    return Object.defineProperties(Object.create(list) as MediaQueryList, {
      media: { value: query },
      matches: { get: () => values.get(query) ?? false },
      addEventListener: { value: list.addEventListener.bind(list) },
      removeEventListener: { value: list.removeEventListener.bind(list) },
      addListener: { value: (cb: EventListener) => list.addEventListener('change', cb) },
      removeListener: { value: (cb: EventListener) => list.removeEventListener('change', cb) },
    });
  });
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    set(query: string, value: boolean) {
      values.set(query, value);
      targets.get(query)?.dispatchEvent(new Event('change'));
    },
  };
}
