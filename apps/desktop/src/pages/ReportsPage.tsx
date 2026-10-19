/**
 * Berichte & Zeitleiste: Verlauf des eigenen Kontos (Scans, Wächter, geplante Scans,
 * Entscheidungen, Updates) – nur lesend. Export als HTML-Datei (Inhalt erzeugt die App in
 * Rust, den Ort wählt der Nutzer im Speichern-Dialog) oder Drucken bzw. „Als PDF speichern“.
 */
import { Button, Panel, RiskBadge, SafeText, SegmentedControl, useToast } from '@aegis/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { HistoryEntry, HistoryKind, HistoryState } from '../platform/service.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';

type Filter = 'all' | 'scans' | 'watch' | 'decisions' | 'system';

const filterKinds: Readonly<Record<Filter, readonly HistoryKind[] | null>> = {
  all: null,
  scans: ['scan', 'schedule'],
  watch: ['watch'],
  decisions: ['action', 'decision'],
  system: ['update'],
};

/** Einträge nach Tag (Ortszeit) gruppieren, neueste zuerst. */
export function groupByDay(
  entries: readonly HistoryEntry[],
  locale: string,
): { readonly day: string; readonly entries: readonly HistoryEntry[] }[] {
  const groups: { day: string; entries: HistoryEntry[] }[] = [];
  for (const entry of entries) {
    const date = new Date(entry.at);
    const day = Number.isNaN(date.getTime())
      ? entry.at.slice(0, 10)
      : date.toLocaleDateString(locale, {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
    const last = groups.at(-1);
    if (last?.day === day) {
      last.entries.push(entry);
    } else {
      groups.push({ day, entries: [entry] });
    }
  }
  return groups;
}

function EntryRow({ entry }: { readonly entry: HistoryEntry }) {
  const { t, locale } = useT();
  const date = new Date(entry.at);
  return (
    <li className="rounded-xl border border-border bg-surface-2 p-4" data-testid="history-entry">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-text-subtle tabular-nums">
          {Number.isNaN(date.getTime())
            ? entry.at
            : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-muted">
          {t(`reports.kinds.${entry.kind}`)}
        </span>
        {entry.risk !== null && entry.risk !== 'clean' && <RiskBadge level={entry.risk} />}
      </div>
      <p className="mt-2 text-sm text-text">
        <SafeText value={entry.title} />
      </p>
      {entry.detail !== '' && (
        <p className="mt-1 text-xs whitespace-pre-wrap text-text-muted">
          <SafeText value={entry.detail} />
        </p>
      )}
      {entry.paths.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-text-muted">
          {entry.paths.map((p, i) => (
            <li key={`${p}-${String(i)}`}>
              <SafeText value={p} mono breakAll />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ReportsPage() {
  const { t, locale, language } = useT();
  const service = usePlatform().service;
  const toast = useToast();
  const [state, setState] = useState<HistoryState | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    if (service === null) {
      return;
    }
    try {
      setState(await service.history());
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
    service.history().then(
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
    return () => {
      active = false;
    };
  }, [service]);

  const exportHtml = () => {
    if (service === null) {
      return;
    }
    service.exportReport(language === 'en').then(
      (path) => {
        if (path !== null) {
          toast.show({ tone: 'success', title: t('reports.saved'), description: path });
        }
      },
      (error: unknown) => {
        toast.show({
          tone: 'danger',
          title: t('reports.saveFailed'),
          description: error instanceof Error ? error.message : String(error),
        });
      },
    );
  };

  const kinds = filterKinds[filter];
  const entries = (state?.entries ?? []).filter((e) => kinds === null || kinds.includes(e.kind));

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.reports.eyebrow')}
        title={t('pages.reports.title')}
        description={t('reports.intro')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : (
        <Panel
          title={t('reports.timeline')}
          description={t('reports.timelineHint')}
          actions={
            <div className="flex flex-wrap gap-2" data-print-hide="">
              <Button size="sm" variant="ghost" onClick={() => void load()}>
                {t('vault.refresh')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => window.print()}>
                {t('reports.print')}
              </Button>
              <Button size="sm" onClick={exportHtml}>
                {t('reports.exportHtml')}
              </Button>
            </div>
          }
        >
          {down !== null && <ServiceNotice kind="down" detail={down} />}
          {state?.saveFailed === true && (
            <p className="mb-3 text-xs text-warn">{t('reports.saveWarning')}</p>
          )}
          <div className="mb-4" data-print-hide="">
            <SegmentedControl<Filter>
              label={t('reports.filter')}
              value={filter}
              onValueChange={setFilter}
              size="sm"
              options={[
                { value: 'all', label: t('reports.filters.all') },
                { value: 'scans', label: t('reports.filters.scans') },
                { value: 'watch', label: t('reports.filters.watch') },
                { value: 'decisions', label: t('reports.filters.decisions') },
                { value: 'system', label: t('reports.filters.system') },
              ]}
            />
          </div>
          {state !== null && entries.length === 0 && (
            <p className="text-sm text-text-muted" data-testid="history-empty">
              {t('reports.empty')}
            </p>
          )}
          <div className="space-y-6">
            {groupByDay(entries, locale).map((group) => (
              <section key={group.day} aria-label={group.day}>
                <h3 className="mb-2 text-xs font-semibold tracking-caps text-text-subtle uppercase">
                  {group.day}
                </h3>
                <ol className="space-y-3">
                  {group.entries.map((e) => (
                    <EntryRow key={e.seq} entry={e} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        </Panel>
      )}
    </PageBody>
  );
}
