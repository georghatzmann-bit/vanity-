import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TIMEOUT_MS } from '../utils/time.ts';
import { useControllableState } from './useControllableState.ts';
import { useNow } from './useNow.ts';
import { usePresence } from './usePresence.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useControllableState', () => {
  it('führt den Zustand selbst, wenn kein Wert übergeben wird', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useControllableState({ value: undefined, defaultValue: 'a', onChange }),
    );
    expect(result.current[0]).toBe('a');
    act(() => result.current[1]('b'));
    expect(result.current[0]).toBe('b');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('folgt im kontrollierten Betrieb nur dem übergebenen Wert', () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) =>
        useControllableState({ value, defaultValue: 'x', onChange }),
      { initialProps: { value: 'a' } },
    );
    act(() => result.current[1]('b'));
    expect(result.current[0]).toBe('a');
    expect(onChange).toHaveBeenCalledWith('b');
    rerender({ value: 'c' });
    expect(result.current[0]).toBe('c');
  });
});

describe('usePresence', () => {
  it('hält nach dem Schließen für die Ausblendzeit eingehängt', () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open, 150), {
      initialProps: { open: false },
    });
    expect(result.current).toBe(false);
    rerender({ open: true });
    expect(result.current).toBe(true);
    rerender({ open: false });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it('hängt ohne Ausblendzeit sofort aus und bricht das Ausblenden beim Wiederöffnen ab', () => {
    const instant = renderHook(({ open }) => usePresence(open, 0), {
      initialProps: { open: true },
    });
    instant.rerender({ open: false });
    expect(instant.result.current).toBe(false);

    const { result, rerender } = renderHook(({ open }) => usePresence(open, 150), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    rerender({ open: true });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(true);
  });
});

describe('useNow', () => {
  function Clock({ tick, a, b }: { tick: number | null; a?: number; b?: number }) {
    const now = useNow(tick, a, b);
    return <output>{now}</output>;
  }

  it('tickt im Takt und zieht nach dem Anmelden sofort nach', () => {
    render(<Clock tick={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent('10000');
    vi.setSystemTime(10_400);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByRole('status')).toHaveTextContent('10400');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('11400');
  });

  it('aktualisiert ohne Takt genau zu den Fristen', () => {
    render(<Clock tick={null} a={10_250} b={10_900} />);
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(screen.getByRole('status')).toHaveTextContent('10000');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('10250');
    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(screen.getByRole('status')).toHaveTextContent('10900');
  });

  it('ignoriert vergangene und ungültige Fristen und begrenzt sehr ferne', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    render(<Clock tick={null} a={5} b={Number.POSITIVE_INFINITY} />);
    render(<Clock tick={null} a={10_000 + MAX_TIMEOUT_MS * 2} />);
    const delays = spy.mock.calls.map((call) => call[1]);
    expect(delays).toContain(MAX_TIMEOUT_MS);
    expect(delays.filter((delay) => delay === 0).length).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
  });
});
