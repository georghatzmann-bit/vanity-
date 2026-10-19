import {
  BootSequence,
  REDUCED_MOTION_QUERY,
  prefersReducedMotion,
  useReducedMotionPreference,
} from '@aegis/ui';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installReducedMotionOverride, type ReducedMotionController } from './reducedMotion.ts';

/** Nachgebildete System-Media-Query mit umschaltbarem Wert. */
function fakeSystemMedia(initial: Record<string, boolean>) {
  const values = new Map(Object.entries(initial));
  const lists = new Map<string, MediaQueryList & { fire(): void }>();
  const matchMedia = vi.fn((query: string) => {
    let list = lists.get(query);
    if (list === undefined) {
      const target = new EventTarget();
      // Getter per defineProperty – Object.assign würde den Wert nur einmal kopieren.
      Object.defineProperty(target, 'matches', { get: () => values.get(query) ?? false });
      const created = Object.assign(target, {
        media: query,
        onchange: null,
        addListener: (listener: EventListener) => target.addEventListener('change', listener),
        removeListener: (listener: EventListener) => target.removeEventListener('change', listener),
        fire: () => target.dispatchEvent(new Event('change')),
      });
      list = created as unknown as MediaQueryList & { fire(): void };
      lists.set(query, list);
    }
    return list;
  });
  return {
    matchMedia,
    set(query: string, value: boolean) {
      values.set(query, value);
      lists.get(query)?.fire();
    },
  };
}

function Probe() {
  const reduced = useReducedMotionPreference();
  return <p data-testid="probe">{reduced ? 'reduziert' : 'normal'}</p>;
}

let controller: ReducedMotionController | undefined;

