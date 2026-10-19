import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { cspFromTauriConfig } from '../src/csp.ts';

const tauriConfig: unknown = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
);

/** Erwartete CSP – aus derselben Quelle wie Tauri und vite preview (tauri.conf.json). */
export const expectedCsp = cspFromTauriConfig(tauriConfig);

/** `app.security.freezePrototype` aus tauri.conf.json. */
export const freezesPrototype =
  (tauriConfig as { app?: { security?: { freezePrototype?: unknown } } }).app?.security
    ?.freezePrototype === true;

export interface CspViolation {
  readonly directive: string;
  readonly blockedURI: string;
  readonly sourceFile: string;
  readonly sample: string;
}

export interface KeyRecord {
  readonly key: string;
  /** performance.now() beim Tastendruck (vor den Handlern der App). */
  readonly at: number;
  /** Phase der Start-Animation zum Zeitpunkt des Tastendrucks (null = keine Start-Ebene). */
  readonly phase: string | null;
}

/** Messwerte, die direkt im Browser erfasst werden (performance.now(), ms seit Navigation). */
export interface Probe {
  readonly cspViolations: CspViolation[];
  readonly keys: KeyRecord[];
  /** Beobachtete Phasen der Start-Animation in Reihenfolge (data-phase). */
  readonly phases: string[];
  /** Zeitpunkt, zu dem die Start-Ebene im DOM erschien. */
  bootSeenAt: number | null;
  /** data-reduced-motion der Start-Ebene beim Erscheinen. */
  bootReducedMotion: string | null;
  /** Zeitpunkt, zu dem die Shell freigegeben wurde (data-state="ready"). */
  homeReadyAt: number | null;
}

interface ProbeWindow {
  __aegisProbe: Probe;
}

/**
 * Läuft vor jedem Skript der Seite. Misst im Browser selbst (performance.now()), damit
 * Zeitangaben nicht von Abfrage-Intervallen oder der Playwright-Verbindung abhängen.
 * Muss in sich geschlossen sein (wird serialisiert).
 */
function installProbe(): void {
  const probe: Probe = {
    cspViolations: [],
    keys: [],
    phases: [],
    bootSeenAt: null,
    bootReducedMotion: null,
    homeReadyAt: null,
  };
  (window as unknown as ProbeWindow).__aegisProbe = probe;

  document.addEventListener(
    'securitypolicyviolation',
    (event) => {
      probe.cspViolations.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        sample: event.sample,
      });
    },
    true,
  );

  // Capture auf window, vor der App registriert: erfasst den Druck vor deren Handlern.
  window.addEventListener(
    'keydown',
    (event) => {
      const boot = document.querySelector('[data-testid="aegis-boot"]');
      probe.keys.push({
        key: event.key,
        at: performance.now(),
        phase: boot?.getAttribute('data-phase') ?? null,
      });
    },
    true,
  );

  const inspect = (): void => {
    const now = performance.now();
    const boot = document.querySelector('[data-testid="aegis-boot"]');
    if (boot !== null) {
      if (probe.bootSeenAt === null) {
        probe.bootSeenAt = now;
        probe.bootReducedMotion = boot.getAttribute('data-reduced-motion');
      }
      const phase = boot.getAttribute('data-phase');
      if (phase !== null && probe.phases.at(-1) !== phase) {
        probe.phases.push(phase);
      }
    }
    const home = document.querySelector('[data-testid="shell"]');
    if (probe.homeReadyAt === null && home?.getAttribute('data-state') === 'ready') {
      probe.homeReadyAt = now;
    }
  };
  new MutationObserver(inspect).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-phase', 'data-state'],
  });
}

/**
 * Wie Tauri bei `freezePrototype: true` (tauri/scripts/freeze_prototype.js): Das erste
 * Init-Skript friert `Object.prototype` ein – noch vor jedem Skript der Seite. Code, der
 * z. B. `objekt.toString = …` zuweist, wirft dann im strikten Modus einen TypeError; ohne
 * diese Nachbildung liefe er in der Vorschau, die echte App bliebe aber leer.
 */
