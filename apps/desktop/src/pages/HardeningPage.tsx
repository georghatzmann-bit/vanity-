/**
 * Härtung & Sicherheits-Score (P6): Der Dienst liest Windows-Einstellungen und bewertet sie.
 * Verbesserungen sind Vorschläge des Dienstes (Plan mit Vorschau) und passieren erst nach „Ja“;
 * der alte Stand wird gemerkt und lässt sich per „Rückgängig“ (ebenfalls ein Plan) zurückholen.
 * „Unbekannt“ bleibt unbekannt und zählt nicht in den Score.
 */
import {
  Button,
  IconRefresh,
  IconUndo,
  Panel,
  RiskBadge,
  SafeText,
  ScoreGauge,
  useToast,
} from '@aegis/ui';
import type { RiskLevel } from '@aegis/ui';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { WindowsSettingsPage } from '../platform/platform.ts';
import {
  fixKinds,
  type CheckStatus,
  type FixKind,
  type HardeningCheckId,
  type HardeningState,
} from '../platform/service.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { PersistencePanel } from './PersistencePanel.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

/** Was „In Windows öffnen“ je Prüfung zeigt. */
const settingsPage: Readonly<Partial<Record<HardeningCheckId, WindowsSettingsPage>>> = {
  updates: 'windows_update',
  bit_locker: 'device_encryption',
  antivirus: 'virus_protection',
};

/** Nur der Proxy betrifft allein das eigene Konto – alles andere den ganzen PC. */
const ownAccountFixes: ReadonlySet<FixKind> = new Set(['disable_proxy']);

const statusLevel: Readonly<Record<CheckStatus, RiskLevel>> = {
  pass: 'clean',
  warn: 'risky',
  fail: 'dangerous',
  unknown: 'info',
};

