import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSoundEnabled } from '../sound/preference.ts';
import { getUiSound } from '../sound/synth.ts';
import { mockMatchMedia } from '../test/matchMedia.ts';
import { BootSequence } from './BootSequence.tsx';
import { BOOT_FALLBACK_MS } from './timeline.ts';

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function layer(): HTMLElement {
  return screen.getByTestId('aegis-boot');
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSoundEnabled(true);
});

describe('BootSequence – Ablauf', () => {
  it('durchläuft die Phasen und meldet das natürliche Ende genau einmal (≈ 1,5 s)', () => {
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} sound={false} />);
    expect(layer()).toHaveAttribute('data-reduced-motion', 'false');

    advance(100);
    expect(layer()).toHaveAttribute('data-phase', 'draw');
    advance(300);
    expect(layer()).toHaveAttribute('data-phase', 'inner');
    advance(300);
    expect(layer()).toHaveAttribute('data-phase', 'sweep');
    advance(300);
    expect(layer()).toHaveAttribute('data-phase', 'word');
    advance(400);
    expect(layer()).toHaveAttribute('data-phase', 'exit');
    expect(onComplete).not.toHaveBeenCalled();

    advance(150);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('aegis-boot')).toBeNull();

    advance(BOOT_FALLBACK_MS * 2);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('zeichnet über Masken (pathLength) und blendet nur per transform/opacity', () => {
    const { container } = render(<BootSequence onComplete={vi.fn()} sound={false} />);
    expect(container.querySelectorAll('mask')).toHaveLength(3);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(container.innerHTML).not.toMatch(/filter:/);
  });

  it('meldet den Start über eine Statusregion', () => {
    render(<BootSequence onComplete={vi.fn()} sound={false} />);
    advance(1);
    expect(screen.getByRole('status')).toHaveTextContent('AEGIS wird gestartet');
  });

  it('erlaubt eine eigene Statusmeldung', () => {
    render(<BootSequence onComplete={vi.fn()} sound={false} statusLabel="Starte …" />);
    advance(1);
    expect(screen.getByRole('status')).toHaveTextContent('Starte …');
  });

  it('skaliert die Dauer (durationScale) und begrenzt sie', () => {
    const slow = vi.fn();
    const { unmount } = render(<BootSequence onComplete={slow} durationScale={2} sound={false} />);
    advance(2900);
    expect(slow).not.toHaveBeenCalled();
    advance(200);
    expect(slow).toHaveBeenCalledTimes(1);
    unmount();

    const capped = vi.fn();
    render(<BootSequence onComplete={capped} durationScale={100} sound={false} />);
    advance(3800);
    expect(capped).toHaveBeenCalledTimes(1);
  });

  it('ist mit durationScale = 0 sofort fertig', () => {
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} durationScale={0} sound={false} />);
    advance(50);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('meldet auch im StrictMode (doppelte Effekte) genau einmal', () => {
    const onComplete = vi.fn();
    render(
      <StrictMode>
        <BootSequence onComplete={onComplete} sound={false} />
      </StrictMode>,
    );
    advance(2000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('ruft immer den aktuellen onComplete-Callback auf', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<BootSequence onComplete={first} sound={false} />);
    advance(500);
    rerender(<BootSequence onComplete={second} sound={false} />);
    advance(1200);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('räumt beim vorzeitigen Aushängen auf und meldet dann nichts', () => {
    const onComplete = vi.fn();
    const { unmount } = render(<BootSequence onComplete={onComplete} sound={false} />);
    advance(300);
    unmount();
    advance(BOOT_FALLBACK_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('BootSequence – Überspringen', () => {
  it.each([
    ['Escape', 'Escape'],
    ['Enter', 'Enter'],
    ['Leertaste', ' '],
  ])('per %s: kurze Blende, dann genau einmal fertig', (_name, key) => {
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} sound={false} />);
    advance(300);
    const notPrevented = fireEvent.keyDown(window, { key });
    expect(notPrevented).toBe(false);
    advance(100);
    expect(onComplete).not.toHaveBeenCalled();
    advance(60);
    expect(onComplete).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key });
    advance(BOOT_FALLBACK_MS * 2);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('hält Tasten von der App darunter fern', () => {
    const appListener = vi.fn();
    document.body.addEventListener('keydown', appListener);
    render(<BootSequence onComplete={vi.fn()} sound={false} />);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(appListener).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', appListener);
  });

  it('ignoriert andere Tasten und Tastenkombinationen', () => {
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} sound={false} />);
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape', altKey: true });
    advance(400);
    expect(onComplete).not.toHaveBeenCalled();
    expect(layer()).toHaveAttribute('data-phase', 'inner');
  });

  it('per Klick irgendwo', () => {
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} sound={false} />);
    advance(200);
    fireEvent.click(layer());
    fireEvent.click(layer());
    advance(200);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('per sichtbarem, fokussierbarem Button „Überspringen“', () => {
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} sound={false} />);
    const button = screen.getByRole('button', { name: 'Überspringen' });
    expect(button).toHaveAttribute('type', 'button');
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    advance(200);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('führt das erste Tab aus der verdeckten App zum Button – ohne Fokusfalle', () => {
    const outside = document.createElement('button');
    outside.textContent = 'App';
    document.body.append(outside);
    outside.focus();
    render(<BootSequence onComplete={vi.fn()} sound={false} />);
    const skip = screen.getByRole('button', { name: 'Überspringen' });

    const firstTab = fireEvent.keyDown(document.activeElement ?? window, { key: 'Tab' });
    expect(firstTab).toBe(false);
    expect(skip).toHaveFocus();

    // Danach greift die normale Tab-Reihenfolge (kein erneutes Umlenken).
    outside.focus();
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(true);
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('lenkt Tab nicht um, wenn der Fokus schon in der Start-Animation liegt', () => {
    render(<BootSequence onComplete={vi.fn()} sound={false} />);
    const skip = screen.getByRole('button', { name: 'Überspringen' });
    skip.focus();
    expect(fireEvent.keyDown(skip, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(skip, { key: 'Tab', ctrlKey: true })).toBe(true);
  });

  it('übernimmt eine eigene Button-Beschriftung', () => {
    render(<BootSequence onComplete={vi.fn()} sound={false} skipLabel="Skip intro" />);
    expect(screen.getByRole('button', { name: 'Skip intro' })).toBeInTheDocument();
  });

  it('auch während des Ausblendens', () => {
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} sound={false} />);
    advance(1400);
    expect(layer()).toHaveAttribute('data-phase', 'exit');
    fireEvent.keyDown(window, { key: 'Escape' });
    advance(1000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('BootSequence – reduzierte Bewegung', () => {
  it('zeigt das statische Logo ohne Zeichnen/Lichtlinie und ist nach ≤ 300 ms fertig', () => {
    mockMatchMedia(true);
    const onComplete = vi.fn();
    const { container } = render(<BootSequence onComplete={onComplete} sound={false} />);
    expect(layer()).toHaveAttribute('data-reduced-motion', 'true');
    expect(container.querySelectorAll('mask')).toHaveLength(0);
    advance(100);
    expect(layer()).toHaveAttribute('data-phase', 'static');
    advance(150);
    expect(layer()).toHaveAttribute('data-phase', 'exit');
    expect(onComplete).not.toHaveBeenCalled();
    advance(100);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('lässt sich auch dann überspringen', () => {
    mockMatchMedia(true);
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} sound={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    advance(160);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('BootSequence – harte Obergrenze', () => {
  it('ist spätestens nach 4 s fertig, auch wenn requestAnimationFrame hängt', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const onComplete = vi.fn();
    render(<BootSequence onComplete={onComplete} sound={false} />);
    advance(BOOT_FALLBACK_MS - 1);
    expect(layer()).toHaveAttribute('data-phase', 'idle');
    expect(onComplete).not.toHaveBeenCalled();
    advance(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    advance(BOOT_FALLBACK_MS);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('BootSequence – Klang', () => {
  it('spielt den Start-Klang genau einmal, wenn Klang an ist (auch im StrictMode)', () => {
    const chime = vi.spyOn(getUiSound(), 'bootChime').mockImplementation(() => undefined);
    render(
      <StrictMode>
        <BootSequence onComplete={vi.fn()} />
      </StrictMode>,
    );
    expect(chime).toHaveBeenCalledTimes(1);
  });

  it('bleibt still mit sound={false} oder global ausgeschaltetem Klang', () => {
    const chime = vi.spyOn(getUiSound(), 'bootChime').mockImplementation(() => undefined);
    const { unmount } = render(<BootSequence onComplete={vi.fn()} sound={false} />);
    unmount();
    setSoundEnabled(false);
    render(<BootSequence onComplete={vi.fn()} />);
    expect(chime).not.toHaveBeenCalled();
  });
});
