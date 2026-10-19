// @vitest-environment node
/**
 * Sicherheits- und Lokalisierungs-Invarianten der Tauri-Konfiguration (src-tauri/).
 * Die CSP selbst prüft src/csp.test.ts, die Laufzeit-Wirkung e2e/security.spec.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import tauriConfig from '../src-tauri/tauri.conf.json' with { type: 'json' };
import viteConfig from '../vite.config.ts';

const srcTauri = new URL('../src-tauri/', import.meta.url);

/**
 * Jede IPC-Berechtigung des Hauptfensters – mit Begründung (auch in apps/desktop/README.md).
 * P0 ruft keinen einzigen Befehl auf, daher leer. Nie ein ganzes `:default`-Bündel eintragen.
 */
const JUSTIFIED_PERMISSIONS: Readonly<Record<string, string>> = {};

interface Capability {
  readonly identifier?: unknown;
  readonly windows?: unknown;
  readonly webviews?: unknown;
  readonly remote?: unknown;
  readonly permissions?: unknown;
}

function capabilities(): { file: string; capability: Capability }[] {
  const dir = new URL('capabilities/', srcTauri);
  return readdirSync(dir)
    .filter((file) => /\.(?:json|toml)$/i.test(file))
    .map((file) => {
      expect(file, 'Capabilities nur als JSON (prüfbar)').toMatch(/\.json$/i);
      return {
        file,
        capability: JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Capability,
      };
    });
}

function permissionId(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  if (typeof entry === 'object' && entry !== null && 'identifier' in entry) {
    return String((entry as { identifier: unknown }).identifier);
  }
  throw new TypeError(`unbekannter Berechtigungs-Eintrag: ${JSON.stringify(entry)}`);
}

describe('Capabilities (IPC-Rechte)', () => {
  const all = capabilities();

  it('gibt es genau für das Hauptfenster und nie für entfernte Seiten', () => {
    expect(all.map(({ file }) => file)).toEqual(['default.json']);
    for (const { file, capability } of all) {
      expect(capability.windows, file).toEqual(['main']);
      expect(capability.webviews, file).toBeUndefined();
      expect(capability.remote, `${file}: keine IPC für Remote-URLs`).toBeUndefined();
    }
  });

  it('gewährt nur einzeln begründete Berechtigungen (P0: keine), nie ein :default-Bündel', () => {
    for (const { file, capability } of all) {
      expect(Array.isArray(capability.permissions), file).toBe(true);
      const ids = (capability.permissions as unknown[]).map(permissionId);
      for (const id of ids) {
        expect(id, `${file}: ${id}`).not.toMatch(/(?:^|:)default$/);
        expect(Object.keys(JUSTIFIED_PERMISSIONS), `${file}: ${id} ist nicht begründet`).toContain(
          id,
        );
      }
      expect(ids).toEqual([]);
    }
  });
});

describe('App-Fenster', () => {
  it('kein globales Tauri-Objekt, eingefrorener Prototyp', () => {
    expect(tauriConfig.app.withGlobalTauri).toBe(false);
    expect(tauriConfig.app.security.freezePrototype).toBe(true);
  });

  it('main.rs registriert den Navigations-Wächter (keine fremden Seiten im Fenster)', () => {
    const main = readFileSync(new URL('src/main.rs', srcTauri), 'utf8');
    expect(main).toMatch(/^mod navigation;$/m);
    expect(main).toMatch(/\.plugin\(\s*navigation::guard\(/);
  });
});

describe('Build', () => {
  it('bettet keine Datei als data:-URI ein (CSP: img-src/font-src nur self)', () => {
    const limit = viteConfig.build?.assetsInlineLimit;
    if (typeof limit === 'function') {
      for (const file of ['logo.svg', 'icon.png', 'inter.woff2', 'x.webp']) {
        expect(limit(file, Buffer.from('x')), file).toBe(false);
      }
    } else {
      expect(limit).toBe(0);
    }
  });
});

describe('Installer (NSIS)', () => {
  const nsis = tauriConfig.bundle.windows.nsis as {
    installMode?: string;
    languages?: string[];
  };

  it('installiert pro Nutzer (kein Admin für die App)', () => {
    expect(nsis.installMode).toBe('currentUser');
  });

  it('spricht Deutsch zuerst, Englisch als zweite Sprache (Rückfall: Deutsch)', () => {
    expect(nsis.languages?.[0]).toBe('German');
    expect(nsis.languages).toContain('English');
  });
});
