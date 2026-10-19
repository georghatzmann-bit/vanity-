/**
 * Labor: unbekannte Programme abgeschottet starten und beobachten. Die Oberfläche wählt nur
 * Datei, Stufe, Dauer und Netz – gestartet wird **nur** über den Freigabe-Dialog des Dienstes
 * („Ja, ausführen“). Ehrlich: Die Mini-Sandbox (Stufe 2) ist schwächer als eine VM.
 */
import {
  Button,
  Panel,
  RiskBadge,
  SafeText,
  SegmentedControl,
  Toggle,
  useNow,
  useToast,
} from '@aegis/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { listenWhileMounted } from '../platform/platform.ts';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { LabRun, LabStage, LabState, ServiceApi } from '../platform/service.ts';
import { takeLabCandidate } from './labCandidate.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

/** Abfrage-Abstand. */
export const LAB_POLL_MS = 2000;

const SECONDS = ['30', '60', '120', '300'] as const;
type Seconds = (typeof SECONDS)[number];

/** PNG anzeigen – gezeichnet auf ein Canvas (die CSP erlaubt keine `blob:`/`data:`-Bilder). */
function PngView({ bytes, label }: { readonly bytes: Uint8Array; readonly label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null || typeof createImageBitmap !== 'function') {
      setFailed(true);
      return;
    }
    let active = true;
    createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' })).then(
      (bitmap) => {
        if (!active) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
      },
      () => {
        if (active) {
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [bytes]);
  return failed ? (
    <p className="text-xs text-text-subtle">{label}</p>
  ) : (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      className="h-auto max-w-full rounded-md border border-border"
    />
  );
}

/** Bildschirmfotos eines Laufs: Stufe 1 aus dem Bericht, Stufe 2 live vom Desktop. */
function Screenshots({ run, service }: { readonly run: LabRun; readonly service: ServiceApi }) {
  const { t } = useT();
  const [images, setImages] = useState<readonly Uint8Array[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const names = run.state.state === 'done' ? run.state.report.screenshots : [];
  const live = run.stage === 'mini_sandbox' && run.state.state === 'running';
  if (names.length === 0 && !live) {
    return null;
  }
  const load = async () => {
    setBusy(true);
    setNote(null);
    try {
      const shots = live
        ? await service.labCaptureWindows(run.id)
        : await Promise.all(names.map((n) => service.labScreenshot(run.id, n)));
      setImages(shots);
      if (shots.length === 0) {
        setNote(t('lab.noWindows'));
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2">
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void load()}>
        {live ? t('lab.captureWindows') : t('lab.showScreenshots', { count: String(names.length) })}
      </Button>
      {note !== null && (
        <p className="text-xs text-text-subtle">
          <SafeText value={note} />
        </p>
      )}
      {images.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="lab-screenshots">
          {images.map((bytes, i) => (
            <PngView
              key={i}
              bytes={bytes}
              label={t('lab.screenshotLabel', { n: String(i + 1), sample: run.sample })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  const { t } = useT();
  return (
    <details className="rounded-lg border border-border bg-surface-1 px-3 py-2">
      <summary className="cursor-pointer text-sm text-text">
        {title} <span className="text-text-subtle">({count})</span>
      </summary>
      {count === 0 ? (
        <p className="mt-2 text-xs text-text-subtle">{t('lab.nothingObserved')}</p>
      ) : (
        <ul className="mt-2 space-y-1 text-xs text-text-muted">{children}</ul>
      )}
    </details>
  );
}

function RunReport({ run }: { readonly run: LabRun }) {
  const { t, language } = useT();
  if (run.state.state !== 'done') {
    return null;
  }
  const { report, assessment } = run.state;
  const change = (c: 'created' | 'modified' | 'deleted') => t(`lab.change.${c}`);
  return (
    <div className="mt-3 space-y-3" data-testid="lab-report">
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge level={assessment.risk} />
        <p className="text-sm text-text">
          <SafeText value={language === 'en' ? assessment.summaryEn : assessment.summaryDe} />
        </p>
      </div>
      {assessment.behaviors.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
          {assessment.behaviors.map((b) => (
            <li key={b}>{t(`lab.behavior.${b}`)}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-text-subtle">
        {report.end.type === 'exited'
          ? t('lab.end.exited', { code: String(report.end.code) })
          : report.end.type === 'timed_out'
            ? t('lab.end.timedOut')
            : t('lab.end.failed')}
        {report.end.type === 'failed' && (
          <>
            {' '}
            <SafeText value={report.end.message} />
          </>
        )}
      </p>
      {report.sha256 !== null && (
        <p className="text-xs text-text-subtle">
          SHA-256: <SafeText value={report.sha256} mono breakAll />
        </p>
      )}
      <div className="space-y-2">
        <Section title={t('lab.processes')} count={report.processes.length}>
          {report.processes.map((p) => (
            <li key={`${String(p.pid)}-${p.image}`}>
              <SafeText value={p.image} mono breakAll />{' '}
              <span className="text-text-subtle">PID {p.pid}</span>
              {p.commandLine !== null && (
                <span className="block">
                  <SafeText value={p.commandLine} mono breakAll />
                </span>
              )}
            </li>
          ))}
        </Section>
        <Section title={t('lab.files')} count={report.files.length}>
          {report.files.map((f, i) => (
            <li key={`${f.path}-${String(i)}`}>
              <span className="text-text-subtle">{change(f.change)}:</span>{' '}
              <SafeText value={f.path} mono breakAll />
              {f.entropy !== null && f.entropy >= 7.5 && (
                <span className="text-warn"> · {t('lab.highEntropy')}</span>
              )}
            </li>
          ))}
        </Section>
        <Section title={t('lab.registry')} count={report.registry.length}>
          {report.registry.map((r, i) => (
            <li key={`${r.key}-${r.value}-${String(i)}`}>
              <span className="text-text-subtle">{change(r.change)}:</span>{' '}
              <SafeText value={r.value === '' ? r.key : `${r.key}\\${r.value}`} mono breakAll />
              {r.data !== null && (
                <span className="block">
                  = <SafeText value={r.data} mono breakAll />
                </span>
              )}
            </li>
          ))}
        </Section>
        <Section title={t('lab.network')} count={report.network.length}>
          {report.network.map((n, i) => (
            <li key={`${n.remote}-${String(n.port)}-${String(i)}`}>
              <SafeText value={`${n.remote}:${String(n.port)}`} mono />{' '}
              <span className="text-text-subtle">
                {n.blocked ? t('lab.blocked') : t('lab.notBlocked')}
              </span>
            </li>
          ))}
        </Section>
      </div>
      {report.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-text-subtle">
          {report.notes.map((n, i) => (
            <li key={i}>
              <SafeText value={n} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunCard({ run, service }: { readonly run: LabRun; readonly service: ServiceApi }) {
  const { t, locale } = useT();
  const active = run.state.state === 'running' || run.state.state === 'preparing';
  const now = useNow(active ? 1000 : null);
  const started = new Date(run.started).getTime();
  const elapsed = Number.isNaN(started) ? 0 : Math.max(0, (now - started) / 1000);
  const progress = Math.min(1, run.seconds > 0 ? elapsed / run.seconds : 0);
  return (
    <li className="rounded-xl border border-border bg-surface-2 p-4" data-testid="lab-run">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text">
          <SafeText value={run.sample} breakAll />
        </span>
        <span className="text-xs text-text-subtle">
          {t(`lab.stage.${run.stage}`)} · {t('lab.secondsShort', { seconds: String(run.seconds) })}
          {' · '}
          {Number.isNaN(started) ? run.started : new Date(started).toLocaleString(locale)}
        </span>
      </div>
      <p className="mt-2 text-sm text-text-muted" data-state={run.state.state}>
        {t(`lab.state.${run.state.state}`)}
        {run.state.state === 'failed' && (
          <>
            {' '}
            <SafeText value={run.state.message} />
          </>
        )}
      </p>
      {run.state.state === 'running' && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-1"
          role="progressbar"
          aria-label={t('lab.progress')}
          aria-valuemin={0}
          aria-valuemax={run.seconds}
          aria-valuenow={Math.round(Math.min(elapsed, run.seconds))}
        >
          <div
            className="h-full origin-left bg-accent transition-transform duration-1000 ease-linear motion-reduce:transition-none"
            style={{ transform: `scaleX(${String(progress)})` }}
          />
        </div>
      )}
      <RunReport run={run} />
      <Screenshots run={run} service={service} />
    </li>
  );
}

export function LabPage() {
  const { t } = useT();
  const toast = useToast();
  const platform = usePlatform();
  const service = platform.service;
  const [state, setState] = useState<LabState | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(() => takeLabCandidate());
  const [stage, setStage] = useState<LabStage | null>(null);
  const [seconds, setSeconds] = useState<Seconds>('60');
  const [network, setNetwork] = useState(false);
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(async () => {
    if (service === null) {
      return;
    }
    try {
      setState(await service.labStatus());
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
      service.labStatus().then(
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
    const timer = window.setInterval(tick, LAB_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [service]);

  useEffect(
    () =>
      listenWhileMounted('Dateien ablegen', () =>
        platform.onFileDrop((event) => {
          if (event.type === 'drop') {
            setDragging(false);
            const [first] = event.paths;
            if (event.paths.length > 1) {
              toast.show({ tone: 'info', title: t('lab.onlyOne') });
            }
            if (first !== undefined) {
              setPath(first);
            }
          } else {
            setDragging(event.type === 'enter');
          }
        }),
      ),
    [platform, t, toast],
  );

  const flow = useConsentFlow(service, () => void refresh());

  const sandboxReady = state?.sandbox.enabled === true;
  const miniReady = state?.miniAvailable === true;
  // Vorgabe: Windows Sandbox, sonst Mini-Sandbox.
  const chosen: LabStage | null =
    stage ?? (sandboxReady ? 'windows_sandbox' : miniReady ? 'mini_sandbox' : null);
  const withNetwork = chosen === 'windows_sandbox' && network;

  const pick = async () => {
    if (platform.pickPaths === null) {
      return;
    }
    const [first] = await platform.pickPaths('files');
    if (first !== undefined) {
      setPath(first);
    }
  };

  const start = () => {
    if (service === null || path === null || chosen === null) {
      return;
    }
    void flow.start(() => service.proposeLabRun(path, chosen, Number(seconds), withNetwork));
  };

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.lab.eyebrow')}
        title={t('pages.lab.title')}
        description={t('lab.intro')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : (
        <>
          <Panel title={t('lab.status')} description={t('lab.honest')}>
            {down !== null && <ServiceNotice kind="down" detail={down} />}
            {state !== null && (
              <div className="space-y-2" data-testid="lab-status">
                <p className="text-sm text-text" data-state={sandboxReady ? 'on' : 'off'}>
                  {sandboxReady
                    ? t('lab.sandboxReady')
                    : state.sandbox.supported
                      ? t('lab.sandboxOff')
                      : t('lab.sandboxUnsupported')}
                </p>
                <p className="text-sm text-text-muted">
                  {miniReady ? t('lab.miniReady') : t('lab.miniUnavailable')}
                </p>
                {state.sandbox.supported && !sandboxReady && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void flow.start(() => service.proposeEnableSandbox())}
                  >
                    {t('lab.enableSandbox')}
                  </Button>
                )}
              </div>
            )}
          </Panel>

          <Panel title={t('lab.newRun')} description={t('lab.newRunHint')}>
            <div className="space-y-4">
              <div
                className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
                  dragging ? 'border-accent bg-surface-2' : 'border-border'
                }`}
                data-testid="lab-drop"
                data-dragging={dragging ? 'true' : 'false'}
              >
                <p className="text-sm text-text-muted">{t('lab.dropHint')}</p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="secondary"
                  disabled={platform.pickPaths === null}
                  onClick={() => void pick()}
                >
                  {t('lab.pickFile')}
                </Button>
                {path !== null && (
                  <p className="mt-3 text-sm text-text" data-testid="lab-path">
                    <SafeText value={path} mono breakAll />
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <SegmentedControl<LabStage>
                  label={t('lab.stageLabel')}
                  size="sm"
                  value={chosen ?? undefined}
                  onValueChange={setStage}
                  options={[
                    {
                      value: 'windows_sandbox',
                      label: t('lab.stage.windows_sandbox'),
                      disabled: !sandboxReady,
                    },
                    {
                      value: 'mini_sandbox',
                      label: t('lab.stage.mini_sandbox'),
                      disabled: !miniReady,
                    },
                  ]}
                />
                <SegmentedControl<Seconds>
                  label={t('lab.duration')}
                  size="sm"
                  value={seconds}
                  onValueChange={setSeconds}
                  options={SECONDS.map((s) => ({
                    value: s,
                    label: t('lab.secondsShort', { seconds: s }),
                  }))}
                />
              </div>
              {chosen === 'mini_sandbox' && (
                <p className="text-xs text-warn">{t('lab.miniWeaker')}</p>
              )}
              <Toggle
                checked={withNetwork}
                disabled={chosen !== 'windows_sandbox'}
                onCheckedChange={setNetwork}
                label={t('lab.networkToggle')}
                description={
                  chosen === 'windows_sandbox' ? t('lab.networkWarn') : t('lab.networkOnlyVm')
                }
              />
              <Button variant="primary" disabled={path === null || chosen === null} onClick={start}>
                {t('lab.start')}
              </Button>
              <p className="text-xs text-text-subtle">{t('lab.startHint')}</p>
            </div>
          </Panel>

          <Panel title={t('lab.runs')} description={t('lab.runsHint')}>
            {state !== null && state.runs.length === 0 && (
              <p className="text-sm text-text-muted" data-testid="lab-empty">
                {t('lab.noRuns')}
              </p>
            )}
            {state !== null && state.runs.length > 0 && (
              <ul className="space-y-3">
                {state.runs.map((run) => (
                  <RunCard key={run.id} run={run} service={service} />
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
