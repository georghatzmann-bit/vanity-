import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cx } from './cx.ts';
import { focusElement, getTabbableElements } from './focus.ts';
import { mergeRefs } from './refs.ts';
import { formatCountdown, formatSecondsShort, readNow, toEpochMs } from './time.ts';

describe('cx', () => {
  it('verbindet nur gesetzte Klassen', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
  });
});

describe('mergeRefs', () => {
  it('setzt Objekt- und Funktions-Refs und löst sie wieder', () => {
    const objectRef = createRef<HTMLDivElement>();
    const callback = vi.fn();
    const { unmount, container } = render(<div ref={mergeRefs(objectRef, callback, undefined)} />);
    const element = container.firstElementChild;
    expect(objectRef.current).toBe(element);
    expect(callback).toHaveBeenCalledWith(element);
    unmount();
    expect(objectRef.current).toBeNull();
    expect(callback).toHaveBeenLastCalledWith(null);
  });
});

describe('Fokus-Hilfen', () => {
  it('findet nur erreichbare Elemente in Dokument-Reihenfolge', () => {
    const { container } = render(
      <div>
        <button type="button">A</button>
        <button type="button" disabled>
          gesperrt
        </button>
        <a href="#x">Link</a>
        <a>ohne href</a>
        <input type="hidden" />
        <input aria-label="Feld" />
        <div tabIndex={-1}>nicht per Tab</div>
        <div tabIndex={0}>per Tab</div>
        <div inert>
          <button type="button">inert</button>
        </div>
        <div hidden>
          <button type="button">versteckt</button>
        </div>
        <div aria-hidden="true">
          <button type="button">verborgen</button>
        </div>
      </div>,
    );
    const names = getTabbableElements(container).map(
      (element) => element.textContent || element.getAttribute('aria-label'),
    );
    expect(names).toEqual(['A', 'Link', 'Feld', 'per Tab']);
  });

  it('fokussiert und meldet den Erfolg', () => {
    const { getByRole } = render(<button type="button">Ziel</button>);
    expect(focusElement(getByRole('button'))).toBe(true);
    expect(focusElement(null)).toBe(false);
    expect(focusElement(undefined)).toBe(false);
  });
});

describe('Zeit', () => {
  it('wandelt Zeitangaben in Epoch-Millisekunden', () => {
    expect(toEpochMs(1000)).toBe(1000);
    expect(toEpochMs(new Date(5000))).toBe(5000);
    expect(toEpochMs('1970-01-01T00:00:01Z')).toBe(1000);
    expect(toEpochMs('ungültig')).toBeNaN();
    expect(readNow()).toBeLessThanOrEqual(Date.now());
  });

  it('formatiert Restzeiten als Uhr (aufgerundet)', () => {
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(581_000)).toBe('9:41');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(formatCountdown(Number.NaN)).toBe('0:00');
    expect(formatCountdown(3_723_000)).toBe('1:02:03');
  });

  it('formatiert kurze Wartezeiten mit einer Nachkommastelle', () => {
    expect(formatSecondsShort(1500)).toBe('1,5 s');
    expect(formatSecondsShort(1401)).toBe('1,5 s');
    expect(formatSecondsShort(0)).toBe('0,0 s');
    expect(formatSecondsShort(-1)).toBe('0,0 s');
    expect(formatSecondsShort(Number.POSITIVE_INFINITY)).toBe('0,0 s');
    expect(formatSecondsShort(2000, 'en-US')).toBe('2.0 s');
  });
});
