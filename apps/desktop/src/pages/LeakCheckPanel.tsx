/**
 * Leck-Check (P7.5): Passwort per k-Anonymität (nur fünf Zeichen des SHA-1-Werts gehen an
 * Have I Been Pwned) und E-Mail-Adresse mit dem eigenen HIBP-Schlüssel. Nur auf Knopfdruck;
 * Passwort und Schlüssel werden nicht gespeichert und nach der Prüfung aus dem Feld gelöscht.
 */
import { Button, Panel, SafeText } from '@aegis/ui';
import { useId, useState, type FormEvent } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { TextKey } from '../i18n/translator.ts';
import { leakErrorCode, pwnedCount, type EmailResult } from '../platform/leak.ts';
import { usePlatform } from '../platform/PlatformContext.tsx';

const inputClass =
  'mt-1 w-full max-w-sm rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-subtle';

const ERRORS = [
  'invalid_input',
  'windows_only',
  'unavailable',
  'invalid_key',
  'rate_limited',
] as const;
type ErrorCode = (typeof ERRORS)[number];
const errorCode = (code: string): ErrorCode =>
  (ERRORS as readonly string[]).includes(code) ? (code as ErrorCode) : 'unavailable';

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
}: {
  readonly label: string;
  readonly type: 'password' | 'email';
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
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

type PasswordState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly count: number }
  | { readonly kind: 'error'; readonly code: ErrorCode };

function PasswordCheck() {
  const { t, locale } = useT();
  const fetchRange = usePlatform().leakPasswordRange;
  const [password, setPassword] = useState('');
  const [state, setState] = useState<PasswordState>({ kind: 'idle' });
  if (fetchRange === null) {
    return null;
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password === '') {
      return;
    }
    const value = password;
    setPassword('');
    setState({ kind: 'busy' });
    pwnedCount(value, fetchRange).then(
      (count) => setState({ kind: 'done', count }),
      (err: unknown) => setState({ kind: 'error', code: errorCode(leakErrorCode(err)) }),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-2" data-testid="leak-password">
      <h3 className="font-medium text-text">{t('network.leak.passwordTitle')}</h3>
      <p className="text-text-muted">{t('network.leak.passwordIntro')}</p>
      <Field
        label={t('network.leak.password')}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="off"
      />
      <Button type="submit" size="sm" variant="secondary" loading={state.kind === 'busy'}>
        {t('network.leak.check')}
      </Button>
      <div role="status" aria-live="polite">
        {state.kind === 'done' &&
          (state.count > 0 ? (
            <p className="font-medium text-danger">
              {t('network.leak.passwordFound', {
                count: state.count.toLocaleString(locale),
              })}
            </p>
          ) : (
            <p className="text-success">{t('network.leak.passwordClean')}</p>
          ))}
        {state.kind === 'error' && (
          <p className="text-warn">{t(`network.leak.error.${state.code}` satisfies TextKey)}</p>
        )}
      </div>
    </form>
  );
}

type EmailState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly result: EmailResult }
  | { readonly kind: 'error'; readonly code: ErrorCode };

function EmailCheck() {
  const { t } = useT();
  const check = usePlatform().leakEmailCheck;
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const [state, setState] = useState<EmailState>({ kind: 'idle' });
  if (check === null) {
    return null;
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim() === '' || key.trim() === '') {
      return;
    }
    const apiKey = key;
    setKey('');
    setState({ kind: 'busy' });
    check(email, apiKey).then(
      (result) =>
        setState(
          result.status === 'error'
            ? { kind: 'error', code: errorCode(result.code) }
            : { kind: 'done', result },
        ),
      (err: unknown) => setState({ kind: 'error', code: errorCode(leakErrorCode(err)) }),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-2" data-testid="leak-email">
      <h3 className="font-medium text-text">{t('network.leak.emailTitle')}</h3>
      <p className="text-text-muted">{t('network.leak.emailIntro')}</p>
      <Field
        label={t('network.leak.email')}
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <Field
        label={t('network.leak.apiKey')}
        type="password"
        value={key}
        onChange={setKey}
        autoComplete="off"
      />
      <Button type="submit" size="sm" variant="secondary" loading={state.kind === 'busy'}>
        {t('network.leak.check')}
      </Button>
      <div role="status" aria-live="polite">
        {state.kind === 'done' && state.result.status === 'not_found' && (
          <p className="text-success">{t('network.leak.emailClean')}</p>
        )}
        {state.kind === 'done' && state.result.status === 'found' && (
          <>
            <p className="font-medium text-danger">
              {t('network.leak.emailFound', { count: String(state.result.breaches.length) })}
            </p>
            <ul className="mt-2 space-y-2" data-testid="leak-breaches">
              {state.result.breaches.map((b) => (
                <li key={b.name}>
                  <span className="font-medium text-text">
                    <SafeText value={b.title} />
                  </span>{' '}
                  <span className="text-text-subtle tabular-nums">{b.breachDate}</span>
                  {b.dataClasses.length > 0 && (
                    <p className="text-xs text-text-muted">
                      <SafeText value={b.dataClasses.join(', ')} />
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-text-muted">{t('network.leak.emailAdvice')}</p>
          </>
        )}
        {state.kind === 'error' && (
          <p className="text-warn">{t(`network.leak.error.${state.code}` satisfies TextKey)}</p>
        )}
      </div>
    </form>
  );
}

export function LeakCheckPanel() {
  const { t } = useT();
  const platform = usePlatform();
  return (
    <Panel title={t('network.leak.title')} description={t('network.leak.intro')}>
      <div className="space-y-6 text-sm" data-testid="leak-check">
        {platform.leakPasswordRange === null ? (
          <p className="text-text-muted">{t('network.leak.preview')}</p>
        ) : (
          <>
            <PasswordCheck />
            <EmailCheck />
          </>
        )}
        <p className="text-xs text-text-subtle">{t('network.leak.attribution')}</p>
      </div>
    </Panel>
  );
}
