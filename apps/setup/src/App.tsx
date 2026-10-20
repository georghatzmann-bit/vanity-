/**
 * Setup-Assistent: Willkommen → Datenschutz → Ordner & Pakete → Laden/Prüfen/Installieren →
 * Fertig. Netz erst nach „Neueste Version suchen“, Laden erst nach „Laden und prüfen“,
 * Installieren erst nach „Installieren“. Fehler werden ehrlich gezeigt, nichts geschieht von
 * selbst.
 */
import { Button, SafeText, Toggle, getUiSound, useSoundEnabled } from '@aegis/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InstallShield } from './InstallShield.tsx';
import { megabytes, type Info, type Offer, type Progress, type SetupApi } from './api.ts';
import { text, type Lang, type TextKey } from './texts.ts';

type Step = 'welcome' | 'privacy' | 'options' | 'install' | 'done';
type Phase = 'idle' | 'downloading' | 'ready' | 'installing';

const STEPS: readonly { readonly id: Step; readonly key: TextKey }[] = [
  { id: 'welcome', key: 'stepWelcome' },
  { id: 'privacy', key: 'stepPrivacy' },
  { id: 'options', key: 'stepOptions' },
  { id: 'install', key: 'stepInstall' },
  { id: 'done', key: 'stepDone' },
];