afterEach(() => {
  controller?.uninstall();
  controller = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('App-Vorgabe „Bewegung reduziert“', () => {
  it('meldet „reduziert“, wenn die App es vorgibt – auch wenn das System es nicht will', () => {
    const system = fakeSystemMedia({ [REDUCED_MOTION_QUERY]: false });
    vi.stubGlobal('matchMedia', system.matchMedia);
    controller = installReducedMotionOverride(window);

    expect(prefersReducedMotion()).toBe(false);
    controller.setForced(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(controller.isReduced()).toBe(true);
    expect(controller.systemPrefersReduced()).toBe(false);
    controller.setForced(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('folgt weiterhin dem System, wenn die App nichts vorgibt', () => {
    const system = fakeSystemMedia({ [REDUCED_MOTION_QUERY]: false });
    vi.stubGlobal('matchMedia', system.matchMedia);
    controller = installReducedMotionOverride(window);
    const onSystem = vi.fn();
    const unsubscribe = controller.subscribeSystem(onSystem);

    system.set(REDUCED_MOTION_QUERY, true);
    expect(prefersReducedMotion()).toBe(true);
    expect(controller.systemPrefersReduced()).toBe(true);
    expect(onSystem).toHaveBeenCalledTimes(1);
    unsubscribe();
    system.set(REDUCED_MOTION_QUERY, false);
    expect(onSystem).toHaveBeenCalledTimes(1);
  });

  it('React-Hooks von @aegis/ui reagieren live auf die App-Vorgabe', () => {
    vi.stubGlobal('matchMedia', fakeSystemMedia({}).matchMedia);
    const installed = installReducedMotionOverride(window);
    controller = installed;
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('normal');
    act(() => installed.setForced(true));
    expect(screen.getByTestId('probe')).toHaveTextContent('reduziert');
    act(() => installed.setForced(false));
    expect(screen.getByTestId('probe')).toHaveTextContent('normal');
  });

  it('die Start-Animation startet bei App-Vorgabe in der reduzierten Variante', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', fakeSystemMedia({}).matchMedia);
    controller = installReducedMotionOverride(window);
    controller.setForced(true);
    render(<BootSequence onComplete={() => undefined} sound={false} />);
    expect(screen.getByTestId('aegis-boot')).toHaveAttribute('data-reduced-motion', 'true');
  });

  it('andere Media-Queries gehen unverändert an den Browser', () => {
    const system = fakeSystemMedia({ '(prefers-color-scheme: light)': true });
    vi.stubGlobal('matchMedia', system.matchMedia);
    controller = installReducedMotionOverride(window);
    expect(window.matchMedia('(prefers-color-scheme: light)').matches).toBe(true);
    expect(system.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: light)');
    // Schreibweise egal: dieselbe Abfrage → dieselbe abgeleitete Liste.
    expect(window.matchMedia('(PREFERS-REDUCED-MOTION:reduce)')).toBe(
      window.matchMedia(REDUCED_MOTION_QUERY),
    );
  });

  it('change-Ereignisse: addEventListener, addListener und onchange', () => {
    vi.stubGlobal('matchMedia', fakeSystemMedia({}).matchMedia);
    controller = installReducedMotionOverride(window);
    const list = window.matchMedia(REDUCED_MOTION_QUERY);
    const viaEvent = vi.fn();
    const viaLegacy = vi.fn();
    const viaProperty = vi.fn();
    list.addEventListener('change', viaEvent);
    list.addListener(viaLegacy);
    list.onchange = viaProperty;

    controller.setForced(true);
    controller.setForced(true); // keine Änderung → kein Ereignis
    expect(viaEvent).toHaveBeenCalledTimes(1);
    expect(viaLegacy).toHaveBeenCalledTimes(1);
    expect(viaProperty).toHaveBeenCalledTimes(1);
    expect((viaEvent.mock.calls[0]?.[0] as MediaQueryListEvent).matches).toBe(true);

    list.removeEventListener('change', viaEvent);
    list.removeListener(viaLegacy);
    list.addListener(null);
    list.removeListener(null);
    controller.setForced(false);
    expect(viaEvent).toHaveBeenCalledTimes(1);
    expect(viaLegacy).toHaveBeenCalledTimes(1);
    expect(viaProperty).toHaveBeenCalledTimes(2);
  });

  it('ohne Browser-matchMedia (jsdom): App-Vorgabe wirkt, andere Abfragen treffen nie zu', () => {
    expect(typeof window.matchMedia).not.toBe('function');
    controller = installReducedMotionOverride(window);
    expect(window.matchMedia('(min-width: 1px)').matches).toBe(false);
    expect(prefersReducedMotion()).toBe(false);
    controller.setForced(true);
    expect(prefersReducedMotion()).toBe(true);
    controller.uninstall();
    controller = undefined;
    expect(typeof window.matchMedia).not.toBe('function');
  });

  it('uninstall stellt das ursprüngliche matchMedia wieder her und meldet sich beim System ab', () => {
    const system = fakeSystemMedia({ [REDUCED_MOTION_QUERY]: false });
    vi.stubGlobal('matchMedia', system.matchMedia);
    const installed = installReducedMotionOverride(window);
    const onSystem = vi.fn();
    installed.subscribeSystem(onSystem);
    installed.uninstall();
    expect(window.matchMedia).toBe(system.matchMedia);
    system.set(REDUCED_MOTION_QUERY, true);
    expect(onSystem).not.toHaveBeenCalled();
  });

  it('ältere WebViews ohne addEventListener: Systemänderungen über addListener', () => {
    let matches = false;
    const listeners = new Set<() => void>();
    const legacyList = {
      media: REDUCED_MOTION_QUERY,
      get matches() {
        return matches;
      },
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => legacyList),
    );
    const installed = installReducedMotionOverride(window);
    const onSystem = vi.fn();
    installed.subscribeSystem(onSystem);
    matches = true;
    for (const listener of listeners) {
      listener();
    }
    expect(onSystem).toHaveBeenCalledTimes(1);
    expect(prefersReducedMotion()).toBe(true);
    installed.uninstall();
    expect(listeners.size).toBe(0);
  });

  it('übersteht ein werfendes matchMedia (ältere WebViews, Richtlinien)', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('nicht erlaubt');
      }),
    );
    controller = installReducedMotionOverride(window);
    expect(controller.systemPrefersReduced()).toBe(false);
    controller.setForced(true);
    expect(prefersReducedMotion()).toBe(true);
  });
});
