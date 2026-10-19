import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockMatchMedia } from '../test/matchMedia.ts';
import {
  REDUCED_MOTION_QUERY,
  prefersReducedMotion,
  useReducedMotionPreference,
} from './useReducedMotionPreference.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useReducedMotionPreference', () => {
  it('ist ohne matchMedia (z. B. jsdom, SSR) „nein“', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
    const { result } = renderHook(() => useReducedMotionPreference());
    expect(result.current).toBe(false);
  });

  it('übersteht eine werfende matchMedia-Implementierung', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('kaputt');
      }),
    );
    expect(prefersReducedMotion()).toBe(false);
  });

  it('fragt die richtige Media-Query ab und reagiert live auf Änderungen', () => {
    const media = mockMatchMedia(true);
    const { result, unmount } = renderHook(() => useReducedMotionPreference());
    expect(window.matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_QUERY);
    expect(result.current).toBe(true);
    act(() => media.change(false));
    expect(result.current).toBe(false);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it('unterstützt ältere WebViews mit addListener/removeListener', () => {
    const media = mockMatchMedia(false, true);
    const { result, unmount } = renderHook(() => useReducedMotionPreference());
    expect(result.current).toBe(false);
    act(() => media.change(true));
    expect(result.current).toBe(true);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});
