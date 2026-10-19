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
  FileDropEvent,
  HideOutcome,
  NavigateTarget,
  Platform,
  Unlisten,
  WindowApi,
} from '../platform/platform.ts';
import { parseLanReport, type LanReport } from '../platform/lan.ts';
import type { VaultApi, VaultEntryInput } from '../platform/vault.ts';
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
  /** Wie viele Empfänger gerade angemeldet sind (Tray, Fenstergröße). */
  listenerCount(): number;
  /** Simuliert Drag & Drop von Dateien auf das Fenster. */
  emitFileDrop(event: FileDropEvent): void;
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
  const dropHandlers = new Set<(event: FileDropEvent) => void>();
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
    onFileDrop(handler): Promise<Unlisten> {
      dropHandlers.add(handler);
      return Promise.resolve(() => {
        dropHandlers.delete(handler);
      });
    },
    emitFileDrop(event) {
      for (const handler of dropHandlers) {
        handler(event);
      }
    },
    service: kind === 'tauri' ? service : null,
    pickPaths: kind === 'tauri' ? vi.fn(() => Promise.resolve(picked)) : null,
    openWindowsSecurity: kind === 'tauri' ? vi.fn(() => Promise.resolve()) : null,
    openWindowsSettings: kind === 'tauri' ? vi.fn(() => Promise.resolve()) : null,
    clipboardGuard: kind === 'tauri' ? vi.fn(() => Promise.resolve(true)) : null,
    onClipboardSwap: () => Promise.resolve(() => undefined),
    homeNetworkScan: kind === 'tauri' ? vi.fn(() => Promise.resolve(sampleLanReport)) : null,
    // SHA-1("password") = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
    leakPasswordRange:
      kind === 'tauri'
        ? vi.fn(() =>
            Promise.resolve([
              { suffix: '1E4C9B93F3F0682250B6CF8331B7EE68FD8', count: 52256179 },
              { suffix: '0018A45C4D1DEF81644B54AB7F969B88D65', count: 3 },
            ]),
          )
        : null,
    vault: kind === 'tauri' ? fakeVault() : null,
    leakEmailCheck:
      kind === 'tauri'
        ? vi.fn(() =>
            Promise.resolve({
              status: 'found' as const,
              breaches: [
                {
                  name: 'Beispiel',
                  title: 'Beispiel-Shop',
                  domain: 'shop.example',
                  breachDate: '2021-03-04',
                  dataClasses: ['Email addresses', 'Passwords'],
                  verified: true,
                },
              ],
            }),
          )
        : null,
  };
}

/** Tresor im Speicher (Master-Passwort „ein langes Master-Passwort“). */
export function fakeVault(
  initial: { exists?: boolean; unlocked?: boolean } = {},
): VaultApi & { readonly entries: Map<string, VaultEntryInput> } {
  const MASTER = 'ein langes Master-Passwort';
  let exists = initial.exists ?? true;
  let unlocked = initial.unlocked ?? false;
  let next = 1;
  const entries = new Map<string, VaultEntryInput>([
    [
      'e1',
      {
        title: 'Bank',
        username: 'anna',
        password: 'password',
        urls: ['bank.example'],
        notes: 'PIN im Safe',
        folder: 'Finanzen',
        tags: ['wichtig'],
        favorite: true,
      },
    ],
    [
      'e2',
      {
        title: 'Forum',
        username: 'anna_f',
        password: 'password',
        urls: [],
        notes: '',
        folder: '',
        tags: [],
        favorite: false,
      },
    ],
  ]);
  const guard = () => (unlocked ? Promise.resolve() : Promise.reject('locked'));
  return {
    entries,
    status: vi.fn(() => Promise.resolve({ exists, unlocked, lockMinutes: 5, retryIn: 0 })),
    setup: vi.fn((master: string) => {
      exists = true;
      unlocked = master.length >= 12;
      return Promise.resolve();
    }),
    unlock: vi.fn((master: string) =>
      master === MASTER ? ((unlocked = true), Promise.resolve()) : Promise.reject('wrong_password'),
    ),
    lock: vi.fn(() => {
      unlocked = false;
      return Promise.resolve();
    }),
    setLockMinutes: vi.fn(() => Promise.resolve()),
    list: vi.fn(() =>
      guard().then(() => ({
        entries: [...entries].map(([id, e]) => ({
          id,
          title: e.title,
          username: e.username,
          urls: e.urls,
          folder: e.folder,
          tags: e.tags,
          favorite: e.favorite,
          modified: 0,
          passwordChanged: 0,
          hasNotes: e.notes !== '',
          hasPassword: e.password !== '',
        })),
        folders: [...new Set([...entries.values()].map((e) => e.folder).filter((f) => f))],
        weak: [...entries].filter(([, e]) => e.password.length < 10).map(([id]) => id),
        reused: ['e1', 'e2'],
      })),
    ),
    reveal: vi.fn((id: string) =>
      guard().then(() => ({
        password: entries.get(id)?.password ?? '',
        notes: entries.get(id)?.notes ?? '',
      })),
    ),
    save: vi.fn((id: string | null, entry: VaultEntryInput) =>
      guard().then(() => {
        const key = id ?? `n${next++}`;
        entries.set(key, entry);
        return key;
      }),
    ),
    remove: vi.fn((id: string) => guard().then(() => void entries.delete(id))),
    copy: vi.fn(() => guard().then(() => 30)),
    generate: vi.fn(() => Promise.resolve('Gen3riert!Sehr-Lang_2026')),
    strength: vi.fn((password: string) =>
      Promise.resolve({
        level: password.length >= 16 ? ('very_strong' as const) : ('very_weak' as const),
        bits: password.length * 4,
      }),
    ),
    importCsv: vi.fn(() => guard().then(() => ({ imported: 2, skipped: 1 }))),
    changeMaster: vi.fn(() => guard()),
  };
}

/** Beispiel-Ergebnis des Heimnetz-Scanners (Router mit Telnet, ein PC mit RDP, WLAN WPA2). */
export const sampleLanReport: LanReport = parseLanReport({
  available: true,
  network: '192.168.178.0/24',
  address: '192.168.178.20',
  gateway: '192.168.178.1',
  scanned: 253,
  limited: false,
  devices: [
    {
      ip: '192.168.178.1',
      mac: '3C:A6:2F:00:00:01',
      gateway: true,
      rtt_ms: 2,
      open_ports: [23, 80],
    },
    { ip: '192.168.178.20', this_device: true, open_ports: [] },
    {
      ip: '192.168.178.30',
      mac: '0A:11:22:33:44:55',
      private_mac: true,
      rtt_ms: 9,
      open_ports: [3389],
    },
  ],
  wifi: [{ ssid: 'Heimnetz', security: 'wpa2', tkip: false }],
  upnp: true,
  hints: [
    { id: 'router_telnet', severity: 'danger', target: '192.168.178.1' },
    { id: 'router_http_only', severity: 'warn', target: '192.168.178.1' },
    { id: 'device_rdp', severity: 'warn', target: '192.168.178.30' },
    { id: 'router_upnp', severity: 'warn', target: '192.168.178.1' },
    { id: 'wifi_wpa2', severity: 'info', target: 'Heimnetz' },
  ],
});

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
