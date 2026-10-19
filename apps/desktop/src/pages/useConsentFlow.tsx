/**
 * Ablauf einer Freigabe: Vorschlag des Dienstes → Freigabe-Dialog → Antwort an den Dienst →
 * ggf. zweite Bestätigung (endgültig löschen) → Meldung. Die Oberfläche entscheidet nichts;
 * sie zeigt den Plan des Dienstes und reicht die Antwort mit dessen Einmal-Nonce zurück.
 */
import {
  ConsentDialog,
  PermanentDeleteConfirmDialog,
  useToast,
  type ConsentDecision,
} from '@aegis/ui';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { DecisionResult, Proposal, SecondChallenge, ServiceApi } from '../platform/service.ts';

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'consent'; readonly proposal: Proposal }
  | { readonly kind: 'second'; readonly proposal: Proposal; readonly challenge: SecondChallenge };

export interface ConsentFlow {
  /** Startet mit einem Vorschlag (oder einem Fehler beim Vorschlagen). */
  readonly start: (load: () => Promise<Proposal>) => Promise<void>;
  /** Dialoge (in die Seite einhängen). */
  readonly dialogs: ReactNode;
}

/** Ein Durchlauf; `onDone` nach jeder Ausführung (z. B. Liste neu laden). */
export function useConsentFlow(service: ServiceApi | null, onDone: () => void): ConsentFlow {
  const { t, locale } = useT();
  const toast = useToast();
  const dialogBase = useId().replace(/[^A-Za-z0-9]/g, '');
  const [step, setStep] = useState<Step>({ kind: 'idle' });

  const report = useCallback(
    (result: DecisionResult) => {
      switch (result.kind) {
        case 'executed':
          toast.show({
            tone: result.ok ? 'success' : 'warn',
            title: result.ok ? t('consentFlow.executed') : t('consentFlow.partial'),
            description: result.message ?? undefined,
          });
          onDone();
          break;
        case 'trusted':
          toast.show({ tone: 'info', title: t('consentFlow.trusted'), description: result.note });
          break;
        case 'nothing':
          toast.show({ tone: 'info', title: t('consentFlow.nothingDone') });
          break;
        case 'second':
          break;
      }
    },
    [onDone, t, toast],
  );

  const fail = useCallback(
    (error: unknown) => {
      toast.show({
        tone: 'danger',
        title: t('consentFlow.failed'),
        description: `${error instanceof Error ? error.message : String(error)} ${t('consentFlow.nothingDone')}`,
      });
    },
    [t, toast],
  );

  const start = useCallback(
    async (load: () => Promise<Proposal>) => {
      try {
        setStep({ kind: 'consent', proposal: await load() });
      } catch (error) {
        fail(error);
      }
    },
    [fail],
  );

  const answer = useCallback(
    async (proposal: Proposal, decision: ConsentDecision) => {
      setStep({ kind: 'idle' });
      if (service === null) {
        return;
      }
      try {
        const result = await service.decide(
          proposal,
          decision,
          `${dialogBase}-${proposal.plan.id.slice(0, 8)}`,
        );
        if (result.kind === 'second') {
          setStep({ kind: 'second', proposal, challenge: result.challenge });
        } else {
          report(result);
        }
      } catch (error) {
        fail(error);
      }
    },
    [dialogBase, fail, report, service],
  );

  const answerSecond = useCallback(
    async (challenge: SecondChallenge, decision: ConsentDecision) => {
      setStep({ kind: 'idle' });
      if (service === null) {
        return;
      }
      try {
        report(await service.confirmSecond(challenge, decision, `${dialogBase}-second`));
      } catch (error) {
        fail(error);
      }
    },
    [dialogBase, fail, report, service],
  );

  const dialogs = (
    <>
      {step.kind === 'consent' && (
        <ConsentDialog
          open
          plan={step.proposal.plan}
          allowTrust={step.proposal.allowTrust}
          locale={locale}
          onDecision={(decision) => void answer(step.proposal, decision)}
          onDismiss={() => setStep({ kind: 'idle' })}
        />
      )}
      {step.kind === 'second' && (
        <PermanentDeleteConfirmDialog
          open
          targets={step.proposal.plan.targets}
          challengeId={step.challenge.challengeId}
          notBefore={step.challenge.notBefore}
          expiresAt={step.challenge.expiresAt}
          locale={locale}
          onConfirm={() => void answerSecond(step.challenge, 'execute')}
          onCancel={() => void answerSecond(step.challenge, 'decline')}
          onDismiss={() => setStep({ kind: 'idle' })}
        />
      )}
    </>
  );

  return { start, dialogs };
}
