import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useNow } from '../../hooks/useNow.ts';
import { IconClock, IconTrash } from '../../icons/icons.tsx';
import { cx } from '../../utils/cx.ts';
import { formatSecondsShort, toEpochMs, type TimeInput } from '../../utils/time.ts';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { useConsentAttention, useConsentSession } from './attention.ts';
import { ConsentTargetList } from './ConsentTargetList.tsx';
import { permanentDeleteLabelsDe, type PermanentDeleteLabels } from './labels.ts';
import type { ConsentTarget } from './types.ts';

/** Mindestabstand zwischen Öffnen und möglicher Bestätigung (wie `aegis-core`: 1,5 s). */
export const PERMANENT_DELETE_DELAY_MS = 1500;

/** Wozu genau bestätigt wurde – die Rückfrage, die beim Klick sichtbar war. */
export interface PermanentDeleteConfirmMeta {
  /** `challengeId` der angezeigten Rückfrage (falls angegeben). */
  readonly challengeId: string | undefined;
  /** Genau die angezeigten Ziele. */
  readonly targets: readonly ConsentTarget[];
}

export interface PermanentDeleteConfirmDialogProps {
  readonly open: boolean;
  /** Die Dateien, die endgültig gelöscht würden. */
  readonly targets: readonly ConsentTarget[];
  /**
   * Kennung der Rückfrage (z. B. aus `SecondConfirmationChallenge`). Wechselt sie – oder
   * wechseln Ziele oder Zeiten im offenen Dialog –, beginnt die Wartezeit neu. Sie kommt mit
   * `onConfirm` zurück.
   */
  readonly challengeId?: string | undefined;
  /**
   * Frühester Zeitpunkt der Bestätigung (`SecondConfirmationChallenge.not_before`). Der
   * Button wird frühestens dann **und** frühestens `delayMs` nach dem Öffnen freigegeben.
   */
  readonly notBefore?: TimeInput | undefined;
  /** Ende der Frist (`SecondConfirmationChallenge.expires_at`, ausschließlich). */
  readonly expiresAt?: TimeInput | undefined;
  /** Mindestwartezeit nach dem Öffnen in ms (Standard 1500, mindestens 1000). */
  readonly delayMs?: number | undefined;
  /**
   * „Endgültig löschen“ – entspricht `Decision::Execute` für die zweite Bestätigung. `meta`
   * nennt genau die angezeigte Rückfrage (ID und Ziele).
   */
  readonly onConfirm: (meta: PermanentDeleteConfirmMeta) => void;
  /** „Abbrechen“ oder Escape – es wird nichts gelöscht (`Decision::Decline`). */
  readonly onCancel: () => void;
  /** Schließen nach Ablauf – es wurde nichts gelöscht, nichts an den Dienst senden. */
  readonly onDismiss: () => void;
  readonly labels?: Partial<PermanentDeleteLabels> | undefined;
  readonly locale?: string | undefined;
}

const MIN_DELAY_MS = 1000;

/** Wo der letzte Zeiger-Druck im Fuß begann – nur ein Druck nach der Wartezeit zählt. */
interface PressStart {
  readonly key: string;
  readonly ready: boolean;
}

/**
 * Zweite, getrennte Bestätigung vor dem endgültigen Löschen (nach dem ersten „Ja“).
 *
 * Bewusst schlicht: deutlicher Titel „Endgültig löschen – kann nicht rückgängig gemacht
 * werden“, Countdown bis zur frühesten Bestätigung (Standard 1,5 s), danach ein expliziter
 * roter Button. Startfokus auf „Abbrechen“, Escape = Abbrechen. Kein Bestätigungswort zum
 * Eintippen: Das verlangsamt Tastatur- und Screenreader-Nutzer, ohne mehr Schutz zu bieten
 * als die getrennte zweite Rückfrage mit Wartezeit, die der Dienst ohnehin erzwingt.
 *
 * Die Wartezeit läuft nur, solange der Dialog wirklich vorn liegt (oberster Dialog, Fenster
 * sichtbar und im Vordergrund), und beginnt neu, wenn sich Ziele, Kennung oder Zeiten ändern.
 * Ein Mausklick zählt nur, wenn auch der Druck erst nach der Wartezeit begann.
 */
