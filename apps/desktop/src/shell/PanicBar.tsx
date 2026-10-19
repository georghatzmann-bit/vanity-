/**
 * Hinweisleiste, solange der Panic-Button das Netz getrennt hat – mit „Wieder verbinden …“
 * (eigener Plan, nur nach „Ja“). Ohne Dienst (Vorschau) erscheint nichts.
 */
import { Button } from '@aegis/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import { useConsentFlow } from '../pages/useConsentFlow.tsx';

/** Abfrage-Abstand. */
export const PANIC_POLL_MS = 10_000;

export function PanicBar() {
  const { t, locale } = useT();
  const service = usePlatform().service;
  const [since, setSince] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (service === null) {
      return;
    }
    service.panicStatus().then(
      (s) => setSince(s.since),
      () => undefined,
    );
  }, [service]);

  useEffect(() => {
    if (service === null) {
      return undefined;
    }
    refresh();
    const timer = window.setInterval(refresh, PANIC_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, service]);

  const flow = useConsentFlow(service, refresh);
  if (service === null) {
    return null;
  }
  const when = since === null ? null : new Date(since);
  return (
    <>
      {since !== null && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 border-b border-border bg-danger/15 px-4 py-2 text-sm text-text"
          data-testid="panic-bar"
        >
          <span className="font-semibold">{t('panic.active')}</span>
          <span className="text-text-muted">
            {t('panic.since', {
              time:
                when === null || Number.isNaN(when.getTime()) ? since : when.toLocaleString(locale),
            })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void flow.start(() => service.proposePanic(false))}
          >
            {t('panic.reconnect')}
          </Button>
        </div>
      )}
      {flow.dialogs}
    </>
  );
}
