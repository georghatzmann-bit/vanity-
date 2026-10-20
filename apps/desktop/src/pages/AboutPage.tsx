import {
  AegisLogo,
  IconCheck,
  IconGlobe,
  IconInfo,
  IconLock,
  IconShield,
  Panel,
  Skeleton,
  type IconComponent,
} from '@aegis/ui';
import { useT } from '../i18n/I18nProvider.tsx';
import type { Translator } from '../i18n/translator.ts';
import type { AppInfo } from '../platform/appInfo.ts';
import { useAppInfo, usePlatform } from '../platform/PlatformContext.tsx';
import { UpdatePanel } from './UpdatePanel.tsx';
import { Blueprint, ViewfinderCorners } from './decor.tsx';
import { PageBody, PageHeader } from './PageHeader.tsx';

const principles: readonly {
  readonly key: 'golden' | 'defensive' | 'kernel' | 'privacy';
  readonly icon: IconComponent;
}[] = [
  { key: 'golden', icon: IconShield },
  { key: 'defensive', icon: IconLock },
  { key: 'kernel', icon: IconInfo },
  { key: 'privacy', icon: IconGlobe },
];

function platformName(t: Translator['t'], info: AppInfo): string {
  if (info.source === 'preview') {
    return t('about.platform.preview');
  }
  switch (info.os) {
    case 'windows':
      return t('about.platform.windows');
    case 'linux':
      return t('about.platform.linux');
    case 'macos':
      return t('about.platform.macos');
    default:
      return info.os ?? t('about.unknown');
  }
}

export function AboutPage() {
  const { t } = useT();
  const appInfo = useAppInfo();
  const { updates } = usePlatform();

  return (
    <PageBody width="narrow">
      <PageHeader
        eyebrow={t('pages.about.eyebrow')}
        title={t('pages.about.title')}
        description={t('pages.about.description')}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-5">
        <section
          aria-label={t('app.suite')}
          className="relative isolate flex flex-col items-center justify-center gap-5 overflow-hidden rounded-xl border border-border bg-surface-1 px-6 py-10 shadow-bevel"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-accent/60 to-transparent"
          />
          <Blueprint />
          <div className="relative grid place-items-center px-10 py-8">
            <ViewfinderCorners />
            <AegisLogo variant="full" size={44} decorative className="text-text" />
          </div>
          <p className="font-mono text-2xs tracking-caps text-text-subtle uppercase">
            {appInfo.status === 'ready'
              ? t('settings.about.version', { version: appInfo.info.version })
              : t('app.suite')}
          </p>
        </section>

        <Panel title={t('about.infoTitle')} padding="none" data-testid="about-info">
          {appInfo.status === 'loading' && (
            <div aria-busy="true" className="flex flex-col gap-3 border-t border-border px-5 py-4">
              <span className="sr-only">{t('about.loading')}</span>
              <Skeleton height={14} />
              <Skeleton height={14} width="70%" />
              <Skeleton height={14} width="80%" />
            </div>
          )}
          {appInfo.status === 'error' && (
            <p role="alert" className="border-t border-border px-5 py-4 text-sm text-danger">
              {t('about.error')}
            </p>
          )}
          {appInfo.status === 'ready' && <InfoTable info={appInfo.info} />}
        </Panel>
      </div>

      {updates !== null && <UpdatePanel updates={updates} />}

      <Panel title={t('about.principlesTitle')} data-testid="about-principles">
        <ul className="grid grid-cols-2 gap-x-8 gap-y-4">
          {principles.map(({ key, icon: Icon }) => (
            <li key={key} className="flex items-start gap-3 text-sm text-text-muted">
              <span
                aria-hidden="true"
                className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-accent"
              >
                <Icon size={14} strokeWidth={2} />
              </span>
              {t(`about.principles.${key}`)}
            </li>
          ))}
        </ul>
        <p className="mt-5 flex items-center gap-2 border-t border-border pt-4 text-xs text-text-subtle">
          <IconCheck size={14} aria-hidden="true" className="shrink-0" />
          {t('about.fonts')}
        </p>
      </Panel>
    </PageBody>
  );
}

function InfoTable({ info }: { readonly info: AppInfo }) {
  const { t } = useT();
  const unknown = t('about.unknown');
  const rows: readonly (readonly [string, string, boolean])[] = [
    [t('about.fields.version'), info.version, true],
    [t('about.fields.build'), t(`about.build.${info.buildProfile}`), false],
    [t('about.fields.platform'), platformName(t, info), false],
    [t('about.fields.osVersion'), info.osVersion ?? unknown, info.osVersion !== null],
    [t('about.fields.arch'), info.arch ?? unknown, info.arch !== null],
    [t('about.fields.tauri'), info.tauriVersion ?? unknown, info.tauriVersion !== null],
  ];
  return (
    <>
      {info.source === 'preview' && (
        <p
          className="flex items-start gap-2 border-t border-border bg-surface-2/50 px-5 py-2.5 text-xs text-text-muted"
          data-testid="about-preview-note"
        >
          <IconGlobe size={14} aria-hidden="true" className="mt-px shrink-0" />
          {t('about.previewNote')}
        </p>
      )}
      <dl className="divide-y divide-border border-t border-border">
        {rows.map(([label, value, mono]) => (
          <div
            key={label}
            className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-4 px-5 py-2.5"
          >
            <dt className="text-xs text-text-subtle">{label}</dt>
            <dd
              className={
                mono ? 'truncate font-mono text-xs text-text' : 'truncate text-xs text-text'
              }
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}
