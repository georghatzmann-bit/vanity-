/**
 * Persistenz-Check (P6.3): Autostart-Einträge des PCs und des eigenen Kontos, bewertet vom
 * Dienst (Merkmale im Befehl + Prüfung der Programmdatei). Deaktivieren ist ein Vorschlag mit
 * Plan und „Ja“; Dateien im Autostart-Ordner werden über die Quarantäne isoliert.
 */
import { Button, IconRefresh, Panel, RiskBadge, SafeText, SegmentedControl } from '@aegis/ui';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type {
  AutorunEntry,
  AutorunKind,
  PersistenceState,
  Proposal,
  ServiceApi,
} from '../platform/service.ts';

/** Arten, die immer gezeigt werden (Dienste, Aufgaben, COM nur wenn auffällig). */
const alwaysShown: ReadonlySet<AutorunKind> = new Set([
  'run',
  'run_once',
  'policy_run',
  'startup_folder',
  'winlogon',
  'ifeo',
  'app_init',
  'wmi_consumer',
  'browser_extension',
]);

type Filter = 'notable' | 'all';

function notable(e: AutorunEntry): boolean {
  return alwaysShown.has(e.kind) || (e.risk !== 'clean' && e.risk !== 'info') || e.missing;
}

export function PersistencePanel({
  service,
  start,
  version,
}: {
  readonly service: ServiceApi;
  readonly start: (load: () => Promise<Proposal>) => void;
  readonly version: number;
}) {
  const { t, language } = useT();
  const [state, setState] = useState<PersistenceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('notable');
  const loaded = useRef(false);

  const load = async () => {
    setBusy(true);
    try {
      setState(await service.persistenceStatus());
      setError(null);
      loaded.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Nach einer Ausführung (Version ändert sich) neu prüfen – aber nur, wenn schon geprüft wurde.
  useEffect(() => {
    if (version === 0 || !loaded.current) {
      return undefined;
    }
    let active = true;
    service.persistenceStatus().then(
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

  const shown = state?.entries.filter((e) => filter === 'all' || notable(e)) ?? [];

  return (
    <Panel
      title={t('persistence.title')}
      description={t('persistence.intro')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          iconStart={<IconRefresh />}
          onClick={() => void load()}
        >
          {state === null ? t('persistence.check') : t('persistence.recheck')}
        </Button>
      }
    >
      <div className="space-y-3" data-testid="persistence-panel">
        {error !== null && (
          <p className="text-sm text-danger">
            <SafeText value={error} />
          </p>
        )}
        {state === null && !busy && (
          <p className="text-sm text-text-muted">{t('persistence.notYet')}</p>
        )}
        {state !== null && !state.available && (
          <p className="text-sm text-text-muted">{t('persistence.windowsOnly')}</p>
        )}
        {state !== null && state.available && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl<Filter>
                label={t('persistence.filter')}
                size="sm"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: 'notable', label: t('persistence.notable') },
                  {
                    value: 'all',
                    label: t('persistence.all', { count: String(state.entries.length) }),
                  },
                ]}
              />
              <span className="text-xs text-text-subtle tabular-nums">
                {t('persistence.filesChecked', { count: String(state.filesChecked) })}
              </span>
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-text-muted">{t('persistence.empty')}</p>
            ) : (
              <ul className="space-y-2" data-testid="persistence-entries">
                {shown.slice(0, 300).map((e) => {
                  const machineOnly = e.machine && !state.admin;
                  return (
                    <li
                      key={e.id}
                      className="rounded-xl border border-border bg-surface-2 p-3"
                      data-testid="persistence-entry"
                      data-kind={e.kind}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-sm font-semibold text-text">
                          <SafeText value={e.name} />
                        </span>
                        <span className="text-xs text-text-subtle">
                          {t(`persistence.kinds.${e.kind}`)}
                          {e.enabled ? '' : ` · ${t('persistence.disabled')}`}
                        </span>
                        <RiskBadge level={e.risk} size="sm" />
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        <SafeText value={e.command} mono breakAll />
                      </p>
                      {e.reasons.length > 0 && (
                        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-text-muted">
                          {e.reasons.map((r) => (
                            <li key={r.de}>
                              <SafeText value={language === 'en' ? r.en : r.de} />
                            </li>
                          ))}
                        </ul>
                      )}
                      {e.action === 'disable' && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={machineOnly}
                            onClick={() => start(() => service.proposeAutorunDisable(e.id))}
                          >
                            {t('persistence.disable')}
                          </Button>
                          {machineOnly && (
                            <span className="text-xs text-text-subtle">
                              {t('hardening.adminOnly')}
                            </span>
                          )}
                        </div>
                      )}
                      {e.action === 'quarantine' && e.file !== null && (
                        <div className="mt-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              const file = e.file;
                              if (file !== null) {
                                start(() => service.proposeQuarantine([file]));
                              }
                            }}
                          >
                            {t('persistence.quarantine')}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
