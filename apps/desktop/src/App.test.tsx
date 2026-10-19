import { BOOT_FALLBACK_MS, BOOT_SKIP_FADE_MS, REDUCED_MOTION_QUERY } from '@aegis/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import appSource from './App.tsx?raw';
import homeSource from './Home.tsx?raw';

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

function home(): HTMLElement {
  return screen.getByTestId('home');
}

function expectBooting(): void {
  expect(bootLayer()).toBeInTheDocument();
  expect(home()).toHaveAttribute('inert');
  expect(home()).toHaveAttribute('aria-hidden', 'true');
  expect(home()).toHaveAttribute('data-state', 'booting');
  // Für Hilfstechnologien noch unsichtbar.
  expect(screen.queryByRole('heading', { name: 'AEGIS Suite' })).toBeNull();
  expect(screen.queryByRole('main')).toBeNull();
}

function expectReady(): void {
  expect(bootLayer()).toBeNull();
  expect(home()).not.toHaveAttribute('inert');
  expect(home()).not.toHaveAttribute('aria-hidden');
  expect(home()).toHaveAttribute('data-state', 'ready');
  expect(screen.getByRole('main')).toBe(home());
  const heading = screen.getByRole('heading', { level: 1, name: 'AEGIS Suite' });
  expect(heading).toHaveFocus();
  expect(screen.getByText('Fundament bereit · Phase P0')).toBeInTheDocument();
}

/** Simuliert die Systemeinstellung „Bewegung reduzieren“ (jsdom kennt kein matchMedia). */
function stubReducedMotion(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: media === REDUCED_MOTION_QUERY,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('App – Start-Animation und Startseite', () => {
  it('zeigt zuerst die Start-Ebene; die Startseite liegt darunter, ist aber inert', () => {
    render(<App />);
    expectBooting();

    const boot = bootLayer();
    expect(boot).not.toBeNull();
    // Start-Ebene steht im DOM vor dem App-Inhalt (Screenreader hören zuerst den Status).
    expect(boot?.compareDocumentPosition(home()) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    advance(1);
    expect(screen.getByRole('status')).toHaveTextContent('AEGIS wird gestartet');
  });

  it('gibt die Startseite erst nach dem natürlichen Ende frei und fokussiert die Überschrift', () => {
    render(<App />);
    advance(BOOT_NATURAL_MS - 100);
    expectBooting();

    advance(100 + FRAME_SLACK_MS);
    expectReady();
  });

  it('überspringt mit Escape nach kurzer Blende', () => {
    render(<App />);
    advance(200);
    expectBooting();

    fireEvent.keyDown(window, { key: 'Escape' });
    advance(BOOT_SKIP_FADE_MS + FRAME_SLACK_MS);
    expectReady();
  });

  // Echte Tastatur (Tab + Enter im Browser) prüft zusätzlich e2e/boot.spec.ts. Hier bewusst
  // fireEvent statt user-event: dessen asynchrone Hülle wartet unter Vitest-Fake-Timern ewig.
  it('überspringt per Tastatur über den Button (Tab, dann Enter)', () => {
    render(<App />);
    advance(200);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' });
    const skip = screen.getByRole('button', { name: /Überspringen/ });
    expect(skip).toHaveFocus();
    expectBooting();

    fireEvent.keyDown(skip, { key: 'Enter' });
    advance(BOOT_SKIP_FADE_MS + FRAME_SLACK_MS);
    expectReady();
  });

  it('überspringt per Klick auf die Start-Ebene', () => {
    render(<App />);
    advance(200);
    const boot = bootLayer();
    expect(boot).not.toBeNull();
    if (boot !== null) {
      fireEvent.click(boot);
    }
    advance(BOOT_SKIP_FADE_MS + FRAME_SLACK_MS);
    expectReady();
  });

  it('respektiert „Bewegung reduzieren“: statisch und nach höchstens 300 ms frei', () => {
    stubReducedMotion();
    render(<App />);
    expect(bootLayer()).toHaveAttribute('data-reduced-motion', 'true');
    expectBooting();

    advance(300 + FRAME_SLACK_MS);
    expectReady();
  });

  it('gibt die Startseite im StrictMode genau einmal frei und bleibt danach stabil', () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    advance(BOOT_NATURAL_MS + FRAME_SLACK_MS);
    expectReady();

    // Auch die harte Obergrenze der Start-Animation darf nichts mehr verändern.
    advance(BOOT_FALLBACK_MS * 2);
    expectReady();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('App – Gestaltungsregeln', () => {
  it('verwendet keine hart codierten Farben (nur Design-Tokens)', () => {
    const hardCodedColor = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/i;
    for (const source of [appSource, homeSource]) {
      expect(source).not.toMatch(hardCodedColor);
    }
  });
});
