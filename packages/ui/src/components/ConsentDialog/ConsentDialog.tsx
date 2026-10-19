import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNow } from '../../hooks/useNow.ts';
import { IconClock, IconDanger, IconUndo, IconWarning } from '../../icons/icons.tsx';
import { cx } from '../../utils/cx.ts';
import { formatCountdown, toEpochMs } from '../../utils/time.ts';
import { Button } from '../Button/Button.tsx';
import { Dialog, type DialogTone } from '../Dialog/Dialog.tsx';
import { RiskBadge } from '../RiskBadge/RiskBadge.tsx';
import { SafeText } from '../SafeText/SafeText.tsx';
import { ConsentTargetList } from './ConsentTargetList.tsx';
import { consentDialogLabelsDe, type ConsentDialogLabels } from './labels.ts';
import type { ConsentDecision, ConsentPlan } from './types.ts';

/** Sperrzeit für „Ja, ausführen“ nach dem Öffnen (gegen Durchklicken und Doppelklick). */
export const CONSENT_GUARD_MS = 600;
/** Ab dieser Restzeit wird die Frist hervorgehoben. */
export const CONSENT_DEADLINE_WARN_MS = 60_000;

export interface ConsentDialogProps {
  readonly open: boolean;
  readonly plan: ConsentPlan;
  /**
   * Die Antwort des Nutzers – höchstens **einmal** je Öffnen und Plan, nie nach Ablauf der
   * Frist. Escape bedeutet „Nein“ (`decline`). Die Freigabe selbst erteilt nur der Dienst.
   */
  readonly onDecision: (decision: ConsentDecision) => void;
  /**
   * Schließen nach Ablauf der Frist (Button „Schließen“ oder Escape). Bedeutet: es wurde
   * nichts getan – nichts an den Dienst senden, der Plan ist dort bereits verfallen.
   */
  readonly onDismiss: () => void;
  /** Wird einmal gemeldet, sobald die Frist abgelaufen ist (z. B. fürs Protokoll). */
  readonly onExpire?: (() => void) | undefined;
  /** „Ignorieren“ anbieten (Standard: an). */
  readonly allowIgnore?: boolean | undefined;
  /** „Vertrauen“ anbieten (Standard: an). */
  readonly allowTrust?: boolean | undefined;
  /** Sperrzeit für „Ja, ausführen“ in ms (Standard 600, mindestens 300). */
  readonly guardMs?: number | undefined;
  readonly labels?: Partial<ConsentDialogLabels> | undefined;
  /** Gebietsschema für Uhrzeiten (Standard `de-DE`). */
  readonly locale?: string | undefined;
}

/** Untergrenze der Sperrzeit – kürzer schützt nicht mehr vor einem Doppelklick. */
const MIN_GUARD_MS = 300;

function dialogTone(plan: ConsentPlan): DialogTone {
  if (plan.undo.type === 'irreversible' || plan.severity === 'dangerous') {
    return 'danger';
  }
  if (plan.severity === 'suspicious' || plan.severity === 'risky') {
    return 'warn';
  }
  return 'accent';
}

interface CalloutProps {
  readonly tone: 'danger' | 'warn';
  readonly title: string;
  readonly children: ReactNode;
}

function Callout({ tone, title, children }: CalloutProps) {
  const Icon = tone === 'danger' ? IconDanger : IconWarning;
  return (
    <div
      className={cx(
        'flex items-start gap-3 rounded-lg border px-3.5 py-3',
        tone === 'danger'
          ? 'border-risk-dangerous/45 bg-risk-dangerous-subtle'
          : 'border-risk-suspicious/40 bg-risk-suspicious-subtle',
      )}
      data-callout={tone}
    >
      <span
        aria-hidden="true"
        className={cx(
          'mt-0.5 inline-flex [&_svg]:size-[18px]',
          tone === 'danger' ? 'text-risk-dangerous' : 'text-risk-suspicious',
        )}
      >
        <Icon strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <p
          className={cx(
            'text-sm font-semibold',
            tone === 'danger' ? 'text-risk-dangerous' : 'text-risk-suspicious',
          )}
        >
          {title}
        </p>
        <p className="mt-0.5 text-sm text-text">{children}</p>
      </div>
    </div>
  );
}

