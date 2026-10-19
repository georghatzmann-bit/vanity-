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
  /** Ziel des letzten Klicks in der Seitenleiste (nur dieser Wechsel lässt den Fokus dort). */
  const sidebarTarget = useRef<RouteId | null>(null);

  const shell = useMemo<ShellActions>(
    () => ({ openPalette: () => setPaletteOpen(true), replayBoot: onReplayBoot, headingRef }),
    [onReplayBoot],
  );

  // Seitenwechsel und Start: Inhalt nach oben, Fokus auf die Überschrift der Seite (Screenreader
  // lesen sie vor). Nur ein Wechsel per Seitenleiste lässt den Fokus dort – dann sagt die
  // Statusregion die Seite an. Alle anderen Wege (Strg+, Befehlspalette, Verlauf, Tray, Knöpfe
  // auf der Seite) führen zur Überschrift, auch wenn der Fokus gerade in der Navigation stand.
  useEffect(() => {
    const fromSidebar = sidebarTarget.current === route;
    sidebarTarget.current = null;
    if (!ready) {
      return;
    }
    if (mainRef.current !== null) {
      mainRef.current.scrollTop = 0;
    }
    if (fromSidebar && navRef.current?.contains(document.activeElement) === true) {
      return;
    }
    // Eine ältere Ansage der Seitenleiste gilt nicht mehr.
    setAnnouncement('');
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

  // Dieselbe Suchaufforderung wie der Suchknopf der Titelleiste.
  const paletteLabels = useMemo(
    () => ({
      ...(language === 'de' ? commandPaletteLabelsDe : commandPaletteLabelsEn),
      placeholder: t('titlebar.search'),
    }),
    [language, t],
  );

  const navigateFromSidebar = (target: RouteId): void => {
    sidebarTarget.current = target;
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
          // `focus:not-sr-only` setzt padding: 0 – der Innenabstand muss daher ebenfalls am Fokus hängen.
          className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-3 focus:py-2"
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
        labels={paletteLabels}
      />
    </ShellContext>
  );
}
