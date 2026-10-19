import { BootSequence, ToastProvider } from '@aegis/ui';
import { MotionConfig } from 'motion/react';
import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ServicesProvider,
  useServices,
  useSettingsSnapshot,
  useSystemReducedMotion,
  type AppServices,
} from './app/services.tsx';
import { I18nProvider, useT } from './i18n/I18nProvider.tsx';
import { applyDocumentPreferences, resolvePreferences } from './settings/preferences.ts';
import { useSystemColorScheme, useSystemLanguages } from './settings/system.ts';
import { Shell } from './shell/Shell.tsx';

export interface AppProps {
  readonly services: AppServices;
}

/**
 * Wurzel der Desktop-App. Reihenfolge beim Start: Einstellungen und Systemvorlieben ergeben
 * Sprache, Darstellung und Bewegung; dann (falls eingeschaltet) die Start-Animation, darunter
 * bereits eingehängt die Shell – `inert` und `aria-hidden`, bis die Animation fertig ist.
 */
export function App({ services }: AppProps) {
  return (
    <ServicesProvider services={services}>
      <AppRoot />
    </ServicesProvider>
  );
}

function AppRoot() {
  const { settings: store, activity } = useServices();
  const { settings } = useSettingsSnapshot();
  const colorScheme = useSystemColorScheme();
  const languages = useSystemLanguages();
  const systemReducedMotion = useSystemReducedMotion();
  const preferences = useMemo(
    () =>
      resolvePreferences(settings, {
        colorScheme,
        languages,
        reducedMotion: systemReducedMotion,
      }),
    [settings, colorScheme, languages, systemReducedMotion],
  );

  // Vor dem Zeichnen setzen, damit beim Wechsel nichts im alten Farbschema aufblitzt.
  useLayoutEffect(() => {
    applyDocumentPreferences(document.documentElement, preferences);
  }, [preferences]);

  // Die Start-Animation richtet sich nach der Einstellung *beim Start*; später nur auf Wunsch.
  const [booting, setBooting] = useState(() => store.getSnapshot().settings.bootAnimation);
  const [bootRun, setBootRun] = useState(0);
  const [bootCount, setBootCount] = useState(0);

  const replayBoot = useCallback(() => {
    activity.record({ kind: 'boot-replayed' });
    setBootRun((run) => run + 1);
    setBooting(true);
  }, [activity]);

  const finishBoot = useCallback(() => {
    setBooting(false);
    setBootCount((count) => count + 1);
  }, []);

  return (
    <I18nProvider language={preferences.language} locale={preferences.locale}>
      <MotionConfig reducedMotion={preferences.reducedMotion ? 'always' : 'never'}>
        {booting && <Boot key={bootRun} onComplete={finishBoot} />}
        <AppToasts>
          <Shell
            ready={!booting}
            bootCount={bootCount}
            preferences={preferences}
            onReplayBoot={replayBoot}
          />
        </AppToasts>
      </MotionConfig>
    </I18nProvider>
  );
}

function Boot({ onComplete }: { readonly onComplete: () => void }) {
  const { t } = useT();
  return (
    <BootSequence
      onComplete={onComplete}
      skipLabel={t('boot.skip')}
      statusLabel={t('boot.status')}
    />
  );
}

function AppToasts({ children }: { readonly children: ReactNode }) {
  const { t } = useT();
  const labels = useMemo(() => ({ region: t('toast.region'), dismiss: t('toast.dismiss') }), [t]);
  return <ToastProvider labels={labels}>{children}</ToastProvider>;
}
