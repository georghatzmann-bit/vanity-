// @vitest-environment node
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import tauriConfig from '../src-tauri/tauri.conf.json' with { type: 'json' };
import viteConfig from '../vite.config.ts';
import { cspFromTauriConfig, findInlineCode, serializeCsp } from './csp.ts';

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
  it('serialisiert eine Direktiven-Tabelle im Tauri-Format (Einfügereihenfolge, „; “)', () => {
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

describe('findInlineCode', () => {
  it('meldet nichts für Skripte und Stile aus eigenen Dateien', () => {
    expect(
      findInlineCode(
        '<head><script type="module" crossorigin src="/assets/index.js"></script>' +
          '<link rel="stylesheet" href="/assets/index.css"></head><body><div id="root"></div></body>',
      ),
    ).toEqual([]);
  });

  it('meldet <style>, Inline-Skripte, fremde Skripte, style-Attribute und Handler', () => {
    expect(findInlineCode('<style>a{}</style>')).toEqual(['<style>-Element']);
    expect(findInlineCode('<STYLE media="x">a{}</STYLE>')).toEqual(['<style>-Element']);
    expect(findInlineCode('<script>alert(1)</script>')).toHaveLength(2);
    expect(findInlineCode('<script type="module"></script>')).toEqual([
      'Inline-Skript: <script type="module">',
    ]);
    expect(findInlineCode('<script src="/a.js">x()</script>')).toEqual([
      'Skript mit Inhalt: <script src="/a.js">',
    ]);
    expect(findInlineCode('<script src="https://cdn.example/a.js"></script>')).toEqual([
      'Skript von fremdem Ursprung: https://cdn.example/a.js',
    ]);
    expect(findInlineCode('<script src="//cdn.example/a.js"></script>')).toHaveLength(1);
    expect(findInlineCode('<div style="color:red"></div>')).toEqual([
      'style-Attribut: <div style="color:red">',
    ]);
    expect(findInlineCode('<img src="/a.png" onerror="x()">')).toEqual([
      'Inline-Ereignis-Handler: <img src="/a.png" onerror="x()">',
    ]);
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

  it("erlaubt nirgends 'unsafe-inline' – auch keine Stile (Schutz der Bestätigungs-Knöpfe)", () => {
    // React und Motion setzen Stile über das CSSOM (element.style), das die CSP nicht
    // betrifft. Eingeschleuste <style>-Elemente oder style-Attribute (etwa über einen
    // Dateinamen im Bestätigungsdialog) blockiert der Browser damit.
    expect(directives.get('style-src')).toEqual(["'self'"]);
    for (const [name, sources] of directives) {
      expect(sources, name).not.toContain("'unsafe-inline'");
      expect(sources, name).not.toContain("'unsafe-hashes'");
    }
  });

  it('erlaubt keine data:/blob:-Quellen (Bilder und Schriften nur aus dem Bundle)', () => {
    expect(directives.get('img-src')).toEqual(["'self'"]);
    for (const [name, sources] of directives) {
      expect(sources, name).not.toContain('data:');
      expect(sources, name).not.toContain('blob:');
    }
  });

  it('wird von vite preview unverändert als Header gesendet (eine Quelle)', () => {
    const headers = viteConfig.preview?.headers;
    expect(headers?.['Content-Security-Policy']).toBe(policy);
  });

  it('index.html (Quelle) enthält keinen Inline-Code (sonst würde Tauri die CSP ändern)', () => {
    // Das gebaute dist/index.html prüft e2e/security.spec.ts.
    expect(indexHtml).toMatch(/<script\b[^>]*\bsrc=/);
    expect(findInlineCode(indexHtml)).toEqual([]);
  });
});
