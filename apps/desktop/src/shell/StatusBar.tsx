import { IconShield } from '@aegis/ui';
import { useT } from '../i18n/I18nProvider.tsx';
import { useAppInfo } from '../platform/PlatformContext.tsx';

/** Schmale Statuszeile: Goldene Regel links, Version und Laufzeit rechts. */
export function StatusBar() {
  const { t } = useT();
  const appInfo = useAppInfo();
  const info = appInfo.status === 'ready' ? appInfo.info : null;

  return (
    <footer
      aria-label={t('statusbar.label')}
      className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-border bg-bg px-4 text-2xs text-text-subtle"
      data-testid="statusbar"
    >
      <p className="flex min-w-0 items-center gap-1.5">
        <IconShield size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="truncate">{t('statusbar.golden')}</span>
      </p>
      {info !== null && (
        <p className="flex shrink-0 items-center gap-2 font-mono tracking-wide">
          <span>{info.source === 'tauri' ? t('statusbar.desktop') : t('statusbar.preview')}</span>
          <span aria-hidden="true" className="text-text-subtle">
            ·
          </span>
          <span>{t('statusbar.version', { version: info.version })}</span>
          <span aria-hidden="true" className="text-text-subtle">
            ·
          </span>
          <span>{t(`statusbar.build.${info.buildProfile}`)}</span>
        </p>
      )}
    </footer>
  );
}
