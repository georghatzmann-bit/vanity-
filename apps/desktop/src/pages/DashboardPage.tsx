import {
  Button,
  IconArrowRight,
  IconChevronRight,
  IconInfo,
  IconPanic,
  IconPlay,
  IconPower,
  IconSearch,
  IconSettings,
  IconShield,
  IconSliders,
  IconWarning,
  Kbd,
  Panel,
  ScoreGauge,
  StatusRing,
  Tooltip,
  cx,
  type IconComponent,
  type ModuleState,
} from '@aegis/ui';
import { requestEmergencyScan } from './emergencyRequest.ts';
import { useEffect, useMemo, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import type { ActivityEntry } from '../activity/activityLog.ts';
import { useActivity, useServices } from '../app/services.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { WatchState } from '../platform/service.ts';
import type { Translator } from '../i18n/translator.ts';
import { describeSettingValue, settingLabelKeys } from '../settings/describe.ts';
import { useShell } from '../shell/ShellContext.tsx';
import { modifierKeys } from '../shell/shortcuts.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';

/** Bauplan laut docs/PROGRESS.md: P0–P5 erledigt, P6 in Arbeit. */
export const buildPhases = [
  'P0',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'P11',
  'P12',
  'P13',
] as const;
type BuildPhase = (typeof buildPhases)[number];
export const CURRENT_PHASE: BuildPhase = 'P8';
const currentIndex = buildPhases.indexOf(CURRENT_PHASE);
const LAST_PHASE: BuildPhase = 'P13';

/** Schutz-Module des Dashboards: gebaute zeigen ihren echten Zustand, fehlende ihre Phase. */
const modules = [
  { id: 'signatures', phase: null },
  { id: 'realtime', phase: null },
  { id: 'ransomware', phase: null },
  { id: 'network', phase: null },
] as const;

interface LiveModule {
  readonly state: ModuleState;
  readonly stateLabel: string;
  readonly sublabel: string;
}

/** Echte Zustände von Engine und Wächter (alle 10 s vom Dienst; in der Vorschau: keine). */
function useLiveModules(): Readonly<
  Record<'signatures' | 'realtime' | 'ransomware' | 'network', LiveModule>
> {
  const { t } = useT();
  const service = usePlatform().service;
  const [live, setLive] = useState<{
    readonly reachable: boolean | null;
    readonly clamav: boolean;
    readonly watch: WatchState | null;
    readonly baits: number;
  }>({ reachable: null, clamav: false, watch: null, baits: 0 });

  useEffect(() => {
    if (service === null) {
      return undefined;
    }
    let active = true;
    const tick = () => {
      Promise.all([
        service.watchPoll(Number.MAX_SAFE_INTEGER),
        service.getSchedule(),
        service.ransomStatus().catch(() => ({ baits: [] })),
      ]).then(
        ([watch, schedule, ransom]) => {
          if (active) {
            setLive({
              reachable: true,
              clamav: schedule.clamavAvailable,
              watch,
              baits: ransom.baits.length,
            });
          }
        },
        () => {
          if (active) {
            setLive({ reachable: false, clamav: false, watch: null, baits: 0 });
          }
        },
      );
    };
    tick();
    const timer = window.setInterval(tick, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [service]);

  if (service === null) {
    const preview: LiveModule = {
      state: 'unavailable',
      stateLabel: t('dashboard.modules.unavailable'),
      sublabel: t('dashboard.modules.previewOnly'),
    };
    return { signatures: preview, realtime: preview, ransomware: preview, network: preview };
  }
  if (live.reachable !== true) {
    const unknown: LiveModule = {
      state: live.reachable === false ? 'warn' : 'scanning',
      stateLabel:
        live.reachable === false ? t('dashboard.modules.down') : t('dashboard.modules.checking'),
      sublabel: live.reachable === false ? t('dashboard.modules.downHint') : '',
    };
    return { signatures: unknown, realtime: unknown, ransomware: unknown, network: unknown };
  }
  const watch = live.watch;
  return {
    signatures: {
      state: 'ok',
      stateLabel: t('dashboard.modules.ready'),
      sublabel: live.clamav ? t('dashboard.modules.withClamav') : t('dashboard.modules.noClamav'),
    },
    realtime:
      watch === null || !watch.active
        ? { state: 'off', stateLabel: t('dashboard.modules.off'), sublabel: watch?.note ?? '' }
        : watch.gaming
          ? {
              state: 'warn',
              stateLabel: t('dashboard.modules.gaming'),
              sublabel: t('dashboard.modules.gamingHint'),
            }
          : {
              state: 'ok',
              stateLabel: t('dashboard.modules.active'),
              sublabel: t('realtime.folders', { count: String(watch.folders.length) }),
            },
    ransomware:
      watch === null || !watch.active
        ? { state: 'off', stateLabel: t('dashboard.modules.off'), sublabel: '' }
        : {
            state: live.baits > 0 ? 'ok' : 'warn',
            stateLabel: t('dashboard.modules.active'),
            sublabel:
              live.baits > 0
                ? t('dashboard.modules.withBaits', { count: String(live.baits) })
                : t('dashboard.modules.noBaits'),
          },
    network: {
      state: 'ok',
      stateLabel: t('dashboard.modules.ready'),
      sublabel: t('dashboard.modules.networkHint'),
    },
  };
}

/** Zwei Spalten mit gemeinsamen Fugen: schmal (Score, Schnellzugriff) | breit. */
const columns = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)] gap-5';

/** Anzahl der Einträge, bevor „Alle anzeigen“ nötig ist. */
const ACTIVITY_PREVIEW = 6;

/**
 * Dashboard – ehrlich: Score und Module zeigen „nicht verfügbar / folgt in Pn“, bis es echte
 * Messwerte gibt. Die Live-Aktivität enthält nur echte Ereignisse dieser Sitzung.
 */
export function DashboardPage() {
  const { t } = useT();
  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.dashboard.eyebrow')}
        title={t('pages.dashboard.title')}
        description={t('pages.dashboard.description')}
      />
      <HonestyNotes />
      <div className={columns}>
        <ScorePanel />
        <ModulesPanel />
      </div>
      <div className={columns}>
        <QuickActions />
        <BuildPanel />
      </div>
      <ActivityPanel />
    </PageBody>
  );
}

