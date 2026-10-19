// @vitest-environment node
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import tauriConfig from '../src-tauri/tauri.conf.json' with { type: 'json' };
import viteConfig from '../vite.config.ts';
import { cspFromTauriConfig, serializeCsp } from './csp.ts';

/** Zerlegt eine serialisierte CSP wieder in Direktive → Quellen (für Invarianten-Prüfungen). */
function parsePolicy(policy: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') {
      result.set(name, sources);
    }
  }
  return result;
}

describe('serializeCsp', () => {
  it('serialisiert eine Direktiven-Tabelle wie Tauri (Einfügereihenfolge, „; “)', () => {
    expect(
      serializeCsp({
        'default-src': "'self'",
        'img-src': "'self' data:",
        'object-src': "'none'",
      }),
    ).toBe("default-src 'self'; img-src 'self' data:; object-src 'none'");
  });

  it('akzeptiert Listen und normalisiert Leerraum', () => {
    expect(
      serializeCsp({
        'script-src': ["'self'", "  'wasm-unsafe-eval' "],
        'style-src': "'self'   'unsafe-inline'",
      }),
    ).toBe("script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'");
  });

  it('gibt Direktiven ohne Quellen nur mit Namen aus', () => {
    expect(serializeCsp({ 'upgrade-insecure-requests': [] })).toBe('upgrade-insecure-requests');
  });

  it('übernimmt eine fertige Richtlinie als Text (getrimmt)', () => {
    expect(serializeCsp("  default-src 'self'; object-src 'none' ")).toBe(
      "default-src 'self'; object-src 'none'",
    );
  });

  it('lehnt leere oder ungültige Angaben ab', () => {
    expect(() => serializeCsp({})).toThrow(/leer/);
    expect(() => serializeCsp('   ')).toThrow(/leer/);
    expect(() => serializeCsp("default-src 'self'\r\nX-Injected: 1")).toThrow(/Steuerzeichen/);
    expect(() => serializeCsp({ 'Script-Src': "'self'" })).toThrow(/Direktiven-Name/);
    expect(() => serializeCsp({ 'script src': "'self'" })).toThrow(/Direktiven-Name/);
    expect(() => serializeCsp({ 'script-src': "'self'; object-src *" })).toThrow(/Quelle/);
    expect(() => serializeCsp({ 'script-src': "'self',https:" })).toThrow(/Quelle/);
    expect(() => serializeCsp({ 'script-src': "'self'\u0000" })).toThrow(/Quelle/);
    expect(() => serializeCsp({ 'script-src': 42 } as never)).toThrow(/Text oder eine Liste/);
    expect(() => serializeCsp({ 'script-src': ["'self'", 1] } as never)).toThrow(/Text sein/);
    expect(() => serializeCsp(null as never)).toThrow(/Direktiven-Tabelle/);
  });
});

describe('cspFromTauriConfig', () => {
  it('liest app.security.csp (Tabelle oder Text)', () => {
    expect(cspFromTauriConfig({ app: { security: { csp: { 'default-src': "'self'" } } } })).toBe(
      "default-src 'self'",
    );
    expect(cspFromTauriConfig({ app: { security: { csp: "default-src 'none'" } } })).toBe(
      "default-src 'none'",
    );
  });

  it('wirft, wenn die CSP fehlt oder falsch typisiert ist (Sicherheitsfehler)', () => {
    for (const config of [
      undefined,
      null,
      'x',
      {},
      { app: {} },
      { app: { security: {} } },
      { app: { security: { csp: null } } },
    ]) {
      expect(() => cspFromTauriConfig(config)).toThrow(/app\.security\.csp fehlt/);
    }
    expect(() => cspFromTauriConfig({ app: { security: { csp: 1 } } })).toThrow(
      /Text oder eine Tabelle/,
    );
    expect(() => cspFromTauriConfig({ app: { security: { csp: ["'self'"] } } })).toThrow(
      /Text oder eine Tabelle/,
    );
  });
});

describe('CSP der Desktop-App (tauri.conf.json)', () => {
  const policy = cspFromTauriConfig(tauriConfig);
  const directives = parsePolicy(policy);

  it('ist strikt: nur eigene Skripte, keine Plugins, keine Frames, keine Formulare', () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
  });

  it('lädt Schriften nur lokal und erlaubt keine entfernten Quellen (keine CDNs)', () => {
    expect(directives.get('font-src')).toEqual(["'self'"]);
    for (const [name, sources] of directives) {
      for (const source of sources) {
        expect(source, `${name}: ${source}`).not.toBe('*');
        expect(source, `${name}: ${source}`).not.toMatch(/^'unsafe-eval'$|^https?:$|^wss?:$/);
        if (/^(?:https?|wss?):\/\//.test(source)) {
          // Einzige erlaubte URL: Tauri-IPC unter Windows (http://ipc.localhost).
          expect(`${name} ${source}`).toBe('connect-src http://ipc.localhost');
        }
      }
    }
  });

  it('erlaubt Inline-Stile nur für style-src (Motion), nie für Skripte', () => {
    for (const [name, sources] of directives) {
      if (sources.includes("'unsafe-inline'")) {
        expect(name).toBe('style-src');
      }
    }
  });

  it('wird von vite preview unverändert als Header gesendet (eine Quelle)', () => {
    const headers = viteConfig.preview?.headers;
    expect(headers?.['Content-Security-Policy']).toBe(policy);
  });

  it('index.html enthält weder Inline-Skripte noch <style> (sonst würde Tauri die CSP ändern)', () => {
    expect(indexHtml).not.toMatch(/<style[\s>]/i);
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes = '', body = ''] of scripts) {
      expect(attributes).toMatch(/\bsrc=/);
      expect(attributes).not.toMatch(/src=["']?(?:https?:)?\/\//);
      expect(body.trim()).toBe('');
    }
  });
});
