/**
 * Datei-Safe: eigene Dateien passwortgeschützt verschlüsselt aufbewahren. Anlegen,
 * Hineinlegen und Herausholen sind Vorschläge des Dienstes und passieren erst nach „Ja“.
 * Das Passwort lebt hier nur im Eingabefeld und wird nach dem Absenden geleert; der Dienst
 * speichert es nie.
 */
import {
  Button,
  IconFile,
  IconLock,
  IconRefresh,
  IconUndo,
  Panel,
  SafeText,
  useToast,
} from '@aegis/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { SafeState } from '../platform/service.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

const inputClass =
  'mt-1 w-full max-w-sm rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-subtle';

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: 'new-password' | 'current-password';
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type="password"
        className={inputClass}
        value={value}
        autoComplete={autoComplete}
        spellCheck={false}
        maxLength={256}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function SafePage() {
  const { t, locale } = useT();
  const platform = usePlatform();
  const service = platform.service;
  const toast = useToast();
  const [state, setState] = useState<SafeState | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (service === null) {
      return;
    }
    try {
      setState(await service.safeStatus());
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
    service.safeStatus().then(
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

  const flow = useConsentFlow(service, () => void load());
  const clear = () => {
    setPassword('');
    setRepeat('');
  };
  const fail = (error: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('consentFlow.error'),
      description: error instanceof Error ? error.message : String(error),
    });
  const min = state?.minPassword ?? 10;
  const minutes = String(state?.idleMinutes ?? 10);

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (service === null) {
      return;
    }
    if ([...password].length < min) {
      toast.show({ tone: 'warn', title: t('safe.tooShort', { min: String(min) }) });
      return;
    }
    if (password !== repeat) {
      toast.show({ tone: 'warn', title: t('safe.mismatch') });
      return;
    }
    const chosen = password;
    clear();
    void flow.start(() => service.proposeSafeSetup(chosen));
  };

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (service === null || password === '') {
      return;
    }
    const entered = password;
    clear();
    setBusy(true);
    try {
      setState(await service.safeUnlock(entered));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    if (service === null) {
      return;
    }
    try {
      setState(await service.safeLock());
    } catch (error) {
      fail(error);
    }
  };

  const store = async () => {
    if (service === null || platform.pickPaths === null) {
      return;
    }
    const paths = await platform.pickPaths('files');
    if (paths.length > 0) {
      void flow.start(() => service.proposeSafeStore(paths));
    }
  };

  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
  };

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.safe.eyebrow')}
        title={t('pages.safe.title')}
        description={t('pages.safe.summary')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : (
        <>
          {down !== null && <ServiceNotice kind="down" detail={down} />}
          {state !== null && !state.exists && (
            <Panel title={t('safe.createTitle')} description={t('safe.honest')}>
              <form className="space-y-3" onSubmit={create} data-testid="safe-create">
                <p className="text-sm text-text-muted">
                  {t('safe.createIntro', { min: String(min) })}
                </p>
                <PasswordField
                  label={t('safe.password')}
                  value={password}
                  onChange={setPassword}
                  autoComplete="new-password"
                />
                <PasswordField
                  label={t('safe.repeat')}
                  value={repeat}
                  onChange={setRepeat}
                  autoComplete="new-password"
                />
                <Button type="submit" size="sm" iconStart={<IconLock />}>
                  {t('safe.create')}
                </Button>
              </form>
            </Panel>
          )}
          {state?.exists === true && !state.unlocked && (
            <Panel title={t('safe.unlockTitle')} description={t('safe.honest')}>
              <form
                className="space-y-3"
                onSubmit={(e) => void unlock(e)}
                data-testid="safe-unlock"
              >
                <p className="text-sm text-text-muted">{t('safe.unlockIntro', { minutes })}</p>
                <PasswordField
                  label={t('safe.password')}
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                />
                <Button type="submit" size="sm" loading={busy} iconStart={<IconLock />}>
                  {t('safe.unlock')}
                </Button>
              </form>
            </Panel>
          )}
          {state?.exists === true && state.unlocked && (
            <Panel
              title={t('pages.safe.tagline')}
              description={t('safe.unlocked', { minutes })}
              actions={
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconStart={<IconRefresh />}
                    onClick={() => void load()}
                  >
                    {t('safe.refresh')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    iconStart={<IconLock />}
                    onClick={() => void lock()}
                  >
                    {t('safe.lock')}
                  </Button>
                </div>
              }
            >
              <div className="space-y-4" data-testid="safe-open">
                <div className="space-y-1">
                  <Button
                    size="sm"
                    iconStart={<IconFile />}
                    disabled={platform.pickPaths === null}
                    onClick={() => void store()}
                  >
                    {t('safe.store')}
                  </Button>
                  <p className="text-xs text-text-subtle">{t('safe.storeHint')}</p>
                </div>
                {state.entries.length === 0 ? (
                  <p className="text-sm text-text-muted" data-testid="safe-empty">
                    {t('safe.empty')}
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {state.entries.map((e) => (
                      <li
                        key={e.id}
                        className="rounded-xl border border-border bg-surface-2 p-4"
                        data-testid="safe-entry"
                      >
                        <p className="text-sm text-text">
                          <SafeText value={e.originalPath} mono breakAll />
                        </p>
                        <p className="mt-1 text-xs text-text-subtle">
                          {t('safe.storedAt', { date: date(e.storedAt) })} ·{' '}
                          {t('safe.size', {
                            size: Math.max(1, Math.round(e.size / 1024)).toLocaleString(locale),
                          })}
                        </p>
                        <div className="mt-3">
                          <Button
                            size="sm"
                            iconStart={<IconUndo />}
                            onClick={() => void flow.start(() => service.proposeSafeRetrieve(e.id))}
                          >
                            {t('safe.retrieve')}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Panel>
          )}
        </>
      )}
      {flow.dialogs}
    </PageBody>
  );
}