/** Die beiden Grundsätze, die jeder kennen soll – gut sichtbar ganz oben. */
function HonestyNotes() {
  const { t } = useT();
  const items = [
    {
      id: 'golden',
      icon: IconShield,
      title: t('dashboard.honesty.goldenTitle'),
      text: t('dashboard.honesty.golden'),
    },
    {
      id: 'kernel',
      icon: IconInfo,
      title: t('dashboard.honesty.kernelTitle'),
      text: t('dashboard.honesty.kernel'),
    },
  ] as const;
  return (
    <section
      aria-label={t('dashboard.honesty.label')}
      className="relative grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] overflow-hidden rounded-xl border border-border bg-surface-1 shadow-bevel"
      data-testid="honesty-notes"
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-accent/60 to-transparent"
      />
      {items.map((item, index) => (
        <div
          key={item.id}
          className={cx(
            'flex items-start gap-3.5 px-5 py-4',
            index > 0 && 'border-l border-border',
          )}
          data-testid={`honesty-${item.id}`}
        >
          <span
            aria-hidden="true"
            className={cx(
              'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border',
              index === 0
                ? 'border-accent/40 bg-accent-glow/30 text-accent'
                : 'border-border bg-surface-2 text-text-muted',
            )}
          >
            <item.icon size={16} strokeWidth={2} />
          </span>
          <p className="text-sm text-text-muted">
            <strong className="block font-semibold text-text">{item.title}</strong> {item.text}
          </p>
        </div>
      ))}
    </section>
  );
}

