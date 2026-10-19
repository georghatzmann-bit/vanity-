import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useNow } from '../../hooks/useNow.ts';
import { IconClock, IconTrash } from '../../icons/icons.tsx';
import { cx } from '../../utils/cx.ts';
import { formatSecondsShort, toEpochMs, type TimeInput } from '../../utils/time.ts';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { ConsentTargetList } from './ConsentTargetList.tsx';
import { permanentDeleteLabelsDe, type PermanentDeleteLabels } from './labels.ts';
import type { ConsentTarget } from './types.ts';

/** Mindestabstand zwischen Öffnen und möglicher Bestätigung (wie `aegis-core`: 1,5 s). */
export const PERMANENT_DELETE_DELAY_MS = 1500;

export interface PermanentDeleteConfirmDialogProps {
  readonly open: boolean;
  /** Die Dateien, die endgültig gelöscht würden. */
  readonly targets: readonly ConsentTarget[];
  /**
   * Frühester Zeitpunkt der Bestätigung (`SecondConfirmationChallenge.not_before`). Der
   * Button wird frühestens dann **und** frühestens `delayMs` nach dem Öffnen freigegeben.
   */
  readonly notBefore?: TimeInput | undefined;
  /** Ende der Frist (`SecondConfirmationChallenge.expires_at`, ausschließlich). */
  readonly expiresAt?: TimeInput | undefined;
  /** Mindestwartezeit nach dem Öffnen in ms (Standard 1500, mindestens 1000). */
  readonly delayMs?: number | undefined;
  /** „Endgültig löschen“ – entspricht `Decision::Execute` für die zweite Bestätigung. */
  readonly onConfirm: () => void;
  /** „Abbrechen“ oder Escape – es wird nichts gelöscht (`Decision::Decline`). */
  readonly onCancel: () => void;
  /** Schließen nach Ablauf – es wurde nichts gelöscht, nichts an den Dienst senden. */
  readonly onDismiss: () => void;
  readonly labels?: Partial<PermanentDeleteLabels> | undefined;
  readonly locale?: string | undefined;
}

const MIN_DELAY_MS = 1000;

/**
 * Zweite, getrennte Bestätigung vor dem endgültigen Löschen (nach dem ersten „Ja“).
 *
 * Bewusst schlicht: deutlicher Titel „Endgültig löschen – kann nicht rückgängig gemacht
 * werden“, Countdown bis zur frühesten Bestätigung (Standard 1,5 s), danach ein expliziter
 * roter Button. Startfokus auf „Abbrechen“, Escape = Abbrechen. Kein Bestätigungswort zum
 * Eintippen: Das verlangsamt Tastatur- und Screenreader-Nutzer, ohne mehr Schutz zu bieten
 * als die getrennte zweite Rückfrage mit Wartezeit, die der Dienst ohnehin erzwingt.
 */
