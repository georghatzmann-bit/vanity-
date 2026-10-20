/**
 * Updates (P13): Suche nur auf Klick; geladen wird nur ein mit dem eingebauten Schlüssel
 * signiertes Update, geprüft gegen SHA-256 und Größe. Installiert wird erst nach
 * „Jetzt installieren“ (Windows fragt dann nach Administratorrechten).
 */
import { Button, Dialog, IconRefresh, Panel, SafeText } from '@aegis/ui';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { UpdatesApi, UpdateView } from '../platform/updates.ts';

export function UpdatePanel({ updates }: { readonly updates: UpdatesApi }) {
  const { t } = useT();
  const [view, setView] = useState<UpdateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    let active = true;
    updates.status().then(
      (v) => active && setView(v),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [updates]);

  const run = (action: () => Promise<UpdateView>) => {
    setBusy(true);
    setError(null);
    action().then(
      (v) => {
        setView(v);
        setBusy(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };

  return (
    <Panel
      title={t('updater.title')}
      description={t('updater.intro')}
      data-testid="update-panel"
      actions={
        view?.enabled ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            iconStart={<IconRefresh />}
            onClick={() => run(() => updates.check())}
          >
            {t('updater.check')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3 text-sm">
        {view !== null && !view.enabled && (
          <p className="text-text-muted">{t('updater.disabled')}</p>
        )}
        {error !== null && (
          <p role="alert" className="text-danger">
            <SafeText value={error} />
          </p>
        )}
        {view?.latest != null && !view.newer && (
          <p className="text-success">{t('updater.upToDate', { version: view.current })}</p>
        )}
        {view?.latest != null && view.newer && (
          <div className="space-y-2">
            <p className="font-medium text-text">
              {t('updater.available', { version: view.latest, current: view.current })}
            </p>
            {view.notes !== '' && (
              <p className="whitespace-pre-line text-text-muted">
                <SafeText value={view.notes} />
              </p>
            )}
            {view.ready ? (
              <Button variant="primary" onClick={() => setConfirm(true)}>
                {t('updater.install')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                loading={busy}
                onClick={() => run(() => updates.download())}
              >
                {t('updater.download')}
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-text-subtle">{t('updater.honest')}</p>
      </div>
      <Dialog
        open={confirm}
        title={t('updater.confirmTitle')}
        description={t('updater.confirmText')}
        onClose={() => setConfirm(false)}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t('updater.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirm(false);
                updates
                  .install()
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
              }}
            >
              {t('updater.installNow')}
            </Button>
          </div>
        }
      />
    </Panel>
  );
}
