/**
 * Echtzeit-Wächter: Meldungen des Dienstes anzeigen. Der Wächter **meldet nur** – Isolieren
 * und Vertrauen laufen ausschließlich über den Freigabe-Dialog des Dienstes; „Ignorieren“
 * blendet die Meldung nur in dieser Sitzung aus. Gaming-Modus pausiert Prüfungen und
 * Hinweise (endet spätestens nach 4 Stunden von selbst).
 */
import { Button, Panel, RiskBadge, SafeText, Toggle } from '@aegis/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { WatchEvent, WatchState } from '../platform/service.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

/** Abfrage-Abstand. */
export const WATCH_POLL_MS = 3000;

/** In dieser Sitzung ignorierte Meldungen (nur Anzeige – der Dienst merkt sich nichts). */
const ignored = new Set<number>();

function EventRow({
  event,
  onIsolate,
  onTrust,
  onIgnore,
}: {
  readonly event: WatchEvent;
  readonly onIsolate: () => void;
  readonly onTrust: () => void;
  readonly onIgnore: () => void;
}) {
  const { t, language, locale } = useT();
  const [open, setOpen] = useState(false);
  const f = event.finding;
  const when = new Date(event.at);
  return (
    <li className="rounded-xl border border-border bg-surface-2 p-4" data-testid="watch-event">
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge level={f.risk} />
        <span className="text-xs text-text-subtle">
          {event.kind === 'process' ? t('realtime.kindProcess') : t('realtime.kindFile')}
          {' · '}
          {Number.isNaN(when.getTime()) ? event.at : when.toLocaleString(locale)}
        </span>
      </div>
      <p className="mt-2 text-sm text-text">
        <SafeText value={event.path} mono breakAll />
      </p>
      <p className="mt-1 text-sm text-text-muted">
        {language === 'en' ? f.summaryEn : f.summaryDe}
      </p>
      {event.kind === 'process' && (
        <p className="mt-1 text-xs text-text-subtle">{t('realtime.processNote')}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={f.risk === 'dangerous' ? 'danger' : 'secondary'}
          onClick={onIsolate}
        >
          {t('realtime.isolate')}
        </Button>
        <Button size="sm" variant="secondary" onClick={onTrust}>
          {t('realtime.trust')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onIgnore}>
          {t('realtime.ignore')}
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t('realtime.more')}
        </Button>
      </div>
      {open && (
        <ul
          className="mt-3 list-disc space-y-1 pl-5 text-sm text-text-muted"
          data-testid="watch-reasons"
        >
          {f.reasons.map((r, i) => (
            <li key={`${r.code}-${String(i)}`}>
              <SafeText value={language === 'en' ? r.en : r.de} />
            </li>
          ))}
          {f.sha256 !== null && (
            <li>
              SHA-256: <SafeText value={f.sha256} mono breakAll />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function RealtimePage() {
  const { t } = useT();
  const service = usePlatform().service;
  const [state, setState] = useState<WatchState | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [, setIgnoredCount] = useState(ignored.size);

  const refresh = useCallback(async () => {
    if (service === null) {
      return;
    }
    try {
      setState(await service.watchPoll(0));
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
    const tick = () => {
      service.watchPoll(0).then(
        (s) => {
          if (active) {
            setState(s);
            setDown(null);
          }
        },
        (error: unknown) => {
          if (active) {
            setDown(error instanceof Error ? error.message : String(error));
          }
        },
      );
    };
    tick();
    const timer = window.setInterval(tick, WATCH_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [service]);

  const flow = useConsentFlow(service, () => void refresh());

  const setGaming = (on: boolean) => {
    if (service === null) {
      return;
    }
    service.setGaming(on).then(setState, (error: unknown) => {
      setDown(error instanceof Error ? error.message : String(error));
    });
  };

  const events = (state?.events ?? []).filter((e) => !ignored.has(e.seq)).reverse();
  const minutesLeft = state?.gamingLeft == null ? null : Math.ceil(state.gamingLeft / 60);

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.realtime.eyebrow')}
        title={t('pages.realtime.title')}
        description={t('realtime.intro')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : (
        <>
          <Panel title={t('realtime.status')} description={t('realtime.honest')}>
            {down !== null && <ServiceNotice kind="down" detail={down} />}
            {state !== null && (
              <div className="space-y-3" data-testid="watch-status">
                <p className="text-sm text-text" data-state={state.active ? 'on' : 'off'}>
                  {state.active ? t('realtime.active') : t('realtime.inactive')}
                </p>
                <p className="text-sm text-text-muted">
                  {t('realtime.folders', { count: String(state.folders.length) })}
                  {' · '}
                  {state.processes ? t('realtime.processesOn') : t('realtime.processesOff')}
                </p>
                {state.note !== null && (
                  <p className="text-xs text-warn">
                    <SafeText value={state.note} />
                  </p>
                )}
                {state.dropped > 0 && (
                  <p className="text-xs text-warn">
                    {t('realtime.dropped', { count: String(state.dropped) })}
                  </p>
                )}
                <Toggle
                  checked={state.gaming}
                  onCheckedChange={setGaming}
                  label={t('realtime.gaming')}
                  description={
                    state.gaming && minutesLeft !== null
                      ? t('realtime.gamingLeft', { minutes: String(minutesLeft) })
                      : t('realtime.gamingHint')
                  }
                />
              </div>
            )}
          </Panel>
          <Panel title={t('realtime.events')} description={t('realtime.eventsHint')}>
            {state !== null && events.length === 0 && (
              <p className="text-sm text-text-muted" data-testid="watch-empty">
                {t('realtime.none')}
              </p>
            )}
            {events.length > 0 && (
              <ul className="space-y-3">
                {events.map((e) => (
                  <EventRow
                    key={e.seq}
                    event={e}
                    onIsolate={() => void flow.start(() => service.proposeQuarantine([e.path]))}
                    onTrust={() => void flow.start(() => service.proposeQuarantine([e.path]))}
                    onIgnore={() => {
                      ignored.add(e.seq);
                      setIgnoredCount(ignored.size);
                    }}
                  />
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
