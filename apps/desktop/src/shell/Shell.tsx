import {
  CommandPalette,
  PageTransition,
  commandPaletteLabelsDe,
  commandPaletteLabelsEn,
} from '@aegis/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoute, useServices, useSettingsSnapshot } from '../app/services.tsx';
import { useUpdateSettings } from '../app/useUpdateSettings.ts';
import { useT } from '../i18n/I18nProvider.tsx';
import { Page } from '../pages/Page.tsx';
import { listenWhileMounted } from '../platform/platform.ts';
import type { RouteId } from '../router/routes.ts';
import type { EffectivePreferences } from '../settings/preferences.ts';
import { buildCommands } from './commands.tsx';
import { titleKey } from './navigation.ts';
import { ShellContext, type ShellActions } from './ShellContext.tsx';
import { isDialogOpen, isTextInput } from './shortcuts.ts';
import { Sidebar } from './Sidebar.tsx';
import { StatusBar } from './StatusBar.tsx';
import { TitleBar } from './TitleBar.tsx';

export interface ShellProps {
  /** `false`, solange die Start-Animation liegt: dann `inert` und vor Hilfsmitteln verborgen. */
  readonly ready: boolean;
  /** Zählt abgeschlossene Starts – nach jedem Start wandert der Fokus zur Überschrift. */
  readonly bootCount: number;
  readonly preferences: EffectivePreferences;
  readonly onReplayBoot: () => void;
}

/**
 * App-Shell: Titelleiste, Seitenleiste, Inhalt mit Seitenübergang, Statuszeile und
 * Befehlspalette. Tastenkürzel: Strg/⌘+K (Palette), „/“ (Palette, außerhalb von
 * Textfeldern), Strg/⌘+, (Einstellungen). Das Tray-Menü wechselt die Seite über
 * `aegis://navigate`.
 */
export function Shell({ ready, bootCount, preferences, onReplayBoot }: ShellProps) {
  const { t, language } = useT();
  const { platform, router, activity } = useServices();
  const { settings } = useSettingsSnapshot();
  const update = useUpdateSettings();
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const shell = useMemo<ShellActions>(
    () => ({ openPalette: () => setPaletteOpen(true), replayBoot: onReplayBoot, headingRef }),
    [onReplayBoot],
  );

  // Seitenwechsel und Start: Inhalt nach oben, Fokus auf die Überschrift der Seite – außer
  // der Wechsel kam aus der Seitenleiste (dann bleibt der Fokus dort, die Seite wird angesagt).
  useEffect(() => {
    if (!ready) {
      return;
    }
    if (mainRef.current !== null) {
      mainRef.current.scrollTop = 0;
    }
    if (navRef.current?.contains(document.activeElement) === true) {
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [route, ready, bootCount]);

  useEffect(() => {
    document.title = t('app.documentTitle', { page: t(titleKey(route)) });
  }, [route, t]);

  // Tray-Menü „Dashboard“ / „Einstellungen“.
  useEffect(
    () =>
      listenWhileMounted('aegis://navigate', () =>
        platform.onNavigate((target) => {
          activity.record({ kind: 'tray-navigate', target });
          router.navigate(target);
        }),
      ),
    [platform, router, activity],
  );

  // Globale Tastenkürzel (nicht während der Start-Animation oder über einem Dialog).
  useEffect(() => {
    if (!ready) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || isDialogOpen()) {
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && !event.shiftKey && key === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (modifier && !event.shiftKey && key === ',') {
        event.preventDefault();
        router.navigate('settings');
      } else if (!modifier && key === '/' && !isTextInput(event.target)) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ready, router]);

  const commands = useMemo(
    () =>
      buildCommands({
        t,
        settings,
        preferences,
        navigate: (target: RouteId) => router.navigate(target),
        update,
        replayBoot: onReplayBoot,
      }),
    [t, settings, preferences, router, update, onReplayBoot],
  );

  const navigateFromSidebar = (target: RouteId): void => {
    setAnnouncement(t('app.pageAnnouncement', { page: t(titleKey(target)) }));
  };

  return (
    <ShellContext value={shell}>
      <div
        className="flex h-dvh flex-col overflow-hidden bg-bg text-text"
        inert={!ready}
        aria-hidden={ready ? undefined : true}
        data-testid="shell"
        data-state={ready ? 'ready' : 'booting'}
      >
        <button
          type="button"
          onClick={() => headingRef.current?.focus()}
          className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          {t('app.skipToContent')}
        </button>
        <TitleBar onOpenPalette={() => setPaletteOpen(true)} />
        <div className="flex min-h-0 flex-1">
          <Sidebar
            ref={navRef}
            route={route}
            collapsed={settings.sidebarCollapsed}
            onCollapsedChange={(sidebarCollapsed) => update({ sidebarCollapsed })}
            onNavigate={navigateFromSidebar}
          />
          <main
            ref={mainRef}
            className="relative min-w-0 flex-1 overflow-y-auto"
            data-testid="main"
          >
            <div
              aria-hidden="true"
              className="aegis-content-glow pointer-events-none absolute inset-x-0 top-0 h-80"
            />
            <PageTransition transitionKey={route} className="relative">
              <Page route={route} />
            </PageTransition>
          </main>
        </div>
        <StatusBar />
        <p role="status" className="sr-only" data-testid="route-announcement">
          {announcement}
        </p>
      </div>
      <CommandPalette
        open={paletteOpen && ready}
        onClose={() => setPaletteOpen(false)}
        items={commands}
        labels={language === 'de' ? commandPaletteLabelsDe : commandPaletteLabelsEn}
      />
    </ShellContext>
  );
}
