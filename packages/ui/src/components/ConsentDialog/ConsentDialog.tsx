import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useNow } from '../../hooks/useNow.ts';
import { IconClock, IconDanger, IconUndo, IconWarning } from '../../icons/icons.tsx';
import { cx } from '../../utils/cx.ts';
import { MAX_TIMEOUT_MS, formatCountdown, toEpochMs } from '../../utils/time.ts';
import { Button } from '../Button/Button.tsx';
import { Dialog, type DialogTone } from '../Dialog/Dialog.tsx';
import { RiskBadge } from '../RiskBadge/RiskBadge.tsx';
import { SafeText } from '../SafeText/SafeText.tsx';
import { useConsentAttention, useConsentSession } from './attention.ts';
import { ConsentTargetList } from './ConsentTargetList.tsx';
import { consentDialogLabelsDe, type ConsentDialogLabels } from './labels.ts';
import { TextSafetyHints } from './TextSafetyHints.tsx';
import type { ConsentDecision, ConsentDecisionMeta, ConsentPlan } from './types.ts';

/** Sperrzeit für „Ja, ausführen“ nach dem Öffnen (gegen Durchklicken und Doppelklick). */
export const CONSENT_GUARD_MS = 600;
/** Ab dieser Restzeit wird die Frist hervorgehoben. */
export const CONSENT_DEADLINE_WARN_MS = 60_000;

