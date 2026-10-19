import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Showcase } from './Showcase.tsx';

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  delete document.documentElement.dataset.theme;
});

describe('Showcase – Start-Animation als Referenz-Einbindung', () => {
  it('hält die Seite während der Start-Animation inert und verborgen, danach frei mit Fokus', () => {
    window.history.replaceState(null, '', '/?boot=1');
    // Merkt sich, ob ein Element fokussiert wurde, während es noch in einem inerten Teil lag
    // (jsdom setzt inert nicht durch – ein Browser würde den Fokus dann still verwerfen).
    const focusedWhileInert: boolean[] = [];
    const originalFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      focusedWhileInert.push(this.closest('[inert]') !== null);
      originalFocus.call(this, options);
    });

    render(<Showcase />);
    const boot = screen.getByTestId('aegis-boot');
    const content = screen.getByTestId('showcase-content');
    expect(content).toHaveAttribute('inert');
    expect(content).toHaveAttribute('aria-hidden', 'true');

    // Jedes Bedienelement liegt entweder in der Start-Ebene („Überspringen“) oder im inerten
    // Seiteninhalt – auch der Link „Zum Inhalt springen“. Tab erreicht nichts Verdecktes.
    const interactive = [...document.querySelectorAll<HTMLElement>('a[href], button')];
    expect(interactive.length).toBeGreaterThan(5);
    for (const element of interactive) {
      expect(boot.contains(element) || content.contains(element), element.outerHTML).toBe(true);
    }
    expect(content.contains(screen.getByText('Zum Inhalt springen'))).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    advance(200);

    expect(screen.queryByTestId('aegis-boot')).toBeNull();
    expect(content).not.toHaveAttribute('inert');
    expect(content).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('button', { name: 'Start-Animation abspielen' })).toHaveFocus();
    expect(focusedWhileInert).toEqual([false]);
  });

  it('ist ohne ?boot=1 sofort bedienbar und setzt keinen Fokus', () => {
    render(<Showcase />);
    expect(screen.queryByTestId('aegis-boot')).toBeNull();
    const content = screen.getByTestId('showcase-content');
    expect(content).not.toHaveAttribute('inert');
    expect(content).not.toHaveAttribute('aria-hidden');
    expect(document.body).toHaveFocus();
  });

  it('macht die Seite beim erneuten Abspielen wieder inert und gibt den Fokus zurück', () => {
    render(<Showcase />);
    const replay = screen.getByRole('button', { name: 'Start-Animation abspielen' });
    fireEvent.click(replay);
    const content = screen.getByTestId('showcase-content');
    expect(screen.getByTestId('aegis-boot')).toBeInTheDocument();
    expect(content).toHaveAttribute('inert');
    expect(content).toHaveAttribute('aria-hidden', 'true');

    advance(5000);
    expect(screen.queryByTestId('aegis-boot')).toBeNull();
    expect(content).not.toHaveAttribute('inert');
    expect(replay).toHaveFocus();
  });
});
