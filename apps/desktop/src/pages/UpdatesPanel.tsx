/**
 * Software-Updates (P6.5): fragt auf Knopfdruck winget nach neueren Versionen installierter
 * Programme (braucht Netz). Aktualisieren ist je Paket ein Vorschlag mit Plan und „Ja“ –
 * installiert wird genau die angezeigte Version.
 */
import { Button, IconRefresh, Panel, SafeText } from '@aegis/ui';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { Proposal, ServiceApi, UpdatesState } from '../platform/service.ts';

export function UpdatesPanel({
  service,
  start,
  version,
}: {
  readonly service: ServiceApi;
  readonly start: (load: () => Promise<Proposal>) => void;
  readonly version: number;
}) {
  const { t } = useT();
  const [state, setState] = useState<UpdatesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const load = async () => {
    setBusy(true);
    try {
      setState(await service.softwareUpdates());
      setError(null);
      loaded.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Nach einem Update ist die Liste veraltet – die Anzeige wird geleert, neu suchen per Knopf.
  useEffect(() => {
    if (version !== 0 && loaded.current) {
      setState(null);
    }
  }, [version]);

  return (
    <Panel
      title={t('updates.title')}
      description={t('updates.intro')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          iconStart={<IconRefresh />}
          onClick={() => void load()}
        >
          {state === null ? t('updates.check') : t('updates.recheck')}
        </Button>
      }
    >
      <div className="space-y-3" data-testid="updates-panel">
        {error !== null && (
          <p className="text-sm text-danger">
            <SafeText value={error} />
          </p>
        )}
        {state === null && !busy && (
          <p className="text-sm text-text-muted">{t('updates.notYet')}</p>
        )}
        {state !== null && !state.available && (
          <p className="text-sm text-text-muted">{t('updates.windowsOnly')}</p>
        )}
        {state !== null && state.available && state.error !== null && (
          <p className="text-sm text-danger">
            <SafeText value={state.error} />
          </p>
        )}
        {state !== null && state.available && state.error === null && (
          <>
            {state.packages.length === 0 ? (
              <p className="text-sm text-text-muted">{t('updates.none')}</p>
            ) : (
              <ul className="space-y-2" data-testid="updates-list">
                {state.packages.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-2 p-3"
                    data-testid="update-entry"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-text">
                        <SafeText value={p.name} />
                      </p>
                      <p className="text-xs text-text-muted tabular-nums">
                        <SafeText value={`${p.id} · ${p.version} → ${p.available}`} mono breakAll />
                      </p>
                    </div>
                    {p.truncated ? (
                      <span className="text-xs text-text-subtle">{t('updates.truncated')}</span>
                    ) : (
                      <Button
                        size="sm"
                        disabled={!state.admin}
                        onClick={() => start(() => service.proposeSoftwareUpdate(p.id))}
                      >
                        {t('updates.update')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!state.admin && state.packages.length > 0 && (
              <p className="text-xs text-text-subtle">{t('hardening.adminOnly')}</p>
            )}
            <p className="text-xs text-text-subtle">{t('updates.honest')}</p>
          </>
        )}
      </div>
    </Panel>
  );
}
