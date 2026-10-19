/**
 * Content-Security-Policy aus der Tauri-Konfiguration – eine einzige Quelle.
 *
 * Tauri liest `app.security.csp` aus `src-tauri/tauri.conf.json` und setzt die Richtlinie im
 * App-Fenster. `vite preview` (Grundlage der Playwright-Tests) sendet über diese Hilfsfunktion
 * dieselben Direktiven mit denselben Quellen als HTTP-Header, damit die Tests unter
 * gleichwertigen Bedingungen laufen wie die echte App.
 *
 * Parität ist *semantisch*, nicht byte-genau:
 * - Tauri hält die Direktiven in einer HashMap; die Reihenfolge im Header ist dort unbestimmt.
 *   Hier wird in Einfügereihenfolge serialisiert – für den Browser ist das gleichwertig.
 * - Tauri ergänzt beim Ausliefern SHA-256-Hashes der gebündelten Skriptdateien in `script-src`
 *   (wirkungsgleich zu `'self'`) sowie Hashes/Nonces für Inline-Skripte und `<style>`-Elemente
 *   im ausgelieferten HTML. Solcher Inline-Code würde die Richtlinie der App gegenüber der
 *   Vorschau verändern; `findInlineCode` prüft deshalb das gebaute `dist/index.html`
 *   (e2e/security.spec.ts) und die Quelle (src/csp.test.ts).
 */

/** Quellen einer Direktive: wie in tauri.conf.json als Text („'self' data:“) oder Liste. */
export type CspSources = string | readonly string[];
/** Direktiven-Tabelle wie in tauri.conf.json (`"script-src": "'self'"`). */
export type CspDirectives = Readonly<Record<string, CspSources>>;
/** Tauri erlaubt die CSP als fertigen Text oder als Direktiven-Tabelle. */
export type CspConfig = string | CspDirectives;

const DIRECTIVE_NAME = /^[a-z][a-z0-9-]*$/;

/** Enthält der Text Trennzeichen oder Steuerzeichen, die einen Header verfälschen könnten? */
function hasUnsafeCharacters(value: string, allowSemicolon: boolean): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === ',' || (!allowSemicolon && char === ';')) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitSources(directive: string, sources: unknown): string[] {
  let entries: readonly unknown[];
  if (typeof sources === 'string') {
    entries = [sources];
  } else if (Array.isArray(sources)) {
    entries = sources;
  } else {
    throw new TypeError(`CSP-Direktive „${directive}“: Quellen müssen Text oder eine Liste sein.`);
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new TypeError(`CSP-Direktive „${directive}“: jede Quelle muss Text sein.`);
    }
    for (const token of entry.split(/\s+/)) {
      if (token === '') {
        continue;
      }
      if (hasUnsafeCharacters(token, false)) {
        throw new Error(`CSP-Direktive „${directive}“: ungültige Quelle „${token}“.`);
      }
      result.push(token);
    }
  }
  return result;
}

/**
 * Serialisiert eine CSP im Format von Tauri: Text wird (bereinigt) übernommen, eine
 * Direktiven-Tabelle wird in Einfügereihenfolge zu „name quelle …; name …“. Wirft bei leeren oder ungültigen
 * Angaben, damit eine kaputte Richtlinie nie unbemerkt (und damit wirkungslos) ausgeliefert wird.
 */
export function serializeCsp(csp: CspConfig): string {
  if (typeof csp === 'string') {
    const policy = csp.trim();
    if (policy === '' || hasUnsafeCharacters(policy, true)) {
      throw new Error('CSP: Die Richtlinie ist leer oder enthält Steuerzeichen.');
    }
    return policy;
  }
  if (!isRecord(csp)) {
    throw new TypeError('CSP: Erwartet wird Text oder eine Direktiven-Tabelle.');
  }
  const directives = Object.entries(csp).map(([name, sources]) => {
    if (!DIRECTIVE_NAME.test(name)) {
      throw new Error(`CSP: ungültiger Direktiven-Name „${name}“.`);
    }
    const tokens = splitSources(name, sources);
    return tokens.length === 0 ? name : `${name} ${tokens.join(' ')}`;
  });
  if (directives.length === 0) {
    throw new Error('CSP: Die Direktiven-Tabelle ist leer.');
  }
  return directives.join('; ');
}

/**
 * Liest `app.security.csp` aus einer (geparsten) tauri.conf.json und serialisiert sie.
 * Fehlt die CSP, ist das ein Sicherheitsfehler – die Funktion wirft dann, statt eine Vorschau
 * ohne Richtlinie zu starten.
 */
export function cspFromTauriConfig(config: unknown): string {
  const app = isRecord(config) ? config['app'] : undefined;
  const security = isRecord(app) ? app['security'] : undefined;
  const csp = isRecord(security) ? security['csp'] : undefined;
  if (csp === undefined || csp === null) {
    throw new Error('tauri.conf.json: app.security.csp fehlt – ohne CSP wird nichts ausgeliefert.');
  }
  if (typeof csp !== 'string' && !isRecord(csp)) {
    throw new TypeError('tauri.conf.json: app.security.csp muss Text oder eine Tabelle sein.');
  }
  return serializeCsp(csp as CspConfig);
}

/**
 * Findet Inline-Code im HTML, den Tauri beim Ausliefern mit Hashes/Nonces versehen würde
 * (dann wiche die CSP der App von der Vorschau ab) oder den die CSP ohnehin blockiert:
 * `<style>`-Elemente, Skripte ohne `src` oder mit Inhalt, Skripte von fremden Ursprüngen,
 * `style`-Attribute und Inline-Ereignis-Handler. Leere Liste = sauber.
 */
export function findInlineCode(html: string): string[] {
  const findings: string[] = [];
  if (/<style[\s>]/i.test(html)) {
    findings.push('<style>-Element');
  }
  for (const [, attributes = '', body = ''] of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
  )) {
    const src = /\bsrc\s*=\s*["']?([^"'\s>]*)/i.exec(attributes)?.[1];
    if (src === undefined || src === '') {
      findings.push(`Inline-Skript: <script${attributes}>`);
    } else if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
      findings.push(`Skript von fremdem Ursprung: ${src}`);
    }
    if (body.trim() !== '') {
      findings.push(`Skript mit Inhalt: <script${attributes}>`);
    }
  }
  for (const [tag = ''] of html.matchAll(/<[a-z][^>]*>/gi)) {
    if (/\sstyle\s*=/i.test(tag)) {
      findings.push(`style-Attribut: ${tag}`);
    }
    if (/\son[a-z]+\s*=/i.test(tag)) {
      findings.push(`Inline-Ereignis-Handler: ${tag}`);
    }
  }
  return findings;
}
