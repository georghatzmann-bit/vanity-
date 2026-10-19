import { BOOT_FALLBACK_MS, BOOT_SKIP_FADE_MS, REDUCED_MOTION_QUERY } from '@aegis/ui';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeApps, renderApp, stubLanguages, stubMatchMedia } from './test/harness.tsx';

/** Natürliches Ende der Start-Animation bei durationScale = 1 (siehe bootTimeline). */
const BOOT_NATURAL_MS = 1500;
/** Puffer für einzelne Animations-Frames (rAF wird von den Fake-Timern im 16-ms-Takt bedient). */
const FRAME_SLACK_MS = 50;

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function bootLayer(): HTMLElement | null {
  return screen.queryByTestId('aegis-boot');
}

function shell(): HTMLElement {
  return screen.getByTestId('shell');
}

function expectBooting(): void {
  expect(bootLayer()).toBeInTheDocument();
  expect(shell()).toHaveAttribute('inert');
  expect(shell()).toHaveAttribute('aria-hidden', 'true');
  expect(shell()).toHaveAttribute('data-state', 'booting');
  // Für Hilfstechnologien noch unsichtbar.
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  expect(screen.queryByRole('main')).toBeNull();
  expect(screen.queryByRole('navigation')).toBeNull();
}

function expectReady(title = 'Dashboard'): void {
  expect(bootLayer()).toBeNull();
  expect(shell()).not.toHaveAttribute('inert');
  expect(shell()).not.toHaveAttribute('aria-hidden');
  expect(shell()).toHaveAttribute('data-state', 'ready');
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: title })).toHaveFocus();
}

beforeEach(() => {
  vi.useFakeTimers();
  stubLanguages(['de-DE']);
});

afterEach(() => {
  disposeApps();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App – Start-Animation', () => {
  it('zeigt zuerst die Start-Ebene; die Shell liegt darunter, ist aber inert', () => {
    renderApp({ settings: { bootAnimation: true } });
    expectBooting();
    const boot = bootLayer();
    // Start-Ebene steht im DOM vor der Shell (Screenreader hören zuerst den Status).
    expect(boot?.compareDocumentPosition(shell()) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    advance(1);
    expect(screen.getByText('AEGIS wird gestartet')).toBeInTheDocument();
  });

  it('gibt die Shell nach dem natürlichen Ende frei und fokussiert die Überschrift der Seite', () => {
    renderApp({ settings: { bootAnimation: true } });
    advance(BOOT_NATURAL_MS - 100);
    expectBooting();
    advance(100 + FRAME_SLACK_MS);
    expectReady();
  });

  it('fokussiert nach dem Start die Überschrift der Seite aus der Adresse', () => {
    renderApp({ settings: { bootAnimation: true }, hash: '#/settings' });
    advance(BOOT_NATURAL_MS + FRAME_SLACK_MS);
    expectReady('Einstellungen');
  });

  it('überspringt mit Escape nach kurzer Blende', () => {
    renderApp({ settings: { bootAnimation: true } });
    advance(200);
    expectBooting();
    fireEvent.keyDown(window, { key: 'Escape' });
    advance(BOOT_SKIP_FADE_MS + FRAME_SLACK_MS);
    expectReady();
  });

  // Echte Tastatur (Tab + Enter im Browser) prüft zusätzlich e2e/boot.spec.ts.
  it('überspringt per Tastatur über den Button (Tab, dann Enter)', () => {
    renderApp({ settings: { bootAnimation: true } });
    advance(200);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' });
    const skip = screen.getByRole('button', { name: /Überspringen/ });
    expect(skip).toHaveFocus();
    expectBooting();
    fireEvent.keyDown(skip, { key: 'Enter' });
    advance(BOOT_SKIP_FADE_MS + FRAME_SLACK_MS);
    expectReady();
  });

  it('Kürzel der App wirken während der Start-Animation nicht', () => {
    renderApp({ settings: { bootAnimation: true } });
    advance(200);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('respektiert die Systemeinstellung „Bewegung reduzieren“: statisch, nach ≤ 300 ms frei', () => {
    stubMatchMedia({ [REDUCED_MOTION_QUERY]: true });
    renderApp({ settings: { bootAnimation: true } });
    expect(bootLayer()).toHaveAttribute('data-reduced-motion', 'true');
    expectBooting();
    advance(300 + FRAME_SLACK_MS);
    expectReady();
  });

  it('App-Einstellung „Bewegung: Reduziert“ gilt auch für die Start-Animation', () => {
    stubMatchMedia({ [REDUCED_MOTION_QUERY]: false });
    renderApp({ settings: { bootAnimation: true, motion: 'reduced' } });
    expect(bootLayer()).toHaveAttribute('data-reduced-motion', 'true');
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduced');
    advance(300 + FRAME_SLACK_MS);
    expectReady();
  });

  it('ohne Start-Animation (Einstellung aus) ist die Shell sofort bedienbar', () => {
    renderApp({ settings: { bootAnimation: false } });
    expect(bootLayer()).toBeNull();
    expectReady();
  });

  it('Start-Animation erneut abspielen: Shell wieder inert, danach Fokus auf die Überschrift', () => {
    renderApp({ settings: { bootAnimation: false } });
    fireEvent.click(screen.getByTestId('replay-boot'));
    expectBooting();
    advance(BOOT_NATURAL_MS + FRAME_SLACK_MS);
    expectReady();
    expect(screen.getByText('Start-Animation abgespielt')).toBeInTheDocument();
  });

  it('gibt die Shell im StrictMode genau einmal frei und bleibt danach stabil', () => {
    renderApp({ settings: { bootAnimation: true }, strict: true });
    advance(BOOT_NATURAL_MS + FRAME_SLACK_MS);
    expectReady();
    // Auch die harte Obergrenze der Start-Animation darf nichts mehr verändern.
    advance(BOOT_FALLBACK_MS * 2);
    expectReady();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('App – Gestaltungsregeln', () => {
  const sources = import.meta.glob<string>(['./**/*.{ts,tsx,css}', '!./**/*.test.{ts,tsx}'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('verwendet in keiner Quelldatei hart codierte Farben (nur Design-Tokens)', () => {
    const hardCodedColor = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i;
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThan(20);
    for (const [file, source] of files) {
      expect(source, file).not.toMatch(hardCodedColor);
    }
  });

  it('animiert nur transform/opacity (keine Breiten-, Höhen- oder Positions-Übergänge)', () => {
    const layoutTransition = /transition-(?:all|\[[^\]]*(?:width|height|top|left|margin|padding))/;
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(layoutTransition);
    }
  });

  it('lädt nichts von außen (keine URLs in den Quellen außer Tauri-Ereignisnamen)', () => {
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(/https?:\/\//);
    }
  });
});