export function App({ api, lang }: { readonly api: SetupApi; readonly lang: Lang }) {
  const t = useCallback(
    (key: TextKey, vars?: Record<string, string>) => text(lang, key, vars),
    [lang],
  );
  const [soundOn, setSoundOn] = useSoundEnabled();
  const [step, setStep] = useState<Step>('welcome');
  const [info, setInfo] = useState<Info | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [dir, setDir] = useState('');
  const [browser, setBrowser] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    api.info().then(
      (i) => {
        if (active) {
          setInfo(i);
          setDir(i.defaultDir);
        }
      },
      (e: unknown) => setError(String(e)),
    );
    let stop: (() => void) | undefined;
    void api
      .onProgress((p) => setProgress(p))
      .then((s) => {
        stop = s;
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [api]);

  // Neuer Schritt: Überschrift fokussieren (Screenreader hören, wo sie sind).
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    setBusy(false);
    getUiSound().alert();
  };

  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const check = () => {
    setBusy(true);
    setError(null);
    api.check().then((o) => {
      setOffer(o);
      setBusy(false);
    }, fail);
  };

  const download = () => {
    setError(null);
    setPhase('downloading');
    setStep('install');
    api.download(browser).then(
      () => setPhase('ready'),
      (e: unknown) => {
        setPhase('idle');
        fail(e);
      },
    );
  };

  const install = () => {
    setError(null);
    setPhase('installing');
    api.install().then(
      () => {
        setPhase('idle');
        setStep('done');
        getUiSound().bootChime();
      },
      (e: unknown) => {
        setPhase('ready');
        fail(e);
      },
    );
  };

  const canInstall = info !== null && info.enabled && info.windows;
  const shieldValue =
    phase === 'installing' || phase === 'ready'
      ? 1
      : progress !== null && progress.total > 0
        ? progress.done / progress.total
        : null;
  const progressText =
    progress === null
      ? ''
      : progress.stage === 'download'
        ? t('downloading', { name: progress.name })
        : progress.stage === 'verify'
          ? t('verifying', { name: progress.name })
          : t('verified', { name: progress.name });

  return (
    <div className="flex h-screen bg-surface text-text">
      <nav
        aria-label={t('steps')}
        className="w-48 shrink-0 border-r border-border bg-surface-2 p-5"
      >
        <ol className="space-y-3 text-sm">
          {STEPS.map((s, i) => {
            const current = s.id === step;
            const passed = STEPS.findIndex((x) => x.id === step) > i;
            return (
              <li
                key={s.id}
                aria-current={current ? 'step' : undefined}
                className={
                  current ? 'font-semibold text-accent' : passed ? 'text-text' : 'text-text-subtle'
                }
              >
                {passed ? '✓ ' : `${String(i + 1)}. `}
                {t(s.key)}
              </li>
            );
          })}
        </ol>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col p-8">
        {step === 'welcome' && (
          <section className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
            <InstallShield progress={null} label={t('progress')} />
            <h1 ref={heading} tabIndex={-1} className="outline-none text-2xl font-semibold">
              {t('welcome')}
            </h1>
            <p className="max-w-md text-sm text-text-muted">{t('welcomeText')}</p>
            <div className="flex items-center gap-4">
              <Toggle label={t('sound')} checked={soundOn} onCheckedChange={setSoundOn} />
              <Button
                variant="primary"
                onClick={() => {
                  // Klang nur nach einer Geste des Nutzers (und nur, wenn eingeschaltet).
                  getUiSound().bootChime();
                  go('privacy');
                }}
              >
                {t('start')}
              </Button>
            </div>
            {info !== null && <p className="text-2xs text-text-subtle">Setup {info.version}</p>}
          </section>
        )}

        {step === 'privacy' && (
          <section className="flex flex-1 flex-col gap-4">
            <h1 ref={heading} tabIndex={-1} className="outline-none text-xl font-semibold">
              {t('privacyTitle')}
            </h1>
            <ul className="list-disc space-y-2 pl-5 text-sm text-text-muted">
              <li>{t('privacy1')}</li>
              <li>{t('privacy2')}</li>
              <li>{t('privacy3')}</li>
              <li>{t('privacy4')}</li>
            </ul>
            <p className="text-sm text-warn">{t('smartscreen')}</p>
            <div className="mt-auto flex justify-between">
              <Button variant="ghost" onClick={() => go('welcome')}>
                {t('back')}
              </Button>
              <Button variant="primary" onClick={() => go('options')}>
                {t('next')}
              </Button>
            </div>
          </section>
        )}

        {step === 'options' && (
          <section className="flex flex-1 flex-col gap-4">
            <h1 ref={heading} tabIndex={-1} className="outline-none text-xl font-semibold">
              {t('optionsTitle')}
            </h1>
            {info !== null && !info.windows && (
              <p className="text-sm text-warn">{t('notWindows')}</p>
            )}
            {info !== null && !info.enabled && (
              <p className="text-sm text-warn" data-testid="disabled">
                {t('disabled')}
              </p>
            )}
            <div className="space-y-1 text-sm">
              <p className="font-medium">{t('dir')}</p>
              <p
                className="rounded-lg border border-border bg-surface-2 px-3 py-2"
                data-testid="install-dir"
              >
                <SafeText value={dir} mono={false} breakAll={false} />
              </p>
              <p className="text-xs text-text-subtle">{t('dirHint')}</p>
            </div>
            {offer === null ? (
              <Button
                variant="secondary"
                loading={busy}
                disabled={!canInstall}
                onClick={check}
                className="self-start"
              >
                {busy ? t('checking') : t('check')}
              </Button>
            ) : (
              <div className="space-y-2 text-sm" data-testid="offer">
                <p className="font-medium">
                  {t('offer', { version: offer.version })}
                  {offer.published !== '' && (
                    <span className="ml-2 text-xs font-normal text-text-subtle">
                      {t('published', { date: offer.published })}
                    </span>
                  )}
                </p>
                {offer.notes !== '' && (
                  <p className="whitespace-pre-line text-text-muted">
                    <SafeText value={offer.notes} mono={false} breakAll={false} />
                  </p>
                )}
                {offer.components.map((c) =>
                  c.kind === 'app' ? (
                    <p key={c.name} className="text-text-muted">
                      ✓ {t('app')} – {megabytes(c.size, lang)} ({t('required')})
                    </p>
                  ) : (
                    <Toggle
                      key={c.name}
                      label={`${t('browser')} – ${megabytes(c.size, lang)}`}
                      checked={browser}
                      onCheckedChange={setBrowser}
                    />
                  ),
                )}
              </div>
            )}
            <div className="mt-auto flex justify-between">
              <Button variant="ghost" onClick={() => go('privacy')}>
                {t('back')}
              </Button>
              <Button variant="primary" disabled={offer === null} onClick={download}>
                {t('downloadInstall')}
              </Button>
            </div>
          </section>
        )}

        {step === 'install' && (
          <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <InstallShield progress={shieldValue} label={t('progress')} />
            <h1 ref={heading} tabIndex={-1} className="outline-none text-xl font-semibold">
              {t('stepInstall')}
            </h1>
            <p role="status" className="min-h-5 text-sm text-text-muted">
              {phase === 'downloading' && (
                <SafeText value={progressText} mono={false} breakAll={false} />
              )}
              {phase === 'ready' && t('ready')}
              {phase === 'installing' && t('installing')}
            </p>
            {phase === 'ready' && (
              <>
                <p className="max-w-md text-xs text-text-subtle">{t('installHint')}</p>
                <Button variant="primary" onClick={install}>
                  {t('install')}
                </Button>
              </>
            )}
            {phase === 'idle' && error !== null && (
              <Button variant="secondary" onClick={() => go('options')}>
                {t('retry')}
              </Button>
            )}
          </section>
        )}

        {step === 'done' && (
          <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <InstallShield progress={1} done label={t('progress')} />
            <h1 ref={heading} tabIndex={-1} className="outline-none text-2xl font-semibold">
              {t('doneTitle')}
            </h1>
            <p className="max-w-md text-sm text-text-muted">{t('doneText')}</p>
            <Button variant="primary" onClick={() => api.launch().catch(fail)}>
              {t('launch')}
            </Button>
          </section>
        )}

        {error !== null && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-danger/40 bg-surface-2 p-3 text-sm"
          >
            <p className="font-medium text-danger">{t('error')}</p>
            <p className="text-text-muted">
              <SafeText value={error} mono={false} breakAll={false} />
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