function freezePrototype(): void {
  Object.freeze(Object.prototype);
}

/**
 * Stellt die Bedingungen des Tauri-Fensters nach (eingefrorener Prototyp laut tauri.conf.json)
 * und registriert die Messsonde – für alle folgenden Navigationen der Seite.
 */
export async function attachProbe(page: Page): Promise<void> {
  if (freezesPrototype) {
    await page.addInitScript(freezePrototype);
  }
  await page.addInitScript(installProbe);
}

export async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => (window as unknown as ProbeWindow).__aegisProbe);
}

/** Wert aus der Sonde, der gesetzt sein muss (sonst klarer Testfehler statt NaN). */
export function required(value: number | null, name: string): number {
  if (value === null) {
    throw new Error(`Messwert fehlt: ${name}`);
  }
  return value;
}

export function bootLayer(page: Page) {
  return page.getByTestId('aegis-boot');
}

/** Die App-Shell (Titelleiste, Navigation, Inhalt) – liegt während des Starts inert darunter. */
export function home(page: Page) {
  return page.getByTestId('shell');
}

/**
 * Wartet, bis die Start-Animation eine passende Phase erreicht. Prüft in jedem Frame
 * (polling: 'raf') – die Phasen dauern teils nur wenige 100 ms, und die gestaffelten
 * Wiederholungen von `expect(...).toHaveAttribute` könnten ein solches Fenster überspringen.
 */
export async function waitForBootPhase(page: Page, phase: RegExp): Promise<void> {
  await page.waitForFunction(
    ({ source, flags }) => {
      const current = document
        .querySelector('[data-testid="aegis-boot"]')
        ?.getAttribute('data-phase');
      return current !== undefined && current !== null && new RegExp(source, flags).test(current);
    },
    { source: phase.source, flags: phase.flags },
    { polling: 'raf' },
  );
}

/** Wartet, bis die Shell freigegeben ist (Start-Ebene entfernt, nicht mehr inert). */
export async function waitForHome(page: Page, timeout?: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const element = document.querySelector('[data-testid="shell"]');
      return (
        element?.getAttribute('data-state') === 'ready' &&
        !element.hasAttribute('inert') &&
        document.querySelector('[data-testid="aegis-boot"]') === null
      );
    },
    undefined,
    timeout === undefined ? undefined : { timeout },
  );
}

/** Lädt alle Schriftschnitte (auch selten genutzte Unicode-Bereiche) und meldet Fehlschläge. */
export async function loadAllFontFaces(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts];
    const results = await Promise.allSettled(faces.map((face) => face.load()));
    return results.map((result, index) => ({
      family: faces[index]?.family ?? '?',
      unicodeRange: faces[index]?.unicodeRange ?? '?',
      loaded: result.status === 'fulfilled',
    }));
  });
}

/** Gilt eine URL als lokal (Vorschau-Server, eingebettete Daten)? */
export function isLocalUrl(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
    return true;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'ws:') &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  );
}

/** Gespeicherte Einstellungen (Format wie src/settings/schema.ts). */
export const SETTINGS_KEY = 'aegis.settings';

/**
 * Legt Einstellungen vor dem ersten Laden ab – nur, wenn noch keine gespeichert sind, damit
 * ein Neuladen die vom Test geänderten Werte nicht überschreibt.
 */
export async function seedSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify({ version: 1, settings: value }));
      }
    },
    { key: SETTINGS_KEY, value: settings },
  );
}

/** Liest die gespeicherten Einstellungen der Seite. */
export async function readSettings(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null
      ? null
      : (JSON.parse(raw) as { settings: Record<string, unknown> }).settings;
  }, SETTINGS_KEY);
}

/** Wartet, bis der Seitenübergang fertig ist (sonst misst axe halb eingeblendete Farben). */
export async function waitForPageSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const view = document.querySelector('[data-transition-key]');
    return view !== null && getComputedStyle(view).opacity === '1';
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}
