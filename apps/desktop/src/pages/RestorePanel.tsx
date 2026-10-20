/**
 * Wiederherstellungspunkte (Werkzeug 17, P11): vorhandene Punkte von Windows zeigen und vor
 * Änderungen einen neuen Punkt anbieten. Angelegt wird erst nach dem „Ja“ im Freigabe-Dialog
 * des Dienstes; AEGIS löscht und spielt keine Punkte zurück – das bleibt bei Windows.
 */
import { Button, IconRefresh, Panel, SafeText } from '@aegis/ui';
import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { Proposal, RestoreState, ServiceApi } from '../platform/service.ts';
import { inputClass } from './ToolsShared.tsx';

export function RestorePanel({
  service,
  start,
  version,
}: {
  readonly service: ServiceApi;
  readonly start: (load: () => Promise<Proposal>) => void;
  readonly version: number;
}) {
  const { t } = useT();
  const inputId = useId();
  const [state, setState] = useState<RestoreState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState(() => t('restore.defaultDescription'));

  const load = async () => {
    setBusy(true);
    try {
      setState(await service.restorePoints());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Nach einer Ausführung (auch nach einem neuen Punkt) die Liste frisch lesen.
  useEffect(() => {
    let active = true;
    service.restorePoints().then(
      (s) => {
        if (active) {
          setState(s);
          setError(null);
        }
      },
      (e: unknown) => {
        if (active) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [service, version]);

  const trimmed = description.trim();

  return (
    <Panel
      title={t('restore.title')}
      description={t('restore.intro')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          iconStart={<IconRefresh />}
          onClick={() => void load()}
        >
          {t('restore.reload')}
        </Button>
      }
    >
      <div className="space-y-3" data-testid="restore-panel" id="restore">
        {error !== null && (
          <p className="text-sm text-danger">
            <SafeText value={error} />
          </p>
        )}
        {state !== null && state.points === null && (
          <p className="text-sm text-text-muted">{t('restore.unavailable')}</p>
        )}
        {state !== null && state.points !== null && state.points.length === 0 && (
          <p className="text-sm text-text-muted">{t('restore.empty')}</p>
        )}
        {state !== null && state.points !== null && state.points.length > 0 && (
          <ul className="space-y-1 text-sm" data-testid="restore-list">
            {state.points.map((p) => (
              <li key={p.sequence} className="flex flex-wrap justify-between gap-x-3">
                <SafeText value={p.description || t('restore.unnamed')} />
                <span className="text-text-subtle">
                  <SafeText value={p.created} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm" htmlFor={inputId}>
            <span className="text-text-muted">{t('restore.description')}</span>
            <input
              id={inputId}
              className={inputClass}
              maxLength={64}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <Button
            variant="primary"
            disabled={trimmed === '' || state?.admin === false}
            onClick={() => start(() => service.proposeRestorePoint(trimmed))}
          >
            {t('restore.create')}
          </Button>
        </div>
        {state?.admin === false && (
          <p className="text-xs text-text-muted">{t('restore.adminOnly')}</p>
        )}
        <p className="text-xs text-text-muted">{t('restore.honest')}</p>
      </div>
    </Panel>
  );
}
