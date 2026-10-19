// @vitest-environment node
/**
 * IPC-Vertrag zwischen Oberfläche (`src/`) und Rust-Seite (`src-tauri/`), geprüft am Quelltext
 * beider Seiten – eine Änderung auf nur einer Seite fällt hier auf:
 *
 * - Jeder Tauri-Aufruf der Oberfläche hat genau das passende Recht, und jedes gewährte Recht
 *   hat mindestens einen Aufruf (keine ungenutzten Rechte, keine stummen Fensterknöpfe).
 * - Ereignisname und Nutzdaten von `aegis://navigate` sind auf beiden Seiten gleich.
 * - Die JSON-Schlüssel von `app_info` (Rust `AppInfo`, camelCase) sind genau die, die
 *   `parseAppInfo` verlangt; die Antworten von `hide_to_tray` (Rust `HideOutcome`) versteht
 *   `parseHideOutcome`.
 *
 * Die Laufzeit-Gegenprobe mit der echten, beim Build aufgelösten ACL steht in
 * `src-tauri/src/main.rs` (`mod ipc`): jeder dieser Aufrufe läuft, alles andere wird abgelehnt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAppInfo } from '../src/platform/appInfo.ts';
import {
  CLIPBOARD_SWAP_EVENT,
  NAVIGATE_EVENT,
  parseHideOutcome,
  parseNavigatePayload,
  parseClipboardSwap,
} from '../src/platform/platform.ts';

const root = new URL('../', import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

/** Der einzige Ort, an dem die Oberfläche mit Tauri spricht. */
const ADAPTER = 'src/platform/platform.ts';
/** Die eigene Titelleiste – einziger Ort mit `data-tauri-drag-region`. */
const TITLE_BAR = 'src/shell/TitleBar.tsx';

/**
 * Methode des Hauptfensters (`getCurrentWindow()`) → Rechte. `onResized`/`onDragDropEvent`/`listen` melden
 * einen Empfänger an (`listen`) und geben eine Abmeldung zurück (`unlisten`).
 */
const WINDOW_METHOD_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  close: ['core:window:allow-close'],
  isMaximized: ['core:window:allow-is-maximized'],
  listen: ['core:event:allow-listen', 'core:event:allow-unlisten'],
  minimize: ['core:window:allow-minimize'],
  onDragDropEvent: ['core:event:allow-listen', 'core:event:allow-unlisten'],
  onResized: ['core:event:allow-listen', 'core:event:allow-unlisten'],
  toggleMaximize: ['core:window:allow-toggle-maximize'],
};

/**
 * Tauris Zieh-Skript für `data-tauri-drag-region` (tauri `src/window/scripts/drag.js`):
 * Drücken → `start_dragging`, Doppelklick → `internal_toggle_maximize`.
 */
const DRAG_REGION_PERMISSIONS = [
  'core:window:allow-start-dragging',
  'core:window:allow-internal-toggle-maximize',
] as const;

/** Quelldateien der Oberfläche ohne Tests und Test-Hilfen (`src/test/`). */
function productionSources(): string[] {
  return readdirSync(new URL('src/', root), { recursive: true, encoding: 'utf8' })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => !file.startsWith('test/'))
    .map((file) => `src/${file}`)
    .sort();
}

function capabilityPermissions(): string[] {
  const capability = JSON.parse(read('src-tauri/capabilities/default.json')) as {
    permissions: string[];
  };
  return capability.permissions;
}

/** `snake_case` → `camelCase` (serde `rename_all = "camelCase"`). */
function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

/** Rust-Quelltext ohne die Testmodule (`#[cfg(test)]` steht in diesen Dateien am Ende). */
function rustWithoutTests(path: string): string {
  const source = read(path);
  const tests = source.indexOf('#[cfg(test)]');
  return tests === -1 ? source : source.slice(0, tests);
}

/** Inhalt des ersten `{ … }`-Blocks nach `head` (ohne verschachtelte Klammern). */
function rustBlock(source: string, head: RegExp): string {
  const match = head.exec(source);
  expect(match, `${head} im Rust-Quelltext`).not.toBeNull();
  const start = source.indexOf('{', match?.index ?? 0);
  const end = source.indexOf('}', start);
  return source.slice(start + 1, end);
}