export function PermanentDeleteConfirmDialog({
  open,
  targets,
  challengeId,
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

  const notBeforeMs = notBefore === undefined ? Number.NEGATIVE_INFINITY : toEpochMs(notBefore);
  const expiresAtMs = expiresAt === undefined ? Number.POSITIVE_INFINITY : toEpochMs(expiresAt);
  const validTimes = !Number.isNaN(notBeforeMs) && !Number.isNaN(expiresAtMs);

  // Jede Öffnung und jede Änderung der Rückfrage ist eine eigene Sitzung.
  const { session, changedWhileOpen } = useConsentSession(
    open,
    JSON.stringify([challengeId ?? null, targets, String(notBeforeMs), String(expiresAtMs)]),
  );
  const [onTop, setOnTop] = useState(false);
  const { active, activation } = useConsentAttention(open, onTop);
  const armKey = `${session}@${activation}`;

  const [opened, setOpened] = useState<{ readonly key: string; readonly at: number } | null>(null);
  const [answeredSession, setAnsweredSession] = useState<string | null>(null);
  const answeredRef = useRef<string | null>(null);
  const pressRef = useRef<PressStart | null>(null);
  const openedAt = active && opened !== null && opened.key === armKey ? opened.at : null;
  const answered = answeredSession === session;

  // Beginn der Wartezeit erst nach dem Einhängen festhalten (kein Date.now() beim Rendern) –
  // und nur, solange der Dialog vorn liegt; jede Rückkehr beginnt neu.
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const id = setTimeout(() => setOpened({ key: armKey, at: Date.now() }), 0);
    return () => clearTimeout(id);
  }, [active, armKey]);

  const enableAt =
    openedAt === null ? Number.POSITIVE_INFINITY : Math.max(notBeforeMs, openedAt + delay);
  const running = open && !answered;
  const now = useNow(
    running ? 100 : null,
    running && Number.isFinite(enableAt) ? enableAt : undefined,
    running && Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
  );
  // Nach einer Antwort zählt die Frist nicht mehr – „nichts gelöscht“ wäre dann falsch.
  const expired = !answered && (!validTimes || now >= expiresAtMs);
  const ready = !expired && !answered && openedAt !== null && now >= enableAt;
  const waitMs = openedAt === null ? delay : Math.max(0, enableAt - now);

  // Neue Rückfrage oder wieder vorn: Fokus zurück auf „Abbrechen“.
  useEffect(() => {
    if (active) {
      cancelRef.current?.focus({ preventScroll: true });
    }
  }, [active, armKey]);

  const focusClose = useEffectEvent(() => {
    closeRef.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (open && expired) {
      focusClose();
    }
  }, [open, expired]);

  const answer = (confirm: boolean, event?: MouseEvent<HTMLButtonElement>): void => {
    if (!open || answeredRef.current === session) {
      return;
    }
    if (confirm) {
      // Harte Prüfung im Moment des Klicks.
      const current = Date.now();
      if (!validTimes || current >= expiresAtMs || openedAt === null || current < enableAt) {
        return;
      }
      // Mausklick: Der Druck muss ebenfalls nach der Wartezeit begonnen haben.
      if (event !== undefined && event.detail > 0) {
        const press = pressRef.current;
        if (press === null || press.key !== armKey || !press.ready) {
          return;
        }
      }
    }
    answeredRef.current = session;
    setAnsweredSession(session);
    if (confirm) {
      onConfirm({ challengeId, targets });
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

  // Gehaltene Taste (Autorepeat) zählt auf keinem Knopf.
  const onFooterKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
    }
  };
  const onFooterPointerDownCapture = (): void => {
    pressRef.current = { key: armKey, ready };
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
      onStackTopChange={setOnTop}
      data-testid="permanent-delete-dialog"
      footer={
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
              <div>
                <p className="text-sm font-semibold text-text">{labels.expiredTitle}</p>
                <p className="mt-0.5 text-xs text-text-muted">{labels.expiredText}</p>
              </div>
            </div>
          )}
          <div role="status">
            {answered && (
              <p className="text-sm text-text-muted" data-part="answered">
                {labels.answered}
              </p>
            )}
          </div>
          {!expired && !answered && (
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
                onClick={(event) => answer(false, event)}
              >
                {labels.cancel}
              </Button>
            )}
            <Button
              variant="danger"
              iconStart={<IconTrash />}
              disabled={!ready || answered}
              onClick={(event) => answer(true, event)}
              data-consent="confirm-delete"
            >
              {labels.confirm}
            </Button>
          </div>
        </div>
      }
    >
      <div role="status">
        {changedWhileOpen && (
          <p
            className="mb-3 rounded-lg border border-risk-suspicious/40 bg-risk-suspicious-subtle px-3 py-2 text-sm text-text"
            data-part="changed"
          >
            {labels.changed}
          </p>
        )}
      </div>
      <section aria-label={labels.targetsHeading(targets.length)}>
        <h3 className="mb-2 font-mono text-2xs tracking-caps text-text-subtle uppercase">
          {labels.targetsHeading(targets.length)}
        </h3>
        <ConsentTargetList targets={targets} labels={labels.targets} />
      </section>
    </Dialog>
  );
}