/**
 * Freigabe-Dialog – die Oberfläche der Goldenen Regel. Zeigt einen `ActionPlan` vollständig
 * (Was genau? Warum? Was passiert dann? Rückgängig?) und holt genau eine Antwort ein:
 * „Ja, ausführen“, „Nein“, „Ignorieren“ oder „Vertrauen“.
 *
 * Sicherheitsregeln (alle getestet):
 * - Der Startfokus liegt auf „Nein“, nie auf „Ja, ausführen“.
 * - „Ja, ausführen“ ist nach dem Öffnen (und nach einem Planwechsel) `guardMs` gesperrt und
 *   reagiert nur auf einen bewussten Klick bzw. Tastendruck genau auf diesem Button –
 *   gehaltene Enter-Taste (Wiederholung) zählt nicht. Dieselbe Sperrzeit gilt für
 *   „Vertrauen“ und „Ignorieren“ (bleibende Folgen); nur „Nein“ ist sofort möglich.
 * - Escape = „Nein“. Ein Klick neben den Dialog tut nichts.
 * - Enter im Dialog löst nie „Ja“ aus (kein Formular, kein Standard-Button).
 * - Es wird höchstens eine Antwort je Öffnen gemeldet; danach sind alle Knöpfe gesperrt.
 * - Ist die Frist abgelaufen (oder ungültig), zeigt der Dialog „Abgelaufen – es wurde nichts
 *   getan“, alle Antworten sind gesperrt; selbst ein Klick im selben Moment wird verworfen.
 * - Nicht umkehrbare Pläne und die Stufe „Gefährlich“ zeigen eine deutliche Warnung;
 *   „Ja, ausführen“ ist dann rot.
 * - Fremde Texte (Pfade, Namen) erscheinen nur über `SafeText` (⟨U+202E⟩-Marken).
 */
