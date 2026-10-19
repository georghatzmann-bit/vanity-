/**
 * Echtzeit-Wächter: Meldungen des Dienstes anzeigen. Der Wächter **meldet nur** – Isolieren
 * und Vertrauen laufen ausschließlich über den Freigabe-Dialog des Dienstes; „Ignorieren“
 * blendet die Meldung nur in dieser Sitzung aus. Gaming-Modus pausiert Prüfungen und
 * Hinweise (endet spätestens nach 4 Stunden von selbst).
 */
import { Button, Panel, RiskBadge, SafeText, Toggle, useToast } from '@aegis/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { RansomState, ServiceApi, WatchEvent, WatchState } from '../platform/service.ts';
import { BackupPanel } from './BackupPanel.tsx';
import { isLabCandidate, offerToLab } from './labCandidate.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

/** Abfrage-Abstand. */
export const WATCH_POLL_MS = 3000;

/** In dieser Sitzung ignorierte Meldungen (nur Anzeige – der Dienst merkt sich nichts). */
const ignored = new Set<number>();

/** Bezeichnung je Art der Meldung. */
const kindLabel = {
  file: 'realtime.kindFile',
  process: 'realtime.kindProcess',
  ransomware: 'realtime.kindRansomware',
  device: 'realtime.kindDevice',
  privacy: 'realtime.kindPrivacy',
} as const satisfies Record<WatchEvent['kind'], string>;

