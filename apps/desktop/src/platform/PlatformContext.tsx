import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import type { AppInfo } from './appInfo.ts';
import {
  listenWhileMounted,
  reportPlatformError,
  type Platform,
  type WindowApi,
} from './platform.ts';

const PlatformContext = createContext<Platform | null>(null);

export interface PlatformProviderProps {
  readonly platform: Platform;
  readonly children: ReactNode;
}

/** Stellt den Plattform-Adapter bereit (in Tests ein Ersatz, in der App `detectPlatform()`). */
export function PlatformProvider({ platform, children }: PlatformProviderProps) {
  return <PlatformContext value={platform}>{children}</PlatformContext>;
}

/** Aktueller Plattform-Adapter (innerhalb von `<PlatformProvider>`). */
export function usePlatform(): Platform {
  const platform = use(PlatformContext);
  if (platform === null) {
    throw new Error('usePlatform: kein <PlatformProvider> vorhanden.');
  }
  return platform;
}

export type AppInfoState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly info: AppInfo }
  | { readonly status: 'error' };

/** Lädt `app_info` einmal; Fehler werden angezeigt statt geraten. */
export function useAppInfo(): AppInfoState {
  const platform = usePlatform();
  const [state, setState] = useState<AppInfoState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    platform.appInfo().then(
      (info) => {
        if (active) {
          setState({ status: 'ready', info });
        }
      },
      (error: unknown) => {
        reportPlatformError('app_info', error);
        if (active) {
          setState({ status: 'error' });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [platform]);
  return state;
}

/**
 * Ist das Fenster maximiert? Wird beim Start und nach jeder Größenänderung neu gelesen –
 * auch wenn Windows das Fenster per Andocken oder Doppelklick verändert.
 */
export function useWindowMaximized(windowApi: WindowApi | null): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (windowApi === null) {
      return undefined;
    }
    let active = true;
    const refresh = (): void => {
      windowApi.isMaximized().then(
        (value) => {
          if (active) {
            setMaximized(value);
          }
        },
        (error: unknown) => reportPlatformError('isMaximized', error),
      );
    };
    refresh();
    const stop = listenWhileMounted('onResized', () => windowApi.onResized(refresh));
    return () => {
      active = false;
      stop();
    };
  }, [windowApi]);
  return maximized;
}