export interface ConsentDialogProps {
  readonly open: boolean;
  readonly plan: ConsentPlan;
  /**
   * Die Antwort des Nutzers – höchstens **einmal** je Öffnen und angezeigter Fassung des Plans,
   * nie nach Ablauf der Frist. Escape bedeutet „Nein“ (`decline`). `meta` nennt genau die
   * Fassung, die beim Klick sichtbar war (ID, Digest, Plan). Die Freigabe selbst erteilt nur
   * der Dienst.
   */
  readonly onDecision: (decision: ConsentDecision, meta: ConsentDecisionMeta) => void;
  /**
   * Schließen nach Ablauf der Frist (Button „Schließen“ oder Escape). Bedeutet: es wurde
   * nichts getan – nichts an den Dienst senden, der Plan ist dort bereits verfallen.
   */
  readonly onDismiss: () => void;
  /**
   * Wird einmal gemeldet, sobald die Frist ohne Antwort abgelaufen ist (z. B. fürs
   * Protokoll). Nach einer Antwort nie.
   */
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

/**
 * Fingerabdruck alles Angezeigten. Ändert sich irgendetwas davon (auch bei gleicher ID),
 * ist es für den Nutzer ein anderer Plan: neue Sperrzeit, neue Antwort.
 */
function planFingerprint(plan: ConsentPlan): string {
  return JSON.stringify([
    plan.id,
    plan.digest ?? null,
    plan.kindLabel,
    plan.severity,
    plan.targets,
    plan.what,
    plan.why,
    plan.consequence,
    plan.undo,
    String(toEpochMs(plan.expiresAt)),
    plan.parameters ?? [],
  ]);
}

function isSameLocalDay(first: number, second: number): boolean {
  const a = new Date(first);
  const b = new Date(second);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

interface CalloutProps {
  readonly id?: string | undefined;
  readonly tone: 'danger' | 'warn';
  readonly title: string;
  readonly children: ReactNode;
}

function Callout({ id, tone, title, children }: CalloutProps) {
  const Icon = tone === 'danger' ? IconDanger : IconWarning;
  return (
    <div
      id={id}
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
        <div className="mt-0.5 text-sm text-text">{children}</div>
      </div>
    </div>
  );
}

/** Wo der letzte Zeiger-Druck im Fuß begann – nur ein Druck nach der Sperrzeit zählt. */
interface PressStart {
  readonly key: string;
  readonly armed: boolean;
}

/**
 * Freigabe-Dialog – die Oberfläche der Goldenen Regel. Zeigt einen `ActionPlan` vollständig
 * (Was genau? Warum? Was passiert dann? Rückgängig?) und holt genau eine Antwort ein:
 * „Ja, ausführen“, „Nein“, „Ignorieren“ oder „Vertrauen“.
 *
 * Sicherheitsregeln (alle getestet):
 * - Der Startfokus liegt auf „Nein“, nie auf „Ja, ausführen“.
 * - „Ja, ausführen“ ist nach dem Öffnen `guardMs` gesperrt – und erneut nach jeder Änderung
 *   am angezeigten Plan (auch bei gleicher ID), sobald ein darüberliegender Dialog schließt
 *   und sobald das Fenster wieder sichtbar bzw. im Vordergrund ist. Die Sperrzeit läuft nur,
 *   solange der Dialog wirklich vorn liegt. Ein Mausklick zählt nur, wenn auch der Druck erst
 *   nach der Sperrzeit begann; gehaltene Tasten (Autorepeat) zählen auf keinem Knopf.
 *   Dieselbe Sperrzeit gilt für „Vertrauen“ und „Ignorieren“ (bleibende Folgen); nur „Nein“
 *   ist sofort möglich.
 * - Escape = „Nein“ (auch wenn der Fokus auf `body` gefallen ist). Ein Klick neben den Dialog
 *   tut nichts.
 * - Enter im Dialog löst nie „Ja“ aus (kein Formular, kein Standard-Button).
 * - Es wird höchstens eine Antwort je Sitzung gemeldet; danach sind alle Knöpfe gesperrt und
 *   der Dialog zeigt „Antwort gesendet“ – nie mehr „Abgelaufen“.
 * - Ist die Frist ohne Antwort abgelaufen (oder ungültig), zeigt der Dialog „Abgelaufen – es
 *   wurde nichts getan“, alle Antworten sind gesperrt; selbst ein Klick im selben Moment wird
 *   verworfen.
 * - Nicht umkehrbare Pläne und die Stufe „Gefährlich“ zeigen oben eine deutliche Warnung, auf
 *   die auch „Ja, ausführen“ verweist (`aria-describedby`); rot ist „Ja, ausführen“ nur bei
 *   nicht umkehrbaren Plänen.
 * - Fremde Texte (Pfade, Namen – auch in „Was genau?“ usw.) erscheinen nur über `SafeText`
 *   (⟨U+202E⟩-Marken, Bidi-Isolation) mit Hinweis auf unsichtbare Zeichen.
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
  // Begrenzt auf das, was setTimeout zuverlässig kann (sonst feuerte ein riesiger Wert sofort).
  const guard = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_GUARD_MS, Number.isFinite(guardMs) ? guardMs : CONSENT_GUARD_MS),
  );
  const noRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const warningId = `${hintId}-warning`;
  const whatId = `${hintId}-what`;
  const armingId = `${hintId}-arming`;

  // Sitzung = eine Öffnung mit genau diesem Inhalt: Sperrzeit und Antwort beginnen je neu.
  const { session, changedWhileOpen } = useConsentSession(open, planFingerprint(plan));
  // Nur wenn der Dialog wirklich vorn liegt, läuft die Sperrzeit; jede Rückkehr beginnt neu.
  const [onTop, setOnTop] = useState(false);
  const { active, activation } = useConsentAttention(open, onTop);
  const armKey = `${session}@${activation}`;

  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{
    readonly session: string;
    readonly decision: ConsentDecision;
  } | null>(null);
  const answeredRef = useRef<string | null>(null);
  const pressRef = useRef<PressStart | null>(null);
  const armed = active && armedKey === armKey;
  const decided = answer !== null && answer.session === session;

  const expiresAtMs = toEpochMs(plan.expiresAt);
  const validDeadline = Number.isFinite(expiresAtMs);
  const running = open && !decided;
  const now = useNow(running ? 1000 : null, running && validDeadline ? expiresAtMs : undefined);
  // Ungültige Frist = abgelaufen (im Zweifel nichts tun). Nach einer Antwort zählt die Frist
  // nicht mehr – „es wurde nichts getan“ wäre dann falsch.
  const expired = !decided && (!validDeadline || now >= expiresAtMs);
  const remaining = validDeadline ? expiresAtMs - now : 0;

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const id = setTimeout(() => setArmedKey(armKey), guard);
    return () => clearTimeout(id);
  }, [active, armKey, guard]);

  // Neuer Plan oder wieder vorn (Dialog darüber geschlossen, Fenster zurück): Fokus auf „Nein“.
  useEffect(() => {
    if (active) {
      noRef.current?.focus({ preventScroll: true });
    }
  }, [active, armKey]);

  const reportExpiry = useEffectEvent(() => {
    onExpire?.();
  });
  useEffect(() => {
    if (open && expired) {
      closeRef.current?.focus({ preventScroll: true });
      reportExpiry();
    }
  }, [open, expired, session]);

  const decide = (decision: ConsentDecision, event?: MouseEvent<HTMLButtonElement>): void => {
    if (!open || answeredRef.current === session) {
      return;
    }
    // Harte Prüfung im Moment des Klicks – unabhängig vom letzten Takt der Anzeige.
    if (!validDeadline || Date.now() >= expiresAtMs) {
      return;
    }
    // Alles außer „Nein“ hat bleibende Folgen (Ausführen, Vertrauensliste, nicht mehr
    // melden) und ist deshalb erst nach der Sperrzeit möglich.
    if (decision !== 'decline') {
      if (!armed) {
        return;
      }
      // Mausklick (`detail` > 0): Der Druck muss ebenfalls nach der Sperrzeit begonnen haben.
      // Sonst zählte ein Druck auf den noch gesperrten Knopf, der erst danach losgelassen wird.
      if (event !== undefined && event.detail > 0) {
        const press = pressRef.current;
        if (press === null || press.key !== armKey || !press.armed) {
          return;
        }
      }
    }
    answeredRef.current = session;
    setAnswer({ session, decision });
    onDecision(decision, { planId: plan.id, digest: plan.digest, plan });
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

  // Gehaltene Taste (Autorepeat) ist auf keinem Antwort-Knopf eine bewusste Antwort – etwa
  // wenn Enter auf dem Auslöser gehalten wird und der Fokus danach auf „Nein“ springt.
  const onFooterKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
    }
  };
  const onFooterPointerDownCapture = (): void => {
    pressRef.current = { key: armKey, armed };
  };

  const irreversible = plan.undo.type === 'irreversible';
  const hasWarning = irreversible || plan.severity === 'dangerous';
  const locked = expired || decided;
  const deadlineTime = validDeadline
    ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(expiresAtMs)
    : '';
  const deadlineDate =
    validDeadline && !isSameLocalDay(expiresAtMs, now)
      ? new Intl.DateTimeFormat(locale, {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }).format(expiresAtMs)
      : undefined;
  const decisionLabels: Readonly<Record<ConsentDecision, string>> = {
    execute: labels.execute,
    decline: labels.decline,
    ignore: labels.ignore,
    trust: labels.trust,
  };
  const executeDescription =
    [!armed && !locked ? armingId : undefined, hasWarning ? warningId : undefined]
      .filter((id) => id !== undefined)
      .join(' ') || undefined;

  const prose = (value: string): ReactNode => (
    <>
      <SafeText
        value={value}
        mono={false}
        breakAll={false}
        describeInvisible={labels.targets.describeInvisible}
      />
      <TextSafetyHints values={[value]} labels={labels.targets} />
    </>
  );

  const headerAside = (
    <>
      <RiskBadge level={plan.severity} size="sm" />
      {!expired && !decided && (
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
          <span className="sr-only">{labels.deadlineAccessible(deadlineTime, deadlineDate)}</span>
        </span>
      )}
    </>
  );

  const footer = (
    <div
      className="flex flex-col gap-3"
      onKeyDownCapture={onFooterKeyDownCapture}
      onPointerDownCapture={onFooterPointerDownCapture}
    >
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
      <div role="status">
        {decided && answer !== null && (
          <p className="text-sm text-text-muted" data-part="answered">
            {labels.answered(decisionLabels[answer.decision])}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
        <div className="flex gap-1">
          {allowTrust && (
            <Button
              variant="ghost"
              disabled={locked || !armed}
              aria-describedby={`${hintId}-trust`}
              onClick={(event) => decide('trust', event)}
            >
              {labels.trust}
            </Button>
          )}
          {allowIgnore && (
            <Button
              variant="ghost"
              disabled={locked || !armed}
              aria-describedby={`${hintId}-ignore`}
              onClick={(event) => decide('ignore', event)}
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
              onClick={(event) => decide('decline', event)}
            >
              {labels.decline}
            </Button>
          )}
          <Button
            variant={irreversible ? 'danger' : 'primary'}
            disabled={locked || !armed}
            aria-describedby={executeDescription}
            onClick={(event) => decide('execute', event)}
            data-consent="execute"
            className="overflow-hidden"
          >
            {labels.execute}
            {!armed && !locked && (
              <span
                key={armKey}
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
        <span id={armingId} className="sr-only">
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
      describedBy={hasWarning ? `${warningId} ${whatId}` : whatId}
      tone={dialogTone(plan)}
      size="lg"
      initialFocusRef={expired ? closeRef : noRef}
      closeOnBackdrop={false}
      showCloseButton={false}
      onStackTopChange={setOnTop}
      footer={footer}
      data-testid="consent-dialog"
    >
      {/* Inhalt ohne interaktive Standard-Aktion; Enter wird hier verworfen. */}
      <div className="flex flex-col gap-5" onKeyDown={onContentKeyDown} data-plan-id={plan.id}>
        <div role="status">
          {changedWhileOpen && (
            <Callout tone="warn" title={labels.planChangedTitle}>
              {labels.planChangedText}
            </Callout>
          )}
        </div>
        {plan.undo.type === 'irreversible' && (
          <Callout id={warningId} tone="danger" title={labels.irreversibleTitle}>
            {prose(plan.undo.warning)}
          </Callout>
        )}
        {!irreversible && plan.severity === 'dangerous' && (
          <Callout id={warningId} tone="danger" title={labels.dangerousTitle}>
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
          <dd id={whatId} className="text-sm text-text" data-part="what">
            {prose(plan.what)}
          </dd>
          <dt className="text-xs font-medium text-text-muted sm:pt-0.5">{labels.why}</dt>
          <dd className="text-sm text-text" data-part="why">
            {prose(plan.why)}
          </dd>
          <dt className="text-xs font-medium text-text-muted sm:pt-0.5">{labels.consequence}</dt>
          <dd className="text-sm text-text" data-part="consequence">
            {prose(plan.consequence)}
          </dd>
          <dt className="text-xs font-medium text-text-muted sm:pt-0.5">{labels.undo}</dt>
          <dd className="text-sm text-text" data-undo={plan.undo.type}>
            {plan.undo.type === 'reversible' ? (
              <div className="flex flex-col items-start gap-1.5">
                <span className="inline-flex h-5 items-center gap-1 rounded-full border border-risk-clean/35 bg-risk-clean-subtle px-2 text-2xs font-semibold text-risk-clean [&_svg]:size-3">
                  <IconUndo strokeWidth={2.25} />
                  {labels.reversible}
                </span>
                <div>{prose(plan.undo.how)}</div>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-1.5">
                <span className="inline-flex h-5 items-center gap-1 rounded-full border border-risk-dangerous/45 bg-risk-dangerous-subtle px-2 text-2xs font-semibold text-risk-dangerous [&_svg]:size-3">
                  <IconDanger strokeWidth={2.25} />
                  {labels.irreversible}
                </span>
                <div className="font-medium">{prose(plan.undo.warning)}</div>
              </div>
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
              {plan.parameters.map((parameter, index) => (
                <div key={`${index}-${parameter.label}`} className="contents">
                  <dt className="text-xs text-text-muted">
                    <SafeText
                      value={parameter.label}
                      mono={false}
                      breakAll={false}
                      describeInvisible={labels.targets.describeInvisible}
                    />
                  </dt>
                  <dd className="text-sm text-text">
                    <SafeText
                      value={parameter.value}
                      describeInvisible={labels.targets.describeInvisible}
                    />
                    <TextSafetyHints
                      values={[parameter.label, parameter.value]}
                      labels={labels.targets}
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
