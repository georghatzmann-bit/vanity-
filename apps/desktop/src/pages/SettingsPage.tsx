import {
  Button,
  IconArrowRight,
  IconMoon,
  IconSun,
  IconWarning,
  Panel,
  SegmentedControl,
  Toggle,
  getUiSound,
} from '@aegis/ui';
import { useId, type ReactNode } from 'react';
import { useServices, useSettingsSnapshot, useSystemReducedMotion } from '../app/services.tsx';
import { useUpdateSettings } from '../app/useUpdateSettings.ts';
import { useT } from '../i18n/I18nProvider.tsx';
import { useAppInfo } from '../platform/PlatformContext.tsx';
import type { LanguageSetting, MotionSetting, ThemeSetting } from '../settings/schema.ts';
import { useSystemColorScheme } from '../settings/system.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';

export function SettingsPage() {
  const { t, language } = useT();
  const { platform, router } = useServices();
  const { settings, persistence } = useSettingsSnapshot();
  const update = useUpdateSettings();
  const systemScheme = useSystemColorScheme();
  const systemReduced = useSystemReducedMotion();
  const appInfo = useAppInfo();
  // Rust meldet kein (verlässliches) Symbol im Infobereich: Schließen beendet AEGIS immer.
  const trayMissing = appInfo.status === 'ready' && !appInfo.info.trayAvailable;

  return (
    <PageBody width="narrow">
      <PageHeader
        eyebrow={t('pages.settings.eyebrow')}
        title={t('pages.settings.title')}
        description={t('pages.settings.description')}
      />

      {persistence !== 'persistent' && (
        <p
          role="status"
          className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-surface-1 px-4 py-3 text-sm text-text-muted"
          data-testid="settings-persistence"
        >
          <IconWarning size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />
          {persistence === 'read-only-newer'
            ? t('settings.persistence.newer')
            : t('settings.persistence.memoryOnly')}
        </p>
      )}

      <Panel
        title={t('settings.sections.appearance')}
        padding="none"
        data-testid="settings-appearance"
      >
        <SettingRow
          label={t('settings.language.label')}
          description={t('settings.language.description')}
          hint={
            settings.language === 'system'
              ? t('settings.current', { value: t(`settings.language.${language}`) })
              : undefined
          }
        >
          {(_labelId, descriptionId) => (
            <SegmentedControl<LanguageSetting>
              ref={describedBy(descriptionId)}
              label={t('settings.language.label')}
              value={settings.language}
              onValueChange={(language) => update({ language })}
              options={[
                { value: 'system', label: t('settings.language.system') },
                // Sprachnamen in ihrer eigenen Sprache – Screenreader lesen sie richtig vor.
                { value: 'de', label: <span lang="de">{t('settings.language.de')}</span> },
                { value: 'en', label: <span lang="en">{t('settings.language.en')}</span> },
              ]}
            />
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.theme.label')}
          description={t('settings.theme.description')}
          hint={
            settings.theme === 'system'
              ? t('settings.current', { value: t(`settings.theme.${systemScheme}`) })
              : undefined
          }
        >
          {(_labelId, descriptionId) => (
            <SegmentedControl<ThemeSetting>
              ref={describedBy(descriptionId)}
              label={t('settings.theme.label')}
              value={settings.theme}
              onValueChange={(theme) => update({ theme })}
              options={[
                { value: 'system', label: t('settings.theme.system') },
                { value: 'dark', label: t('settings.theme.dark'), icon: <IconMoon /> },
                { value: 'light', label: t('settings.theme.light'), icon: <IconSun /> },
              ]}
            />
          )}
        </SettingRow>
      </Panel>

      <Panel title={t('settings.sections.feedback')} padding="none" data-testid="settings-feedback">
        <SettingRow label={t('settings.sound.label')} description={t('settings.sound.description')}>
          {(labelId, descriptionId) => (
            <Toggle
              checked={settings.sound}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              onCheckedChange={(sound) => {
                update({ sound });
                if (sound) {
                  // Hörbare Bestätigung (läuft in der Klick-Geste, daher erlaubt).
                  getUiSound().click();
                }
              }}
              data-testid="setting-sound"
            />
          )}
        </SettingRow>
        <SettingRow
          label={t('settings.motion.label')}
          description={t('settings.motion.description')}
          hint={
            settings.motion === 'system'
              ? systemReduced
                ? t('settings.motion.systemReduced')
                : t('settings.motion.systemNormal')
              : undefined
          }
        >
          {(_labelId, descriptionId) => (
            <SegmentedControl<MotionSetting>
              ref={describedBy(descriptionId)}
              label={t('settings.motion.label')}
              value={settings.motion}
              onValueChange={(motion) => update({ motion })}
              options={[
                { value: 'system', label: t('settings.motion.system') },
                { value: 'reduced', label: t('settings.motion.reduced') },
              ]}
            />
          )}
        </SettingRow>
      </Panel>

      <Panel title={t('settings.sections.window')} padding="none" data-testid="settings-window">
        <SettingRow label={t('settings.boot.label')} description={t('settings.boot.description')}>
          {(labelId, descriptionId) => (
            <Toggle
              checked={settings.bootAnimation}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              onCheckedChange={(bootAnimation) => update({ bootAnimation })}
              data-testid="setting-boot"
            />
          )}
        </SettingRow>
        {platform.window !== null && (
          <SettingRow
            label={t('settings.closeToTray.label')}
            description={
              trayMissing
                ? t('settings.closeToTray.unavailable')
                : t('settings.closeToTray.description')
            }
          >
            {(labelId, descriptionId) => (
              <Toggle
                checked={settings.closeToTray && !trayMissing}
                disabled={trayMissing}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                onCheckedChange={(closeToTray) => update({ closeToTray })}
                data-testid="setting-close-to-tray"
              />
            )}
          </SettingRow>
        )}
      </Panel>

      <Panel title={t('settings.sections.about')} padding="none" data-testid="settings-about">
        <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-4">
          <p className="font-mono text-sm text-text-muted">
            {appInfo.status === 'ready'
              ? t('settings.about.version', { version: appInfo.info.version })
              : appInfo.status === 'error'
                ? t('about.error')
                : t('about.loading')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            iconEnd={<IconArrowRight />}
            onClick={() => router.navigate('about')}
          >
            {t('settings.about.more')}
          </Button>
        </div>
      </Panel>
    </PageBody>
  );
}

/**
 * Verknüpft die Erklärung einer Zeile mit der Radiogruppe von `SegmentedControl` (die
 * Komponente reicht `aria-describedby` nicht durch): Screenreader hören beim Ansteuern auch
 * „„Reduziert“ schaltet Animationen … ab“ und den aufgelösten Wert („System: reduziert“).
 */
function describedBy(descriptionId: string) {
  return (element: HTMLDivElement | null): void => {
    element?.setAttribute('aria-describedby', descriptionId);
  };
}

interface SettingRowProps {
  readonly label: string;
  readonly description: string;
  /** Zusatz wie „Gerade: Dunkel“ (aufgelöste System-Einstellung). */
  readonly hint?: string | undefined;
  /** Bedienelement; bekommt die IDs von Beschriftung und Beschreibung. */
  readonly children: (labelId: string, descriptionId: string) => ReactNode;
}

/** Zeile: Beschriftung + Erklärung links, Bedienelement rechts. */
function SettingRow({ label, description, hint, children }: SettingRowProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <div className="flex items-center justify-between gap-8 border-t border-border px-5 py-4">
      <div className="min-w-0">
        <p id={labelId} className="text-sm font-medium text-text">
          {label}
        </p>
        <p id={descriptionId} className="mt-0.5 max-w-lg text-xs text-text-muted">
          {description}
          {hint !== undefined && (
            // Echtes Leerzeichen davor: sonst liest die Beschreibung „…Windows.Gerade: Deutsch“.
            <>
              {' '}
              <span className="mt-1 block font-mono text-2xs tracking-wide text-text-subtle">
                {hint}
              </span>
            </>
          )}
        </p>
      </div>
      <div className="shrink-0">{children(labelId, descriptionId)}</div>
    </div>
  );
}
