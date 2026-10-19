/**
 * Geplante Scans (eigenes Profil: Downloads, Desktop, Dokumente) und tägliches
 * ClamAV-Signatur-Update. Geplante Scans prüfen und melden nur – Funde erscheinen wie
 * Wächter-Meldungen und im Verlauf.
 */
import { Panel, SegmentedControl, Toggle } from '@aegis/ui';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { ScheduleState, ServiceApi } from '../platform/service.ts';
import { ServiceNotice } from './ServiceNotice.tsx';

type Every = '1' | '7' | '30';

/** Ortszeit-Stunde → UTC-Stunde (Versatz in Minuten wie `Date#getTimezoneOffset`). */
export function toUtcHour(localHour: number, offsetMinutes: number): number {
  return ((Math.round((localHour * 60 + offsetMinutes) / 60) % 24) + 24) % 24;
}

/** UTC-Stunde → Ortszeit-Stunde. */
export function toLocalHour(utcHour: number, offsetMinutes: number): number {
  return ((Math.round((utcHour * 60 - offsetMinutes) / 60) % 24) + 24) % 24;
}

export function SchedulePanel({ service }: { readonly service: ServiceApi }) {
  const { t, locale } = useT();
  const [state, setState] = useState<ScheduleState | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const offset = new Date().getTimezoneOffset();

  useEffect(() => {
    let active = true;
    service.getSchedule().then(
      (s) => {
        if (active) {
          setState(s);
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

  const apply = (promise: Promise<ScheduleState>) => {
    promise.then(
      (s) => {
        setState(s);
        setDown(null);
      },
      (error: unknown) => setDown(error instanceof Error ? error.message : String(error)),
    );
  };

  const schedule = state?.schedule ?? null;
  const enabled = schedule?.enabled ?? false;
  const every = schedule?.everyDays ?? 7;
  const localHour = toLocalHour(schedule?.hourUtc ?? toUtcHour(18, offset), offset);
  const save = (next: { enabled?: boolean; every?: 1 | 7 | 30; hour?: number }) => {
    apply(
      service.setSchedule(
        next.enabled ?? enabled,
        next.every ?? every,
        toUtcHour(next.hour ?? localHour, offset),
      ),
    );
  };
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
  };

  return (
    <Panel title={t('schedule.title')} description={t('schedule.intro')}>
      {down !== null && <ServiceNotice kind="down" detail={down} />}
      {state !== null && (
        <div className="space-y-4" data-testid="schedule-panel">
          <Toggle
            checked={enabled}
            onCheckedChange={(on) => save({ enabled: on })}
            label={t('schedule.enabled')}
            description={
              schedule?.lastRun != null
                ? t('schedule.lastRun', { date: date(schedule.lastRun) })
                : t('schedule.never')
            }
          />
          <div className="flex flex-wrap items-center gap-4">
            <SegmentedControl<Every>
              label={t('schedule.every')}
              size="sm"
              value={String(every) as Every}
              disabled={!enabled}
              onValueChange={(v) => save({ every: Number(v) as 1 | 7 | 30 })}
              options={[
                { value: '1', label: t('schedule.daily') },
                { value: '7', label: t('schedule.weekly') },
                { value: '30', label: t('schedule.monthly') },
              ]}
            />
            <label className="flex items-center gap-2 text-sm text-text-muted">
              {t('schedule.hour')}
              <select
                className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-text"
                value={localHour}
                disabled={!enabled}
                onChange={(e) => save({ hour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {`${String(h).padStart(2, '0')}:00`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Toggle
            checked={state.clamavUpdate}
            disabled={!state.clamavUpdateAvailable || !state.canChangeGlobal}
            onCheckedChange={(on) => apply(service.setClamavUpdate(on))}
            label={t('schedule.clamavUpdate')}
            description={
              !state.clamavUpdateAvailable
                ? t('schedule.clamavMissing')
                : state.lastUpdate === null
                  ? t('schedule.clamavHint')
                  : t(state.lastUpdate.ok ? 'schedule.updateOk' : 'schedule.updateFailed', {
                      date: date(state.lastUpdate.at),
                      message: state.lastUpdate.message,
                    })
            }
          />
          {state.clamavUpdateAvailable && !state.canChangeGlobal && (
            <p className="text-xs text-text-subtle" data-testid="admin-only">
              {t('schedule.adminOnly')}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
