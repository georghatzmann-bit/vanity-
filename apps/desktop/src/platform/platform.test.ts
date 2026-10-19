import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { version as configuredVersion } from '../../src-tauri/tauri.conf.json';
import { parseAppInfo, previewAppInfo } from './appInfo.ts';
import {
  NAVIGATE_EVENT,
  createBrowserPlatform,
  detectPlatform,
  listenWhileMounted,
  parseNavigatePayload,
  type Unlisten,
} from './platform.ts';

const validInfo = {
  version: '0.1.0',
  buildProfile: 'release',
  os: 'windows',
  osVersion: '10.0.22631.4317',
  arch: 'x86_64',
  tauriVersion: '2.12.4',
};

/** Simuliert die Tauri-WebView: `isTauri()` wahr, Hauptfenster „main“, IPC abgefangen. */
function mockTauri(handler: (command: string, payload: unknown) => unknown = () => null) {
  vi.stubGlobal('isTauri', true);
  mockWindows('main');
  const calls: { command: string; payload: unknown }[] = [];
  mockIPC(
    (command, payload) => {
      calls.push({ command, payload });
      return handler(command, payload);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('app_info prüfen', () => {
  it('nimmt die Form aus dem IPC-Vertrag an', () => {
    expect(parseAppInfo(validInfo)).toEqual({ source: 'tauri', ...validInfo });
    expect(parseAppInfo({ ...validInfo, osVersion: null }).osVersion).toBeNull();
    expect(parseAppInfo({ ...validInfo, osVersion: '  ' }).osVersion).toBeNull();
  });

  it('lehnt abweichende Antworten ab (nie halb gefüllt anzeigen)', () => {
    const broken: unknown[] = [
      null,
      'text',
      [],
      { ...validInfo, buildProfile: 'beta' },
      { ...validInfo, version: '' },
      { ...validInfo, version: 1 },
      { ...validInfo, os: undefined },
      { ...validInfo, arch: 'x'.repeat(201) },
      { ...validInfo, osVersion: 10 },
      Object.fromEntries(Object.entries(validInfo).filter(([key]) => key !== 'osVersion')),
    ];
    for (const value of broken) {
      expect(() => parseAppInfo(value), JSON.stringify(value)).toThrow(TypeError);
    }
  });

  it('Vorschau-Werte sind gekennzeichnet und erfinden keine Systemangaben', () => {
    expect(previewAppInfo('9.9.9', true)).toEqual({
      source: 'preview',
      version: '9.9.9',
      buildProfile: 'debug',
      os: null,
      osVersion: null,
      arch: null,
      tauriVersion: null,
    });
    expect(previewAppInfo('1.0.0', false).buildProfile).toBe('release');
  });
});

describe('Tray-Ereignis prüfen', () => {
  it('akzeptiert nur dashboard und settings', () => {
    expect(parseNavigatePayload({ page: 'dashboard' })).toBe('dashboard');
    expect(parseNavigatePayload({ page: 'settings' })).toBe('settings');
    for (const payload of [null, 'settings', [], {}, { page: 'scan' }, { page: 1 }]) {
      expect(parseNavigatePayload(payload)).toBeNull();
    }
  });
});

describe('Browser-Vorschau', () => {
  it('ohne Tauri: keine Fensterknöpfe, gekennzeichnete Werte, Version aus tauri.conf.json', async () => {
    const platform = detectPlatform();
    expect(platform.kind).toBe('browser');
    expect(platform.window).toBeNull();
    await expect(platform.appInfo()).resolves.toEqual(previewAppInfo(configuredVersion, true));
    const handler = vi.fn();
    const unlisten = await platform.onNavigate(handler);
    unlisten();
    expect(handler).not.toHaveBeenCalled();
  });

  it('createBrowserPlatform liefert genau die übergebenen Werte', async () => {
    const info = previewAppInfo('1.2.3', false);
    await expect(createBrowserPlatform(info).appInfo()).resolves.toBe(info);
  });
});

describe('Desktop-App (Tauri, IPC nachgebildet)', () => {
  it('Fensterknöpfe rufen genau die freigegebenen Fensterbefehle für „main“ auf', async () => {
    const calls = mockTauri((command) => (command === 'plugin:window|is_maximized' ? true : null));
    const platform = detectPlatform();
    expect(platform.kind).toBe('tauri');
    const windowApi = platform.window;
    expect(windowApi).not.toBeNull();
    if (windowApi === null) {
      return;
    }

    await windowApi.minimize();
    await windowApi.toggleMaximize();
    await expect(windowApi.isMaximized()).resolves.toBe(true);
    await windowApi.hide();
    await windowApi.close();

    expect(calls.map(({ command }) => command)).toEqual([
      'plugin:window|minimize',
      'plugin:window|toggle_maximize',
      'plugin:window|is_maximized',
      'plugin:window|hide',
      'plugin:window|close',
    ]);
    for (const { payload } of calls) {
      expect(payload).toEqual({ label: 'main' });
    }
  });

  it('app_info: Befehl ohne Argumente, Antwort geprüft und zwischengespeichert', async () => {
    const calls = mockTauri((command) => (command === 'app_info' ? validInfo : null));
    const platform = detectPlatform();
    await expect(platform.appInfo()).resolves.toEqual({ source: 'tauri', ...validInfo });
    await platform.appInfo();
    expect(calls.filter(({ command }) => command === 'app_info')).toHaveLength(1);
  });

  it('app_info: fehlerhafte Antwort wird abgelehnt und beim nächsten Mal neu versucht', async () => {
    let answer: unknown = { version: 1 };
    const calls = mockTauri((command) => (command === 'app_info' ? answer : null));
    const platform = detectPlatform();
    await expect(platform.appInfo()).rejects.toThrow(TypeError);
    answer = validInfo;
    await expect(platform.appInfo()).resolves.toMatchObject({ version: '0.1.0' });
    expect(calls.filter(({ command }) => command === 'app_info')).toHaveLength(2);
  });

  it('aegis://navigate aus dem Tray erreicht den Empfänger; Unbekanntes wird verworfen', async () => {
    mockTauri();
    const platform = detectPlatform();
    const handler = vi.fn();
    const unlisten = await platform.onNavigate(handler);

    await emit(NAVIGATE_EVENT, { page: 'settings' });
    await emit(NAVIGATE_EVENT, { page: 'irgendwas' });
    await emit(NAVIGATE_EVENT, 'settings');
    await emit('anderes-ereignis', { page: 'dashboard' });
    expect(handler.mock.calls).toEqual([['settings']]);

    unlisten();
    await emit(NAVIGATE_EVENT, { page: 'dashboard' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('onResized meldet Größenänderungen des Fensters', async () => {
    mockTauri();
    const platform = detectPlatform();
    const handler = vi.fn();
    await platform.window?.onResized(handler);
    await emit('tauri://resize', { width: 800, height: 600 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('listenWhileMounted', () => {
  it('meldet ab, wenn schon vor dem Anmelden aufgeräumt wurde (StrictMode)', async () => {
    const unlisten = vi.fn();
    let resolve: (value: Unlisten) => void = () => undefined;
    const stop = listenWhileMounted('test', () => new Promise<Unlisten>((r) => (resolve = r)));
    stop();
    resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it('meldet beim Aufräumen genau einmal ab', async () => {
    const unlisten = vi.fn();
    const stop = listenWhileMounted('test', () => Promise.resolve(unlisten));
    await Promise.resolve();
    await Promise.resolve();
    stop();
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('Fehler beim An- oder Abmelden werden gemeldet, nicht geworfen', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listenWhileMounted('anmelden', () => Promise.reject(new Error('verweigert')));
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

    const stop = listenWhileMounted('abmelden', () =>
      Promise.resolve(() => {
        throw new Error('weg');
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    stop();
    expect(error).toHaveBeenCalledTimes(2);

    const stopAsync = listenWhileMounted('abmelden-async', () =>
      Promise.resolve((() => Promise.reject(new Error('später'))) as unknown as Unlisten),
    );
    await Promise.resolve();
    await Promise.resolve();
    stopAsync();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(3));
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
      'AEGIS: anmelden fehlgeschlagen',
      'AEGIS: Abmelden fehlgeschlagen',
      'AEGIS: Abmelden fehlgeschlagen',
    ]);
  });
});