function EventRow({
  event,
  onIsolate,
  onTrust,
  onIgnore,
  onProcess,
  recent,
  onFreeze,
}: {
  readonly event: WatchEvent;
  readonly onIsolate: () => void;
  readonly onTrust: () => void;
  readonly onIgnore: () => void;
  readonly onProcess: (action: 'terminate' | 'suspend' | 'resume') => void;
  readonly recent: readonly string[];
  readonly onFreeze: (program: string) => void;
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
          {t(kindLabel[event.kind])}
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
      {event.kind === 'ransomware' && <RansomAlarm recent={recent} onFreeze={onFreeze} />}
      <div className="mt-3 flex flex-wrap gap-2">
        {(event.kind === 'file' || event.kind === 'process' || event.kind === 'privacy') && (
          <>
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
          </>
        )}
        {event.kind === 'process' && (
          <>
            <Button
              size="sm"
              variant={f.risk === 'dangerous' ? 'danger' : 'secondary'}
              onClick={() => onProcess('terminate')}
            >
              {t('realtime.terminate')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onProcess('suspend')}>
              {t('realtime.suspend')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onProcess('resume')}>
              {t('realtime.resume')}
            </Button>
          </>
        )}
        {event.kind === 'file' && isLabCandidate(event.path) && (
          <Button size="sm" variant="secondary" onClick={() => offerToLab(event.path)}>
            {t('lab.offer')}
          </Button>
        )}
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

/** Ransomware-Alarm: kürzlich gestartete eigene Programme einfrieren (nur als Vorschlag). */
function RansomAlarm({
  recent,
  onFreeze,
}: {
  readonly recent: readonly string[];
  readonly onFreeze: (program: string) => void;
}) {
  const { t } = useT();
  return (
    <div
      className="mt-3 rounded-lg border border-danger/60 bg-danger/10 p-3"
      role="group"
      aria-label={t('ransom.alarmTitle')}
      data-testid="ransom-alarm"
    >
      <p className="text-sm font-medium text-text">{t('ransom.alarmTitle')}</p>
      <p className="mt-1 text-xs text-text-subtle">{t('ransom.alarmHint')}</p>
      {recent.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{t('ransom.noRecent')}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {recent.map((program) => (
            <li key={program} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-sm text-text">
                <SafeText value={program} mono breakAll />
              </span>
              <Button size="sm" variant="danger" onClick={() => onFreeze(program)}>
                {t('ransom.freeze')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Ransomware-Schutz: Köderdateien (nur über den Freigabe-Dialog), geschützte Ordner (nur
 * Beobachtung) und der Windows-„Überwachte Ordnerzugriff“ (nur erklären und öffnen).
 */
function RansomPanel({
  service,
  state,
  start,
  onChange,
}: {
  readonly service: ServiceApi;
  readonly state: RansomState | null;
  readonly start: (load: () => ReturnType<ServiceApi['proposeBaits']>) => void;
  readonly onChange: (state: RansomState) => void;
}) {
  const { t } = useT();
  const platform = usePlatform();
  const toast = useToast();
  const count = state?.baits.length ?? 0;
  const fail = (error: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('consentFlow.error'),
      description: error instanceof Error ? error.message : String(error),
    });
  const saveFolders = async (folders: readonly string[]) => {
    try {
      onChange(await service.setProtectedFolders(folders));
    } catch (error) {
      fail(error);
    }
  };
  const addFolder = async () => {
    if (platform.pickPaths === null || state === null) {
      return;
    }
    const picked = await platform.pickPaths('folder');
    if (picked.length > 0) {
      await saveFolders([...state.folders, ...picked.filter((p) => !state.folders.includes(p))]);
    }
  };
  const cfa = state?.controlledFolderAccess ?? null;
  return (
    <Panel title={t('ransom.title')} description={t('ransom.honest')}>
      <div className="space-y-4" data-testid="ransom-panel">
        <div className="space-y-2">
          <p className="text-sm text-text">
            {count > 0 ? t('ransom.baitsOn', { count: String(count) }) : t('ransom.baitsOff')}
          </p>
          <p className="text-sm text-text-muted">{t('ransom.burst')}</p>
          <p className="text-sm text-text-muted">{t('ransom.entropy')}</p>
          <p className="text-xs text-text-subtle">{t('panic.hint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => start(() => service.proposeBaits(true))}
            >
              {t('ransom.addBaits')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => start(() => service.proposePanic(true))}
            >
              {t('panic.button')}
            </Button>
            {count > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => start(() => service.proposeBaits(false))}
              >
                {t('ransom.removeBaits')}
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-2" data-testid="ransom-folders">
          <h3 className="text-sm font-medium text-text">{t('ransom.foldersTitle')}</h3>
          <p className="text-xs text-text-subtle">{t('ransom.foldersHint')}</p>
          <ul className="space-y-1">
            {(state?.defaultFolders ?? []).map((f) => (
              <li key={f} className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                <SafeText value={f} mono breakAll />
                <span className="rounded-sm border border-border px-1 text-2xs text-text-subtle">
                  {t('ransom.standard')}
                </span>
              </li>
            ))}
            {(state?.folders ?? []).map((f) => (
              <li key={f} className="flex flex-wrap items-center gap-2 text-sm text-text">
                <SafeText value={f} mono breakAll />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('ransom.removeFolder', { path: f })}
                  onClick={() => void saveFolders((state?.folders ?? []).filter((x) => x !== f))}
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="secondary"
            disabled={platform.pickPaths === null || state === null}
            onClick={() => void addFolder()}
          >
            {t('ransom.addFolder')}
          </Button>
        </div>

        <div className="space-y-2" data-testid="ransom-cfa">
          <h3 className="text-sm font-medium text-text">{t('ransom.cfaTitle')}</h3>
          <p className="text-sm text-text-muted">
            {cfa === 'on'
              ? t('ransom.cfaOn')
              : cfa === 'audit'
                ? t('ransom.cfaAudit')
                : cfa === 'off'
                  ? t('ransom.cfaOff')
                  : t('ransom.cfaUnknown')}
          </p>
          <p className="text-xs text-text-subtle">{t('ransom.cfaExplain')}</p>
          {platform.openWindowsSecurity !== null && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const open = platform.openWindowsSecurity;
                if (open !== null) {
                  open().catch(fail);
                }
              }}
            >
              {t('ransom.cfaOpen')}
            </Button>
          )}
        </div>
      </div>
    </Panel>
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

  const [ransomVersion, setRansomVersion] = useState(0);
  const [ransom, setRansom] = useState<RansomState | null>(null);
  const flow = useConsentFlow(service, () => {
    void refresh();
    setRansomVersion((v) => v + 1);
  });
  const hasAlarm = (state?.events ?? []).some((e) => e.kind === 'ransomware');
  useEffect(() => {
    if (service === null) {
      return;
    }
    let active = true;
    service.ransomStatus().then(
      (r) => {
        if (active) {
          setRansom(r);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [service, ransomVersion, hasAlarm]);

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
          <RansomPanel
            service={service}
            state={ransom}
            start={(load) => void flow.start(load)}
            onChange={setRansom}
          />
          <BackupPanel
            service={service}
            start={(load) => void flow.start(load)}
            version={ransomVersion}
          />
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
                    onProcess={(action) =>
                      void flow.start(() => service.proposeProcessAction(e.path, action))
                    }
                    recent={ransom?.recent ?? []}
                    onFreeze={(program) =>
                      void flow.start(() => service.proposeProcessAction(program, 'suspend'))
                    }
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
