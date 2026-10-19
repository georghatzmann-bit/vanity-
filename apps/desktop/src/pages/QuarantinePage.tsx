/**
 * Quarantäne: verschlüsselt isolierte Dateien anzeigen, wiederherstellen oder endgültig
 * löschen – beides nur als Vorschlag des Dienstes und erst nach Bestätigung (Löschen: zweimal).
 */
import { Button, IconRefresh, IconTrash, IconUndo, Panel, SafeText, useToast } from '@aegis/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { QuarantineEntry, TrustEntry } from '../platform/service.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

export function QuarantinePage() {
  const { t, locale } = useT();
  const service = usePlatform().service;
  const toast = useToast();
  const [entries, setEntries] = useState<readonly QuarantineEntry[] | null>(null);
  const [trusted, setTrusted] = useState<readonly TrustEntry[] | null>(null);
  const [down, setDown] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (service === null) {
      return;
    }
    try {
      const [list, trust] = await Promise.all([service.listQuarantine(), service.listTrust()]);
      setEntries(list);
      setTrusted(trust);
      setDown(null);
    } catch (error) {
      setDown(error instanceof Error ? error.message : String(error));
    }
  }, [service]);

  useEffect(() => {
    if (service === null) {
      return;
    }
    let active = true;
    Promise.all([service.listQuarantine(), service.listTrust()]).then(
      ([list, trust]) => {
        if (active) {
          setEntries(list);
          setTrusted(trust);
          setDown(null);
        }
      },
      (error: unknown) => {
        if (active) {
          setDown(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [service]);

  const flow = useConsentFlow(service, () => void load());
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
  };

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.quarantine.eyebrow')}
        title={t('pages.quarantine.title')}
        description={t('vault.intro')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : (
        <>
          <Panel
            title={t('pages.quarantine.tagline')}
            description={t('vault.never')}
            actions={
              <Button
                size="sm"
                variant="ghost"
                iconStart={<IconRefresh />}
                onClick={() => void load()}
              >
                {t('vault.refresh')}
              </Button>
            }
          >
            {down !== null && <ServiceNotice kind="down" detail={down} />}
            {entries !== null && entries.length === 0 && (
              <p className="text-sm text-text-muted" data-testid="vault-empty">
                {t('vault.empty')}
              </p>
            )}
            {entries !== null && entries.length > 0 && (
              <ul className="space-y-3">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    className="rounded-xl border border-border bg-surface-2 p-4"
                    data-testid="vault-entry"
                  >
                    <p className="text-sm text-text">
                      <SafeText value={e.originalPath} mono breakAll />
                    </p>
                    <p className="mt-1 text-xs text-text-subtle">
                      {t('vault.isolatedAt', { date: date(e.quarantinedAt) })}
                    </p>
                    <p className="mt-1 text-sm text-text-muted">
                      <SafeText value={e.reason} />
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        iconStart={<IconUndo />}
                        onClick={() => void flow.start(() => service.proposeRestore(e.id))}
                      >
                        {t('vault.restore')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        iconStart={<IconTrash />}
                        onClick={() => void flow.start(() => service.proposeDelete(e.id))}
                      >
                        {t('vault.delete')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={t('trust.title')} description={t('trust.intro')}>
            {trusted !== null && trusted.length === 0 && (
              <p className="text-sm text-text-muted" data-testid="trust-empty">
                {t('trust.empty')}
              </p>
            )}
            {trusted !== null && trusted.length > 0 && (
              <ul className="space-y-3">
                {trusted.map((e) => (
                  <li
                    key={e.id}
                    className="rounded-xl border border-border bg-surface-2 p-4"
                    data-testid="trust-entry"
                  >
                    <p className="text-sm text-text">
                      <SafeText value={e.path} mono breakAll />
                    </p>
                    <p className="mt-1 text-xs text-text-subtle">
                      {t('trust.since', { date: date(e.createdAt) })}
                    </p>
                    <p className="mt-1 text-sm text-text-muted">
                      <SafeText value={e.reason} />
                    </p>
                    <div className="mt-3">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void service.revokeTrust(e.id).then(
                            () => {
                              toast.show({ tone: 'success', title: t('trust.revoked') });
                              void load();
                            },
                            (error: unknown) => {
                              setDown(error instanceof Error ? error.message : String(error));
                            },
                          )
                        }
                      >
                        {t('trust.revoke')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {flow.dialogs}
        </>
      )}
    </PageBody>
  );
}