/** App-Befehle aus `build.rs` (`APP_COMMANDS`, ACL-Manifest der App). */
function appCommands(): string[] {
  const match = /const APP_COMMANDS: &\[&str\] = &\[([^\]]*)\];/.exec(read('src-tauri/build.rs'));
  expect(match, 'APP_COMMANDS in build.rs').not.toBeNull();
  return [...(match?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map(([, name]) => name ?? '');
}

describe('Tauri-Aufrufe der Oberfläche', () => {
  const sources = productionSources();
  const adapter = read(ADAPTER);

  it('nur der Plattform-Adapter spricht mit Tauri', () => {
    expect(sources).toContain(ADAPTER);
    for (const file of sources) {
      const text = read(file);
      if (file !== ADAPTER) {
        expect(text, `${file} importiert @tauri-apps`).not.toMatch(/['"]@tauri-apps\//);
      }
      expect(text, `${file}: Tauri-Interna`).not.toMatch(/__TAURI(?:_INTERNALS)?__/);
      // Einziges Plugin: die Datei-/Ordnerauswahl, nur im Adapter (siehe nächster Test).
      if (file !== ADAPTER) {
        expect(text, `${file}: Tauri-Plugins`).not.toMatch(/@tauri-apps\/plugin-/);
      }
      expect(text, `${file}: dynamischer Import`).not.toMatch(/import\(\s*['"]@tauri-apps/);
    }
  });

  it('der Adapter nutzt genau invoke, isTauri, getCurrentWindow und die Dateiauswahl', () => {
    const imports = [...adapter.matchAll(/^import\s+([^;]+?)\s+from\s+'(@tauri-apps\/[^']+)';$/gm)]
      .map(([, names, from]) => `${names ?? ''} from ${from ?? ''}`)
      .sort();
    expect(imports).toEqual([
      '{ getCurrentWindow } from @tauri-apps/api/window',
      '{ invoke, isTauri } from @tauri-apps/api/core',
      '{ open as openDialog } from @tauri-apps/plugin-dialog',
    ]);
    // Aus dem Dialog-Plugin nur `open` (Auswahl) – kein save/message/ask.
    expect(adapter.match(/\bopenDialog\(/g)).toHaveLength(1);
    // Genau ein Fenster-Objekt – das eigene Hauptfenster, keine Aufrufe am Adapter vorbei.
    expect(adapter.match(/getCurrentWindow\(\)/g)).toHaveLength(1);
    expect(adapter).toMatch(/const current = getCurrentWindow\(\);/);
  });

  it('jede Fenster-Methode ist bekannt und hat ihr Recht', () => {
    const methods = [
      ...new Set([...adapter.matchAll(/\bcurrent\.(\w+)(?:<[^>]*>)?\(/g)].map(([, m]) => m)),
    ];
    expect(methods.sort()).toEqual(Object.keys(WINDOW_METHOD_PERMISSIONS).sort());
  });

  it('App-Befehle: aufgerufen = in build.rs angemeldet = in main.rs registriert', () => {
    const invoked = [...adapter.matchAll(/\binvoke(?:<[^>]*>)?\(\s*'([a-z_]+)'/g)].map(
      ([, name]) => name,
    );
    // Kein Aufruf mit berechnetem Namen (der wäre hier nicht prüfbar).
    expect(adapter.match(/\binvoke(?:<[^>]*>)?\(/g)).toHaveLength(invoked.length);
    expect(invoked.sort()).toEqual(appCommands().sort());

    const handler = /generate_handler!\[([^\]]*)\]/.exec(rustWithoutTests('src-tauri/src/main.rs'));
    const registered = (handler?.[1] ?? '')
      .split(',')
      .map((path) => path.trim().split('::').pop() ?? '')
      .filter((name) => name !== '');
    expect(registered.sort()).toEqual(appCommands().sort());
  });

  it('data-tauri-drag-region nur in der eigenen Titelleiste', () => {
    const withDragRegion = sources.filter((file) => read(file).includes('data-tauri-drag-region'));
    expect(withDragRegion).toEqual([TITLE_BAR]);
  });

  it('gewährt ist genau, was diese Aufrufe brauchen – nicht mehr, nicht weniger', () => {
    const methods = [...adapter.matchAll(/\bcurrent\.(\w+)(?:<[^>]*>)?\(/g)].map(
      ([, m]) => m ?? '',
    );
    const needed = new Set<string>([
      ...methods.flatMap((method) => WINDOW_METHOD_PERMISSIONS[method] ?? []),
      ...appCommands().map((command) => `allow-${command.replaceAll('_', '-')}`),
      ...(read(TITLE_BAR).includes('data-tauri-drag-region') ? DRAG_REGION_PERMISSIONS : []),
      ...(adapter.includes('openDialog(') ? ['dialog:allow-open'] : []),
    ]);
    const granted = capabilityPermissions();
    expect(new Set(granted).size, 'keine doppelten Einträge').toBe(granted.length);
    expect([...granted].sort()).toEqual([...needed].sort());
  });
});

describe('Ereignis aegis://navigate (Rust → Oberfläche)', () => {
  const tray = rustWithoutTests('src-tauri/src/tray.rs');

  it('gleicher Ereignisname auf beiden Seiten', () => {
    const rust = /pub const NAVIGATE_EVENT: &str = "([^"]+)";/.exec(tray)?.[1];
    expect(rust).toBe(NAVIGATE_EVENT);
    expect(NAVIGATE_EVENT).toBe('aegis://navigate');
  });

  it('Rust sendet nur diese Ereignisse und nur an das Hauptfenster', () => {
    const rustFiles = readdirSync(new URL('src-tauri/src/', root)).filter((f) => f.endsWith('.rs'));
    const emits = rustFiles.flatMap((file) =>
      [
        ...rustWithoutTests(`src-tauri/src/${file}`).matchAll(/\.emit(?:_to|_filter)?\(([^)]*)/g),
      ].map(([, args]) => `${file}: ${(args ?? '').replace(/\s+/g, ' ').trim()}`),
    );
    expect(emits.sort()).toEqual([
      'clipboard_guard.rs: crate::window::MAIN_WINDOW_LABEL, SWAP_EVENT, swap',
      'tray.rs: MAIN_WINDOW_LABEL, NAVIGATE_EVENT, NavigatePayload { page }',
    ]);
  });

  it('Zwischenablage-Wächter: gleicher Ereignisname auf beiden Seiten', () => {
    const guard = rustWithoutTests('src-tauri/src/clipboard_guard.rs');
    const rust = /pub const SWAP_EVENT: &str = "([^"]+)";/.exec(guard)?.[1];
    expect(rust).toBe(CLIPBOARD_SWAP_EVENT);
    expect(parseClipboardSwap({ kind: 'bitcoin', before: 'a', after: 'b', owner: null })).toEqual({
      kind: 'bitcoin',
      before: 'a',
      after: 'b',
      owner: null,
    });
    expect(parseClipboardSwap({ kind: 'bitcoin' })).toBeNull();
  });

  it('jede Seite, die Rust sendet, versteht die Oberfläche', () => {
    expect(tray).toMatch(/#\[serde\(rename_all = "lowercase"\)\]\s*pub enum Page \{/);
    const pages = rustBlock(tray, /pub enum Page \{/)
      .split(',')
      .map((variant) => variant.trim().toLowerCase())
      .filter((variant) => variant !== '');
    expect(pages).toEqual(['dashboard', 'settings']);
    for (const page of pages) {
      expect(parseNavigatePayload({ page })).toBe(page);
    }
    expect(rustBlock(tray, /pub struct NavigatePayload \{/).trim()).toBe('pub page: Page,');
    expect(parseNavigatePayload({ page: 'about' })).toBeNull();
  });
});

describe('Befehl app_info (Rust AppInfo ↔ parseAppInfo)', () => {
  const source = rustWithoutTests('src-tauri/src/app_info.rs');
  const fields = rustBlock(source, /pub struct AppInfo \{/)
    .split('\n')
    .map((line) => /^\s*pub (\w+): ([^,]+),/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({
      key: camelCase(match[1] ?? ''),
      optional: match[2]?.startsWith('Option<'),
      boolean: match[2] === 'bool',
    }));

  /** Eine Antwort, wie Rust sie serialisiert – Schlüssel genau aus dem Rust-Struct. */
  function sample(): Record<string, unknown> {
    return Object.fromEntries(
      fields.map(({ key, boolean }) => [
        key,
        boolean
          ? true
          : key === 'buildProfile'
            ? 'release'
            : key === 'osVersion'
              ? '10.0.26100.4351'
              : 'x',
      ]),
    );
  }

  it('Rust serialisiert in camelCase, Build-Profil klein', () => {
    expect(source).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\s*pub struct AppInfo \{/);
    expect(source).toMatch(/#\[serde\(rename_all = "lowercase"\)\]\s*pub enum BuildProfile \{/);
    const profiles = rustBlock(source, /pub enum BuildProfile \{/)
      .split(',')
      .map((variant) => variant.trim().toLowerCase())
      .filter((variant) => variant !== '');
    expect(profiles).toEqual(['debug', 'release']);
    for (const buildProfile of profiles) {
      expect(parseAppInfo({ ...sample(), buildProfile }).buildProfile).toBe(buildProfile);
    }
  });

  it('die Oberfläche liest genau die Schlüssel, die Rust liefert', () => {
    expect(fields.map(({ key }) => key).sort()).toEqual([
      'arch',
      'buildProfile',
      'os',
      'osVersion',
      'tauriVersion',
      'trayAvailable',
      'version',
    ]);
    expect(fields.filter(({ boolean }) => boolean).map(({ key }) => key)).toEqual([
      'trayAvailable',
    ]);
    // Ergebnis = Rust-Werte unverändert plus die Herkunft „tauri“.
    expect(parseAppInfo(sample())).toEqual({ ...sample(), source: 'tauri' });
  });

  it('fehlt ein Schlüssel, gibt es einen Fehler statt einer halben Anzeige', () => {
    for (const { key } of fields) {
      const incomplete = Object.fromEntries(
        Object.entries(sample()).filter(([present]) => present !== key),
      );
      expect(Object.keys(incomplete)).toHaveLength(fields.length - 1);
      expect(() => parseAppInfo(incomplete), key).toThrow(TypeError);
    }
  });

  it('nur Option-Felder dürfen null sein (osVersion)', () => {
    for (const { key, optional } of fields) {
      const withNull = { ...sample(), [key]: null };
      if (optional === true) {
        expect(parseAppInfo(withNull)[key as 'osVersion']).toBeNull();
      } else {
        expect(() => parseAppInfo(withNull), key).toThrow(TypeError);
      }
    }
    expect(fields.filter(({ optional }) => optional === true).map(({ key }) => key)).toEqual([
      'osVersion',
    ]);
  });
});

describe('Befehl hide_to_tray (Rust HideOutcome ↔ parseHideOutcome)', () => {
  const source = rustWithoutTests('src-tauri/src/window.rs');

  it('jede Antwort, die Rust liefern kann, versteht die Oberfläche', () => {
    expect(source).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\s*pub enum HideOutcome \{/);
    const variants = rustBlock(source, /pub enum HideOutcome \{/)
      .split('\n')
      .map((line) => /^\s*(\w+),\s*$/.exec(line)?.[1])
      .filter((variant) => variant !== undefined)
      .map((variant) => variant.charAt(0).toLowerCase() + variant.slice(1));
    expect(variants).toEqual(['hidden', 'noTray']);
    for (const variant of variants) {
      expect(parseHideOutcome(variant)).toBe(variant);
    }
  });

  it('der Befehl versteckt nur über close_to_tray_available und das Tray-Symbol', () => {
    const command = rustBlock(source, /pub fn hide_to_tray<R: Runtime>/);
    expect(command).toMatch(/close_to_tray_available\(/);
    expect(command).toMatch(/tray_by_id\(tray::TRAY_ID\)/);
    expect(command).toMatch(/hide_if_tray\(/);
  });
});