/** Score-Verlauf als Linie (nur SVG-Linie, keine Animation). */
function History({ points }: { readonly points: HardeningState['history'] }) {
  const { t } = useT();
  if (points.length === 0) {
    return <p className="text-sm text-text-muted">{t('hardening.historyEmpty')}</p>;
  }
  const width = 300;
  const height = 64;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points
    .map((p, i) => `${(i * step).toFixed(1)},${(height - (p.value / 100) * height).toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1];
  return (
    <figure className="space-y-2" data-testid="hardening-history">
      <svg
        role="img"
        aria-label={t('hardening.historyLabel', { count: String(points.length) })}
        viewBox={`-4 -4 ${String(width + 8)} ${String(height + 8)}`}
        className="h-20 w-full text-accent"
        preserveAspectRatio="none"
      >
        <polyline
          points={coords}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </svg>
      {last !== undefined && (
        <figcaption className="text-xs text-text-subtle tabular-nums">
          {points[0]?.date} – {last.date}
        </figcaption>
      )}
    </figure>
  );
}

export function HardeningPage() {
  const { t, language, locale } = useT();
  const platform = usePlatform();
  const service = platform.service;
  const [state, setState] = useState<HardeningState | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (fresh: boolean) => {
      if (service === null) {
        return;
      }
      setBusy(true);
      try {
        setState(await service.hardeningStatus(fresh));
        setDown(null);
      } catch (error) {
        setDown(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [service],
  );

  useEffect(() => {
    if (service === null) {
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      if (active) {
        void load(false);
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [service, load]);

  const toast = useToast();
  const [version, setVersion] = useState(0);
  const flow = useConsentFlow(service, () => {
    void load(true);
    setVersion((v) => v + 1);
  });
  const fail = (error: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('consentFlow.error'),
      description: error instanceof Error ? error.message : String(error),
    });
  const openSettings = (page: WindowsSettingsPage) => {
    platform.openWindowsSettings?.(page).catch(fail);
  };

  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
  };
  const known = state?.checks.filter((c) => c.status !== 'unknown').length ?? 0;
  const open = state?.listening?.filter((p) => p.allInterfaces && p.protocol === 'tcp') ?? [];

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.hardening.eyebrow')}
        title={t('pages.hardening.title')}
        description={t('hardening.intro')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : (
        <>
          {down !== null && <ServiceNotice kind="down" detail={down} />}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <Panel
              title={t('hardening.scoreTitle')}
              description={t('hardening.readOnly')}
              data-testid="hardening-score"
            >
              <div className="flex flex-col items-center gap-3">
                <ScoreGauge
                  value={state?.score ?? null}
                  size={184}
                  label={t('dashboard.score.label')}
                  unavailableText={t('dashboard.score.unavailable')}
                  unavailableHint={
                    state !== null && !state.available
                      ? t('hardening.windowsOnly')
                      : t('dashboard.score.hint')
                  }
                  outOfLabel={t('dashboard.score.outOf')}
                  bandLabels={{
                    low: t('dashboard.score.bands.low'),
                    medium: t('dashboard.score.bands.medium'),
                    high: t('dashboard.score.bands.high'),
                  }}
                />
                {state !== null && (
                  <p className="text-sm text-text-muted tabular-nums" data-testid="hardening-rated">
                    {t('hardening.rated', {
                      known: String(known),
                      total: String(state.checks.length),
                    })}
                  </p>
                )}
                {state !== null && state.checkedAt !== '' && (
                  <p className="text-xs text-text-subtle">
                    {t('hardening.checkedAt', { date: date(state.checkedAt) })}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  iconStart={<IconRefresh />}
                  onClick={() => void load(true)}
                >
                  {busy ? t('hardening.checking') : t('hardening.check')}
                </Button>
              </div>
              <div className="mt-6 border-t border-border pt-4">
                <h3 className="mb-2 text-sm font-medium text-text">
                  {t('hardening.historyTitle')}
                </h3>
                <History points={state?.history ?? []} />
              </div>
            </Panel>
            <Panel title={t('hardening.checksTitle')} description={t('hardening.fixHint')}>
              {state === null ? (
                <p className="text-sm text-text-muted">{t('hardening.checking')}</p>
              ) : (
                <ul className="space-y-3" data-testid="hardening-checks">
                  {state.checks.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-xl border border-border bg-surface-2 p-4"
                      data-testid={`hardening-check-${c.id}`}
                      data-status={c.status}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 flex-1 text-sm font-semibold text-text">
                          {t(`hardening.checks.${c.id}`)}
                        </h3>
                        <span className="text-xs text-text-subtle tabular-nums">
                          {t('hardening.weight', { weight: String(c.weight) })}
                        </span>
                        <RiskBadge
                          level={statusLevel[c.status]}
                          size="sm"
                          label={t(`hardening.status.${c.status}`)}
                        />
                      </div>
                      <p className="mt-2 text-sm text-text-muted">
                        <SafeText value={language === 'en' ? c.summaryEn : c.summaryDe} />
                      </p>
                      {c.fix !== null && (
                        <p className="mt-2 text-xs text-text-subtle">
                          {t(`hardening.fix.${c.fix}`)}
                        </p>
                      )}
                      {c.fix !== null &&
                        c.fix !== 'open_settings' &&
                        service !== null &&
                        (() => {
                          const fix = c.fix;
                          const allowed = state.admin || ownAccountFixes.has(fix);
                          return (
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                disabled={!allowed}
                                onClick={() =>
                                  void flow.start(() => service.proposeHardeningFix(fix))
                                }
                              >
                                {t('hardening.fixButton')}
                              </Button>
                              {!allowed && (
                                <span className="text-xs text-text-subtle">
                                  {t('hardening.adminOnly')}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      {c.fix === 'open_settings' &&
                        settingsPage[c.id] !== undefined &&
                        platform.openWindowsSettings !== null && (
                          <div className="mt-3">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                const page = settingsPage[c.id];
                                if (page !== undefined) {
                                  openSettings(page);
                                }
                              }}
                            >
                              {t('hardening.openSettings')}
                            </Button>
                          </div>
                        )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          {service !== null && (
            <PersistencePanel
              service={service}
              start={(load) => void flow.start(load)}
              version={version}
            />
          )}
          {state !== null && state.undo.length > 0 && (
            <Panel title={t('hardening.undoTitle')} description={t('hardening.undoHint')}>
              <ul className="space-y-2" data-testid="hardening-undo">
                {state.undo.map((u) => (
                  <li
                    key={u.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2"
                  >
                    <span className="min-w-0 flex-1 text-sm text-text">
                      {u.fix.startsWith('autorun:') ? (
                        <SafeText
                          value={t('hardening.autorunDone', {
                            name: u.fix.slice('autorun:'.length),
                          })}
                        />
                      ) : (fixKinds as readonly string[]).includes(u.fix) ? (
                        t(`hardening.fixDone.${u.fix as FixKind}`)
                      ) : (
                        u.fix
                      )}
                      <span className="block text-xs text-text-subtle">{date(u.at)}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconStart={<IconUndo />}
                      onClick={() => void flow.start(() => service.proposeHardeningUndo(u.id))}
                    >
                      {t('hardening.undo')}
                    </Button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {state?.available === true && (
            <Panel title={t('hardening.detailsTitle')}>
              <div className="space-y-3 text-sm text-text-muted" data-testid="hardening-details">
                {state.osVersion !== null && (
                  <p>{t('hardening.os', { version: state.osVersion })}</p>
                )}
                <p>
                  {state.dnsServers.length > 0 ? (
                    <SafeText
                      value={t('hardening.dns', { servers: state.dnsServers.join(', ') })}
                    />
                  ) : (
                    t('hardening.dnsNone')
                  )}
                </p>
                <div>
                  <h3 className="mb-1 font-medium text-text">{t('hardening.open')}</h3>
                  {open.length === 0 ? (
                    <p>{t('hardening.openNone')}</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {open.slice(0, 60).map((p) => (
                        <li
                          key={`${p.protocol}-${String(p.port)}`}
                          className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs tabular-nums"
                        >
                          {p.port} · <SafeText value={p.program ?? t('hardening.unknownProgram')} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Panel>
          )}
        </>
      )}
      {flow.dialogs}
    </PageBody>
  );
}
