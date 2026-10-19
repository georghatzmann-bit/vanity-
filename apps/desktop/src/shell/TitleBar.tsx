import {
  AegisLogo,
  AegisWordmark,
  IconClose,
  IconGlobe,
  IconMaximize,
  IconMinimize,
  IconRestore,
  IconSearch,
  Kbd,
  cx,
} from '@aegis/ui';
import type { ReactNode } from 'react';
import { useServices, useSettingsSnapshot } from '../app/services.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import { useWindowMaximized } from '../platform/PlatformContext.tsx';
import { reportPlatformError, type WindowApi } from '../platform/platform.ts';
import { modifierKeys } from './shortcuts.ts';

export interface TitleBarProps {
  readonly onOpenPalette: () => void;
}

/**
 * Eigene Titelleiste des rahmenlosen Fensters. In der Desktop-App ist die ganze Leiste eine
 * Zieh-Fläche (`data-tauri-drag-region="deep"`, Knöpfe ausgenommen); Tauri maximiert dort
 * auch per Doppelklick (`internal_toggle_maximize`). In der Browser-Vorschau gibt es keine
 * Fensterknöpfe – stattdessen ein ehrliches „Browser-Vorschau“.
 */
export function TitleBar({ onOpenPalette }: TitleBarProps) {
  const { platform } = useServices();
  const { t } = useT();
  const windowApi = platform.window;
  const dragRegion = windowApi === null ? {} : { 'data-tauri-drag-region': 'deep' };

  return (
    <header
      aria-label={t('titlebar.label')}
      className="relative z-20 flex h-11 shrink-0 items-center border-b border-border bg-bg select-none"
      data-testid="titlebar"
      {...dragRegion}
    >
      <div className="flex w-60 shrink-0 items-center gap-2.5 pl-4 text-text">
        <AegisLogo size={20} decorative />
        <AegisWordmark height={10} decorative />
        <span className="sr-only">{t('app.suite')}</span>
      </div>

      <div className="flex min-w-0 flex-1 justify-center px-4">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-keyshortcuts="Control+K Meta+K"
          className="group flex h-7 w-full max-w-md min-w-0 items-center gap-2.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs text-text-subtle shadow-bevel transition-colors duration-150 hover:border-border-strong hover:text-text-muted"
          data-testid="palette-trigger"
        >
          <IconSearch size={14} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{t('titlebar.search')}</span>
          <Kbd keys={modifierKeys(t, 'K')} size="sm" aria-hidden="true" />
        </button>
      </div>

      <div className="flex h-full w-60 shrink-0 items-stretch justify-end">
        {windowApi === null ? <PreviewBadge /> : <WindowControls windowApi={windowApi} />}
      </div>
    </header>
  );
}

function PreviewBadge() {
  const { t } = useT();
  return (
    <p
      className="mr-4 flex items-center gap-1.5 self-center rounded-full border border-border bg-surface-1 px-2.5 py-0.5 font-mono text-2xs tracking-wide text-text-muted"
      data-testid="preview-badge"
    >
      <IconGlobe size={12} aria-hidden="true" />
      {t('titlebar.preview')}
      <span className="sr-only">. {t('titlebar.previewHint')}</span>
    </p>
  );
}

function WindowControls({ windowApi }: { readonly windowApi: WindowApi }) {
  const { t } = useT();
  const { settings } = useSettingsSnapshot();
  const maximized = useWindowMaximized(windowApi);

  const run = (action: string, command: () => Promise<void>) => () => {
    command().catch((error: unknown) => reportPlatformError(action, error));
  };

  return (
    <div role="group" aria-label={t('titlebar.windowControls')} className="flex h-full">
      <WindowButton
        label={t('titlebar.minimize')}
        onClick={run('minimize', () => windowApi.minimize())}
        testId="window-minimize"
      >
        <IconMinimize size={16} />
      </WindowButton>
      <WindowButton
        label={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
        onClick={run('toggleMaximize', () => windowApi.toggleMaximize())}
        testId="window-maximize"
      >
        {maximized ? <IconRestore size={16} /> : <IconMaximize size={16} />}
      </WindowButton>
      <WindowButton
        label={settings.closeToTray ? t('titlebar.closeToTray') : t('titlebar.close')}
        onClick={
          settings.closeToTray
            ? run('hide', () => windowApi.hide())
            : run('close', () => windowApi.close())
        }
        tone="danger"
        testId="window-close"
      >
        <IconClose size={16} />
      </WindowButton>
    </div>
  );
}

interface WindowButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly tone?: 'danger' | undefined;
  readonly testId: string;
  readonly children: ReactNode;
}

function WindowButton({ label, onClick, tone, testId, children }: WindowButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      // Natives Hinweisfenster wie bei den Fensterknöpfen von Windows (gleich dem Namen, daher
      // keine doppelte Ansage).
      title={label}
      onClick={onClick}
      className={cx(
        'grid h-full w-12 place-items-center text-text-muted transition-colors duration-150 focus-visible:-outline-offset-2',
        tone === 'danger'
          ? 'hover:bg-danger hover:text-bg active:bg-danger/85'
          : 'hover:bg-surface-2 hover:text-text active:bg-surface-3',
      )}
      data-testid={testId}
    >
      <span aria-hidden="true" className="inline-flex">
        {children}
      </span>
    </button>
  );
}
