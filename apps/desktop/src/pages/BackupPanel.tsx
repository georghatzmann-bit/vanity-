/**
 * Rückfall-Kopien (optional): Ein-/Ausschalten, Zurückholen, Export und Ausdünnen sind
 * Vorschläge des Dienstes und passieren erst nach „Ja“ (Ausdünnen mit zweiter Bestätigung).
 */
import { Button, Panel, SafeText, SegmentedControl } from '@aegis/ui';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { BackupState, Proposal, ServiceApi } from '../platform/service.ts';

const QUOTAS = ['1024', '5120', '10240', '25600', '51200', '102400'] as const;
type Quota = (typeof QUOTAS)[number];

function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit] ?? 'B'}`;
}

export function BackupPanel({
  service,
  start,
  version,
}: {
  readonly service: ServiceApi;
  readonly start: (load: () => Promise<Proposal>) => void;
  readonly version: number;
}) {
  const { t, locale } = useT();
  const platform = usePlatform();
  const [state, setState] = useState<BackupState | null>(null);
  const [quota, setQuota] = useState<Quota>('10240');

  useEffect(() => {
    let active = true;
    service.backupStatus().then(
      (s) => {
        if (active) {
          setState(s);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [service, version]);

  const exportTo = async () => {
    if (platform.pickPaths === null) {
      return;
    }
    const picked = await platform.pickPaths('folder');
    const folder = picked[0];
    if (folder !== undefined) {
      start(() => service.proposeBackupExport(folder));
    }
  };

  if (state !== null && !state.available) {
    return (
      <Panel title={t('backup.title')} description={t('backup.intro')}>
        <p className="text-sm text-text-muted">{t('backup.unavailable')}</p>
      </Panel>
    );
  }
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
  };
  return (
    <Panel title={t('backup.title')} description={t('backup.intro')}>
      <div className="space-y-3" data-testid="backup-panel">
        <p className="text-sm text-text">
          {state?.enabled === true
            ? t('backup.on', { quota: String(Math.round(state.quotaMb / 1024)) })
            : t('backup.off')}
        </p>
        {state !== null && state.versions > 0 && (
          <p className="text-sm text-text-muted tabular-nums">
            {t('backup.usage', {
              files: String(state.files),
              versions: String(state.versions),
              size: formatBytes(state.bytes, locale),
            })}
          </p>
        )}
        {state?.lastRun !== null && state?.lastRun !== undefined && (
          <p className="text-xs text-text-subtle">
            {t('backup.lastRun', { date: date(state.lastRun) })}
            {state.note !== null && (
              <>
                {' · '}
                <SafeText value={state.note} />
              </>
            )}
          </p>
        )}
        {state?.enabled !== true ? (
          <div className="space-y-2">
            <SegmentedControl<Quota>
              label={t('backup.quota')}
              size="sm"
              value={quota}
              onValueChange={setQuota}
              options={QUOTAS.map((q) => ({
                value: q,
                label: `${String(Number(q) / 1024)} GiB`,
              }))}
            />
            <Button
              size="sm"
              onClick={() => start(() => service.proposeBackup(true, Number(quota)))}
            >
              {t('backup.enable')}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => start(() => service.proposeBackup(false, 0))}
          >
            {t('backup.disable')}
          </Button>
        )}
        {state !== null && state.versions > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={platform.pickPaths === null}
                onClick={() => void exportTo()}
              >
                {t('backup.export')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => start(() => service.proposeBackupPrune(90))}
              >
                {t('backup.prune', { days: '90' })}
              </Button>
            </div>
            <p className="text-xs text-text-subtle">
              {t('backup.exportHint')} {t('backup.pruneHint')}
            </p>
            <h3 className="text-sm font-medium text-text">{t('backup.recent')}</h3>
            <ul className="space-y-2">
              {state.recent.slice(0, 20).map((v) => (
                <li
                  key={v.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2"
                  data-testid="backup-version"
                >
                  <span className="min-w-0 flex-1 text-sm text-text">
                    <SafeText value={v.original} mono breakAll />
                    <span className="block text-xs text-text-subtle">
                      {date(v.storedAt)} · {formatBytes(v.size, locale)}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      start(() => service.proposeBackupRestore(v.id));
                    }}
                  >
                    {t('backup.restore')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {state === null && <p className="text-sm text-text-muted">…</p>}
      </div>
    </Panel>
  );
}