/** Score der Härtung (gemerktes Ergebnis des Dienstes; in der Vorschau: keiner). */
function useHardeningScore(): number | null {
  const service = usePlatform().service;
  const [score, setScore] = useState<number | null>(null);
  useEffect(() => {
    if (service === null) {
      return undefined;
    }
    let active = true;
    service.hardeningStatus(false).then(
      (s) => {
        if (active) {
          setScore(s.score);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [service]);
  return score;
}

function ScorePanel() {
  const { t } = useT();
  const score = useHardeningScore();
  return (
    <Panel
      eyebrow={t('dashboard.score.eyebrow')}
      title={t('dashboard.score.title')}
      data-testid="score-panel"
    >
      <div className="flex justify-center pt-1">
        <ScoreGauge
          value={score}
          size={184}
          label={t('dashboard.score.label')}
          unavailableText={t('dashboard.score.unavailable')}
          unavailableHint={t('dashboard.score.hint')}
          outOfLabel={t('dashboard.score.outOf')}
          bandLabels={{
            low: t('dashboard.score.bands.low'),
            medium: t('dashboard.score.bands.medium'),
            high: t('dashboard.score.bands.high'),
          }}
        />
      </div>
    </Panel>
  );
}

function ModulesPanel() {
  const { t } = useT();
  const live = useLiveModules();
  return (
    <Panel
      eyebrow={t('dashboard.modules.eyebrow')}
      title={t('dashboard.modules.title')}
      data-testid="modules-panel"
      footer={
        <p className="flex items-start gap-2 text-xs text-text-muted">
          <IconInfo size={14} aria-hidden="true" className="mt-px shrink-0" />
          {t('dashboard.modules.footer')}
        </p>
      }
    >
      <ul className="grid grid-cols-2 gap-x-6 gap-y-5 pt-1">
        {modules.map((module) => {
          const state =
            module.phase === null
              ? live[module.id]
              : {
                  state: 'unavailable' as const,
                  stateLabel: t('dashboard.modules.unavailable'),
                  sublabel: t('phase.comingIn', { phase: module.phase }),
                };
          return (
            <li key={module.id} data-testid={`module-${module.id}`}>
              <StatusRing
                state={state.state}
                layout="inline"
                label={t(`dashboard.modules.${module.id}`)}
                stateLabel={state.stateLabel}
                sublabel={state.sublabel}
                size={60}
              />
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** „AEGIS entsteht“: Bauplan P0–P13 mit dem aktuellen Stand und den nächsten Schritten. */
function BuildPanel() {
  const { t } = useT();
  const upcoming = buildPhases.slice(currentIndex + 1, currentIndex + 4);
  return (
    <Panel
      eyebrow={t('dashboard.build.eyebrow')}
      title={t('dashboard.build.title')}
      data-testid="build-panel"
    >
      <p className="max-w-xl text-sm text-text-muted">{t('dashboard.build.lead')}</p>
      <div className="mt-5" role="group" aria-label={t('dashboard.build.progressLabel')}>
        <div aria-hidden="true" className="flex gap-1.5">
          {buildPhases.map((phase, index) => (
            <span
              key={phase}
              className={cx(
                'h-1.5 flex-1 rounded-full',
                index < currentIndex && 'bg-accent shadow-glow',
                index === currentIndex && 'bg-accent/35 ring-1 ring-accent ring-inset',
                index > currentIndex && 'bg-surface-3',
              )}
            />
          ))}
        </div>
        <p className="mt-2.5 flex items-center justify-between gap-4 font-mono text-2xs tracking-wide text-text-muted">
          <span>
            {t('dashboard.build.summary', {
              current: CURRENT_PHASE,
              last: LAST_PHASE,
              name: t(`dashboard.build.phases.${CURRENT_PHASE}`),
            })}
          </span>
          <span className="text-accent">{t('dashboard.build.current')}</span>
        </p>
      </div>
      <p className="mt-5 font-mono text-2xs tracking-caps text-text-subtle uppercase">
        {t('dashboard.build.next')}
      </p>
      <ol className="mt-2 grid grid-cols-3 gap-2">
        {upcoming.map((phase) => (
          <li
            key={phase}
            className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5"
          >
            <span className="font-mono text-2xs text-text-subtle">{phase}</span>
            <span className="text-sm text-text">{t(`dashboard.build.phases.${phase}`)}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

interface ActionRowProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  readonly icon: IconComponent;
  readonly label: string;
  /** Rechts: Tastenkürzel, Phase oder Pfeil. */
  readonly trailing: ReactNode;
}

/** Zeile im Schnellzugriff: Symbol, Beschriftung, rechts Kürzel/Hinweis. */
function ActionRow({ icon: Icon, label, trailing, className, ...rest }: ActionRowProps) {
  const unavailable = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  return (
    <button
      type="button"
      className={cx(
        'group flex min-h-11 w-full items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-left text-sm transition-colors duration-150',
        unavailable
          ? 'cursor-not-allowed text-text-subtle'
          : 'text-text hover:border-border hover:bg-surface-2',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cx(
          'grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface-2',
          unavailable ? 'text-text-subtle' : 'text-text-muted group-hover:text-accent',
        )}
      >
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1 text-pretty">{label}</span> {trailing}
    </button>
  );
}

function QuickActions() {
  const { t } = useT();
  const { router } = useServices();
  const { openPalette, replayBoot } = useShell();
  const chevron = (
    <IconChevronRight size={14} aria-hidden="true" className="shrink-0 text-text-subtle" />
  );
  return (
    <Panel
      eyebrow={t('dashboard.quick.eyebrow')}
      title={t('dashboard.quick.title')}
      data-testid="quick-actions"
    >
      <div className="-mx-2 flex flex-col gap-0.5">
        <ActionRow
          icon={IconPlay}
          label={t('dashboard.quick.replayBoot')}
          trailing={chevron}
          onClick={replayBoot}
          data-testid="replay-boot"
        />
        <ActionRow
          icon={IconSearch}
          label={t('dashboard.quick.palette')}
          trailing={<Kbd keys={modifierKeys(t, 'K')} size="sm" aria-hidden="true" />}
          onClick={openPalette}
          aria-keyshortcuts="Control+K Meta+K"
        />
        <ActionRow
          icon={IconSettings}
          label={t('dashboard.quick.settings')}
          trailing={chevron}
          onClick={() => router.navigate('settings')}
        />
        <Tooltip content={t('dashboard.quick.emergencyHint')} placement="top">
          <ActionRow
            icon={IconPanic}
            label={t('dashboard.quick.emergency')}
            trailing={chevron}
            onClick={requestEmergencyScan}
            className="flex-1"
            data-testid="emergency-scan"
          />
        </Tooltip>
      </div>
    </Panel>
  );
}

const activityIcons: Readonly<Record<ActivityEntry['kind'], IconComponent>> = {
  'app-started': IconPower,
  'setting-changed': IconSliders,
  'boot-replayed': IconPlay,
  'tray-navigate': IconArrowRight,
  'save-failed': IconWarning,
};

function describeActivity(t: Translator['t'], entry: ActivityEntry): string {
  switch (entry.kind) {
    case 'app-started':
      return t('dashboard.activity.events.appStarted');
    case 'setting-changed':
      return t('dashboard.activity.events.settingChanged', {
        setting: t(settingLabelKeys[entry.setting]),
        value: describeSettingValue(t, entry.setting, entry.value),
      });
    case 'boot-replayed':
      return t('dashboard.activity.events.bootReplayed');
    case 'tray-navigate':
      return t('dashboard.activity.events.trayNavigate', {
        page: t(`pages.${entry.target}.title`),
      });
    case 'save-failed':
      return t('dashboard.activity.events.saveFailed');
  }
}

function ActivityPanel() {
  const { t, tp, locale } = useT();
  const entries = useActivity();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? entries : entries.slice(0, ACTIVITY_PREVIEW);
  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    [locale],
  );

  return (
    <Panel
      eyebrow={t('dashboard.activity.eyebrow')}
      title={t('dashboard.activity.title')}
      padding="none"
      data-testid="activity-panel"
      actions={
        <span className="font-mono text-2xs text-text-subtle" data-testid="activity-count">
          {tp('dashboard.activity.count', entries.length)}
        </span>
      }
      footer={
        <div className="flex items-center justify-between gap-4">
          <p className="flex items-start gap-2 text-xs text-text-muted">
            <IconInfo size={14} aria-hidden="true" className="mt-px shrink-0" />
            {t('dashboard.activity.footer')}
          </p>
          {entries.length > ACTIVITY_PREVIEW && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t('dashboard.activity.showLess') : t('dashboard.activity.showAll')}
            </Button>
          )}
        </div>
      }
    >
      <ol className="divide-y divide-border border-t border-border" data-testid="activity-list">
        {visible.map((entry) => {
          const Icon = activityIcons[entry.kind];
          return (
            <li
              key={entry.id}
              // Zeitspalte so breit wie die Uhrzeit (12-Stunden-Format mit „AM“/„PM“ ist länger).
              className="grid grid-cols-[minmax(4.5rem,max-content)_1.75rem_minmax(0,1fr)] items-center gap-3 px-5 py-2.5"
              data-kind={entry.kind}
            >
              <time
                dateTime={new Date(entry.at).toISOString()}
                className="font-mono text-xs whitespace-nowrap text-text-subtle tabular-nums"
              >
                {time.format(entry.at)}
              </time>
              <span
                aria-hidden="true"
                className={cx(
                  'grid size-7 place-items-center rounded-md border border-border bg-surface-2',
                  entry.kind === 'save-failed' ? 'text-warn' : 'text-text-muted',
                )}
              >
                <Icon size={14} />
              </span>
              <p className="min-w-0 truncate text-sm text-text">
                {describeActivity(t, entry)}
                {entry.kind === 'app-started' && (
                  // Echtes Leerzeichen davor: sonst hören Screenreader „AEGIS gestartetBrowser-Vorschau“.
                  <>
                    {' '}
                    <span className="ml-1 text-xs text-text-subtle">
                      {entry.platform === 'tauri' ? t('statusbar.desktop') : t('statusbar.preview')}
                    </span>
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