export function ConsentDialog({
  open,
  plan,
  onDecision,
  onDismiss,
  onExpire,
  allowIgnore = true,
  allowTrust = true,
  guardMs = CONSENT_GUARD_MS,
  labels: labelOverrides,
  locale = 'de-DE',
}: ConsentDialogProps) {
  const labels: ConsentDialogLabels = { ...consentDialogLabelsDe, ...labelOverrides };
  const guard = Math.max(MIN_GUARD_MS, Number.isFinite(guardMs) ? guardMs : CONSENT_GUARD_MS);
  const noRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();

  // Jede Öffnung und jeder Plan ist eine eigene „Sitzung“: Sperrzeit und Antwort beginnen neu.
  const [generation, setGeneration] = useState(open ? 1 : 0);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setGeneration(generation + 1);
    }
  }
  const session = `${plan.id}#${generation}`;

  const [armedSession, setArmedSession] = useState<string | null>(null);
  const [decidedSession, setDecidedSession] = useState<string | null>(null);
  const decidedRef = useRef<string | null>(null);
  const armed = armedSession === session;
  const decided = decidedSession === session;

  const expiresAtMs = toEpochMs(plan.expiresAt);
  const validDeadline = Number.isFinite(expiresAtMs);
  const now = useNow(open ? 1000 : null, open && validDeadline ? expiresAtMs : undefined);
  // Ungültige Frist = abgelaufen (im Zweifel nichts tun).
  const expired = !validDeadline || now >= expiresAtMs;
  const remaining = validDeadline ? expiresAtMs - now : 0;

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const id = setTimeout(() => setArmedSession(session), guard);
    return () => clearTimeout(id);
  }, [open, session, guard]);

  // Planwechsel bei offenem Dialog: Fokus wieder auf „Nein“.
  useEffect(() => {
    if (open) {
      noRef.current?.focus({ preventScroll: true });
    }
  }, [open, session]);

  const reportExpiry = useEffectEvent(() => {
    onExpire?.();
  });
  useEffect(() => {
    if (open && expired) {
      closeRef.current?.focus({ preventScroll: true });
      reportExpiry();
    }
  }, [open, expired, session]);

  const decide = (decision: ConsentDecision): void => {
    if (!open || decidedRef.current === session) {
      return;
    }
    // Harte Prüfung im Moment des Klicks – unabhängig vom letzten Takt der Anzeige.
    if (!validDeadline || Date.now() >= expiresAtMs) {
      return;
    }
    // Alles außer „Nein“ hat bleibende Folgen (Ausführen, Vertrauensliste, nicht mehr
    // melden) und ist deshalb erst nach der Sperrzeit möglich.
    if (decision !== 'decline' && !armed) {
      return;
    }
    decidedRef.current = session;
    setDecidedSession(session);
    onDecision(decision);
  };

  // Schließen (Escape) heißt „Nein“ – nach Ablauf nur noch „Schließen, nichts getan“.
  const onClose = (): void => {
    if (expired) {
      onDismiss();
    } else {
      decide('decline');
    }
  };

  // Enter außerhalb eines Buttons (z. B. auf Text) tut nichts – nie ein „Standard-Ja“.
  const onContentKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
    }
  };

  const irreversible = plan.undo.type === 'irreversible';
  const locked = expired || decided;
  const deadlineTime = validDeadline
    ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(expiresAtMs)
    : '';

  const headerAside = (
    <>
      <RiskBadge level={plan.severity} size="sm" />
      {!expired && (
        <span
          className={cx(
            'inline-flex h-5 items-center gap-1 rounded-full border px-2 font-mono text-2xs font-medium tabular-nums [&_svg]:size-3',
            remaining <= CONSENT_DEADLINE_WARN_MS
              ? 'border-risk-risky/50 bg-risk-risky-subtle text-risk-risky'
              : 'border-border bg-surface-2 text-text-muted',
          )}
          data-part="deadline"
        >
          <IconClock strokeWidth={2.25} />
          {/* Die laufende Uhr ist nur optisch; vorgelesen wird die feste Uhrzeit. */}
          <time dateTime={new Date(expiresAtMs).toISOString()} aria-hidden="true">
            {labels.deadline(formatCountdown(remaining))}
          </time>
          <span className="sr-only">{labels.deadlineAccessible(deadlineTime)}</span>
        </span>
      )}
    </>
  );

  const footer = (
    <div className="flex flex-col gap-3">
      {expired && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-border-strong/60 bg-surface-2 px-3.5 py-3"
          data-part="expired"
        >
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex text-text-muted [&_svg]:size-[18px]"
          >
            <IconClock />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">{labels.expiredTitle}</p>
            <p className="mt-0.5 text-xs text-text-muted">{labels.expiredText}</p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
        <div className="flex gap-1">
          {allowTrust && (
            <Button
              variant="ghost"
              disabled={locked || !armed}
              aria-describedby={`${hintId}-trust`}
              onClick={() => decide('trust')}
            >
              {labels.trust}
            </Button>
          )}
          {allowIgnore && (
            <Button
              variant="ghost"
              disabled={locked || !armed}
              aria-describedby={`${hintId}-ignore`}
              onClick={() => decide('ignore')}
            >
              {labels.ignore}
            </Button>
          )}
        </div>
        {/* „Nein“ und „Ja, ausführen“ bleiben immer zusammen (auch beim Umbruch). */}
        <div className="ml-auto flex gap-2">
          {expired ? (
            <Button ref={closeRef} variant="secondary" onClick={onDismiss}>
              {labels.close}
            </Button>
          ) : (
            <Button
              ref={noRef}
              variant="secondary"
              disabled={decided}
              onClick={() => decide('decline')}
            >
              {labels.decline}
            </Button>
          )}
          <Button
            variant={irreversible ? 'danger' : 'primary'}
            disabled={locked || !armed}
            aria-describedby={!armed && !locked ? `${hintId}-arming` : undefined}
            onKeyDown={(event) => {
              // Gehaltene Taste (Autorepeat) ist keine bewusste Bestätigung.
              if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
              }
            }}
            onClick={() => decide('execute')}
            data-consent="execute"
            className="overflow-hidden"
          >
            {labels.execute}
            {!armed && !locked && (
              <span
                key={session}
                aria-hidden="true"
                className="absolute inset-x-2 bottom-1 h-px origin-left animate-aegis-fill bg-current opacity-60 motion-reduce:hidden"
                style={{ animationDuration: `${guard}ms` }}
                data-part="arming"
              />
            )}
          </Button>
        </div>
      </div>
      <p className="text-2xs text-text-subtle">
        <span>{labels.noResponseHint}</span>
        {allowIgnore && (
          <>
            {' · '}
            <span id={`${hintId}-ignore`}>{labels.ignoreHint}</span>
          </>
        )}
        {allowTrust && (
          <>
            {' · '}
            <span id={`${hintId}-trust`}>{labels.trustHint}</span>
          </>
        )}
        <span id={`${hintId}-arming`} className="sr-only">
          {labels.armingHint}
        </span>
      </p>
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      title={plan.kindLabel}
      eyebrow={labels.eyebrow}
      headerAside={headerAside}
      tone={dialogTone(plan)}
      size="lg"
      initialFocusRef={expired ? closeRef : noRef}
      closeOnBackdrop={false}
      showCloseButton={false}
      footer={footer}
      data-testid="consent-dialog"
    >
      {/* Inhalt ohne interaktive Standard-Aktion; Enter wird hier verworfen. */}
      <div className="flex flex-col gap-5" onKeyDown={onContentKeyDown} data-plan-id={plan.id}>
        {irreversible && plan.undo.type === 'irreversible' && (
          <Callout tone="danger" title={labels.irreversibleTitle}>
            {plan.undo.warning}
          </Callout>
        )}
        {!irreversible && plan.severity === 'dangerous' && (
          <Callout tone="danger" title={labels.dangerousTitle}>
            {labels.dangerousText}
          </Callout>
        )}

        <section aria-labelledby={`${hintId}-targets`}>
          <h3
            id={`${hintId}-targets`}
            className="mb-2 font-mono text-2xs tracking-caps text-text-subtle uppercase"
          >
            {labels.targetsHeading(plan.targets.length)}
          </h3>
          <ConsentTargetList targets={plan.targets} labels={labels.targets} />
        </section>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-xs font-medium text-text-muted sm:pt-0.5">{labels.what}</dt>
          <dd className="text-sm text-text">{plan.what}</dd>
          <dt className="text-xs font-medium text-text-muted sm:pt-0.5">{labels.why}</dt>
          <dd className="text-sm text-text">{plan.why}</dd>
          <dt className="text-xs font-medium text-text-muted sm:pt-0.5">{labels.consequence}</dt>
          <dd className="text-sm text-text">{plan.consequence}</dd>
          <dt className="text-xs font-medium text-text-muted sm:pt-0.5">{labels.undo}</dt>
          <dd className="text-sm text-text" data-undo={plan.undo.type}>
            {plan.undo.type === 'reversible' ? (
              <span className="flex flex-col items-start gap-1.5">
                <span className="inline-flex h-5 items-center gap-1 rounded-full border border-risk-clean/35 bg-risk-clean-subtle px-2 text-2xs font-semibold text-risk-clean [&_svg]:size-3">
                  <IconUndo strokeWidth={2.25} />
                  {labels.reversible}
                </span>
                <span>{plan.undo.how}</span>
              </span>
            ) : (
              <span className="flex flex-col items-start gap-1.5">
                <span className="inline-flex h-5 items-center gap-1 rounded-full border border-risk-dangerous/45 bg-risk-dangerous-subtle px-2 text-2xs font-semibold text-risk-dangerous [&_svg]:size-3">
                  <IconDanger strokeWidth={2.25} />
                  {labels.irreversible}
                </span>
                <span className="font-medium">{plan.undo.warning}</span>
              </span>
            )}
          </dd>
        </dl>

        {plan.parameters !== undefined && plan.parameters.length > 0 && (
          <section aria-labelledby={`${hintId}-parameters`}>
            <h3
              id={`${hintId}-parameters`}
              className="mb-2 font-mono text-2xs tracking-caps text-text-subtle uppercase"
            >
              {labels.parametersHeading}
            </h3>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
              {plan.parameters.map((parameter) => (
                <div key={parameter.label} className="contents">
                  <dt className="text-xs text-text-muted">{parameter.label}</dt>
                  <dd className="text-sm text-text">
                    <SafeText
                      value={parameter.value}
                      describeInvisible={labels.targets.describeInvisible}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </Dialog>
  );
}