export function PermanentDeleteConfirmDialog({
  open,
  targets,
  notBefore,
  expiresAt,
  delayMs = PERMANENT_DELETE_DELAY_MS,
  onConfirm,
  onCancel,
  onDismiss,
  labels: labelOverrides,
  locale = 'de-DE',
}: PermanentDeleteConfirmDialogProps) {
  const labels: PermanentDeleteLabels = { ...permanentDeleteLabelsDe, ...labelOverrides };
  const delay = Math.max(
    MIN_DELAY_MS,
    Number.isFinite(delayMs) ? delayMs : PERMANENT_DELETE_DELAY_MS,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Jede Öffnung ist eine eigene „Generation“: Wartezeit und Antwort beginnen neu.
  const [generation, setGeneration] = useState(open ? 1 : 0);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setGeneration(generation + 1);
    }
  }
  const [opened, setOpened] = useState<{ readonly generation: number; readonly at: number } | null>(
    null,
  );
  const [answeredGeneration, setAnsweredGeneration] = useState<number | null>(null);
  const answeredRef = useRef<number | null>(null);
  const openedAt = opened !== null && opened.generation === generation ? opened.at : null;
  const answered = answeredGeneration === generation;

  // Öffnungszeitpunkt erst nach dem Einhängen festhalten (kein Date.now() beim Rendern).
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const id = setTimeout(() => setOpened({ generation, at: Date.now() }), 0);
    return () => clearTimeout(id);
  }, [open, generation]);

  const notBeforeMs = notBefore === undefined ? Number.NEGATIVE_INFINITY : toEpochMs(notBefore);
  const expiresAtMs = expiresAt === undefined ? Number.POSITIVE_INFINITY : toEpochMs(expiresAt);
  const validTimes = !Number.isNaN(notBeforeMs) && !Number.isNaN(expiresAtMs);
  const enableAt =
    openedAt === null ? Number.POSITIVE_INFINITY : Math.max(notBeforeMs, openedAt + delay);
  const tickMs = open ? 100 : null;
  const now = useNow(
    tickMs,
    open && Number.isFinite(enableAt) ? enableAt : undefined,
    open && Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
  );
  const expired = !validTimes || now >= expiresAtMs;
  const ready = !expired && openedAt !== null && now >= enableAt;
  const waitMs = openedAt === null ? delay : Math.max(0, enableAt - now);

  const focusClose = useEffectEvent(() => {
    closeRef.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (open && expired) {
      focusClose();
    }
  }, [open, expired]);

  const answer = (confirm: boolean): void => {
    if (!open || answeredRef.current === generation) {
      return;
    }
    if (confirm) {
      // Harte Prüfung im Moment des Klicks.
      const current = Date.now();
      if (!validTimes || current >= expiresAtMs || openedAt === null || current < enableAt) {
        return;
      }
    }
    answeredRef.current = generation;
    setAnsweredGeneration(generation);
    if (confirm) {
      onConfirm();
    } else {
      onCancel();
    }
  };

  // Schließen (Escape) heißt „Abbrechen“ – nach Ablauf nur noch „Schließen, nichts gelöscht“.
  const onClose = (): void => {
    if (expired) {
      onDismiss();
    } else {
      answer(false);
    }
  };

  const progress = delay > 0 ? 1 - Math.min(1, waitMs / delay) : 1;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      eyebrow={labels.eyebrow}
      title={labels.title}
      description={labels.description}
      tone="danger"
      size="md"
      initialFocusRef={expired ? closeRef : cancelRef}
      closeOnBackdrop={false}
      showCloseButton={false}
      data-testid="permanent-delete-dialog"
      footer={
        <div className="flex flex-col gap-3">
          {expired ? (
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
              <div>
                <p className="text-sm font-semibold text-text">{labels.expiredTitle}</p>
                <p className="mt-0.5 text-xs text-text-muted">{labels.expiredText}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3" data-part="countdown">
              <span
                aria-hidden="true"
                className="relative h-1 flex-1 overflow-hidden rounded-full bg-surface-3"
              >
                <span
                  className={cx(
                    'absolute inset-0 origin-left rounded-full transition-transform duration-100 ease-linear motion-reduce:transition-none',
                    ready ? 'bg-danger' : 'bg-border-strong',
                  )}
                  style={{ transform: `scaleX(${progress})` }}
                />
              </span>
              <p className="shrink-0 text-xs text-text-muted tabular-nums" aria-live="off">
                {ready ? labels.ready : labels.waiting(formatSecondsShort(waitMs, locale))}
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {expired ? (
              <Button ref={closeRef} variant="secondary" onClick={onDismiss}>
                {labels.close}
              </Button>
            ) : (
              <Button
                ref={cancelRef}
                variant="secondary"
                disabled={answered}
                onClick={() => answer(false)}
              >
                {labels.cancel}
              </Button>
            )}
            <Button
              variant="danger"
              iconStart={<IconTrash />}
              disabled={!ready || answered}
              onKeyDown={(event) => {
                if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                }
              }}
              onClick={() => answer(true)}
              data-consent="confirm-delete"
            >
              {labels.confirm}
            </Button>
          </div>
        </div>
      }
    >
      <section aria-label={labels.targetsHeading(targets.length)}>
        <h3 className="mb-2 font-mono text-2xs tracking-caps text-text-subtle uppercase">
          {labels.targetsHeading(targets.length)}
        </h3>
        <ConsentTargetList targets={targets} labels={labels.targets} />
      </section>
    </Dialog>
  );
}
