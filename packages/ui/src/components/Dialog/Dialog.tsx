import { motion } from 'motion/react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '../../hooks/usePresence.ts';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { IconClose } from '../../icons/icons.tsx';
import { durations, easings } from '../../tokens/tokens.ts';
import { cx } from '../../utils/cx.ts';
import { focusElement, getTabbableElements } from '../../utils/focus.ts';
import { IconButton } from '../Button/IconButton.tsx';
import { PortalContainerContext } from './portal.ts';

/** Warum ein Dialog geschlossen werden soll. */
export type DialogCloseReason = 'escape' | 'backdrop' | 'close-button';
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';
export type DialogTone = 'neutral' | 'accent' | 'warn' | 'danger';

export interface DialogProps {
  readonly open: boolean;
  /**
   * Der Dialog schließt sich nie selbst: Er meldet den Wunsch, der Aufrufer setzt `open`.
   */
  readonly onClose: (reason: DialogCloseReason) => void;
  /** Überschrift – benennt den Dialog (`aria-labelledby`). Pflicht. */
  readonly title: ReactNode;
  /** Überschrift nur für Screenreader (z. B. Befehlspalette). */
  readonly hideTitle?: boolean | undefined;
  /** Kleine Zeile über der Überschrift. */
  readonly eyebrow?: ReactNode;
  /** Beschreibung (`aria-describedby`). */
  readonly description?: ReactNode;
  /** Inhalt rechts neben der Überschrift (Plaketten, Frist). */
  readonly headerAside?: ReactNode;
  readonly children?: ReactNode;
  /** Fußzeile (Aktionen). */
  readonly footer?: ReactNode;
  /** `alertdialog` für Rückfragen, die eine Entscheidung verlangen. */
  readonly role?: 'dialog' | 'alertdialog' | undefined;
  readonly size?: DialogSize | undefined;
  readonly placement?: 'center' | 'top' | undefined;
  /** Farbige Kante oben (Hinweis auf Schwere). */
  readonly tone?: DialogTone | undefined;
  /** Element, das beim Öffnen den Fokus erhält (sonst `[data-autofocus]`, sonst das erste). */
  readonly initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** Klick auf den Hintergrund meldet `onClose('backdrop')` (Standard: an). */
  readonly closeOnBackdrop?: boolean | undefined;
  /** Schließen-Button oben rechts (Standard: an). */
  readonly showCloseButton?: boolean | undefined;
  readonly closeLabel?: string | undefined;
  /** Glas-Fläche (sparsam: Befehlspalette). */
  readonly glass?: boolean | undefined;
  /** Innenabstand des Inhalts (Standard: an). */
  readonly padded?: boolean | undefined;
  readonly className?: string | undefined;
  readonly bodyClassName?: string | undefined;
  readonly 'data-testid'?: string | undefined;
}

const sizeClasses: Readonly<Record<DialogSize, string>> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
};

const toneClasses: Readonly<Record<DialogTone, string>> = {
  neutral: 'bg-border-strong',
  accent: 'bg-accent',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

/** Offene Dialoge, oberster zuletzt – nur der oberste fängt Fokus ein. */
const dialogStack: HTMLElement[] = [];
/** Wohin der Fokus nach dem Schließen eines Dialogs zurückkehrt. */
const returnTargets = new WeakMap<HTMLElement, HTMLElement | null>();
let scrollLocks = 0;
let savedOverflow = '';

/**
 * Element, zu dem der Fokus später zurückkehren soll. Liegt der Fokus noch in einem Dialog,
 * der gerade schließt (z. B. Befehlspalette öffnet einen Dialog), wird dessen Ziel geerbt.
 */
function captureReturnTarget(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) {
    return null;
  }
  const closing = active.closest<HTMLElement>('[data-aegis-dialog-root][data-state="closed"]');
  if (closing !== null) {
    return returnTargets.get(closing) ?? null;
  }
  return active;
}

/**
 * Modaler Dialog: Portal in `document.body`, Fokusfalle (Tab/Umschalt+Tab), Escape meldet
 * `onClose('escape')`, der übrige Seiteninhalt ist `inert`, beim Schließen kehrt der Fokus
 * zum auslösenden Element zurück. Verschachtelte Dialoge stapeln sich korrekt.
 */
export function Dialog({
  open,
  onClose,
  title,
  hideTitle = false,
  eyebrow,
  description,
  headerAside,
  children,
  footer,
  role = 'dialog',
  size = 'md',
  placement = 'center',
  tone,
  initialFocusRef,
  closeOnBackdrop = true,
  showCloseButton = true,
  closeLabel = 'Schließen',
  glass = false,
  padded = true,
  className,
  bodyClassName,
  'data-testid': testId,
}: DialogProps) {
  const reduced = useReducedMotionPreference();
  const present = usePresence(open, reduced ? 0 : durations.fast);
  const titleId = useId();
  const descriptionId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Neuester Startfokus – ein Wechsel (z. B. nach Ablauf einer Frist) darf das Öffnen nicht
  // wiederholen (sonst gingen Rückgabeziel und Fokus verloren).
  const initialFocusLatest = useRef(initialFocusRef);
  useLayoutEffect(() => {
    initialFocusLatest.current = initialFocusRef;
  });
  const [rootNode, setRootNode] = useState<HTMLDivElement | null>(null);
  const attachRoot = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    setRootNode(node);
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!open || root === null || panel === null) {
      return undefined;
    }
    const previous = captureReturnTarget();
    returnFocusRef.current = previous;
    returnTargets.set(root, previous);

    // Hintergrund inert machen (nur Elemente, die wir selbst umstellen, werden zurückgesetzt).
    const madeInert: Element[] = [];
    for (const element of document.body.children) {
      if (element === root || element.contains(root) || element.hasAttribute('inert')) {
        continue;
      }
      if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') {
        continue;
      }
      element.setAttribute('inert', '');
      madeInert.push(element);
    }
    dialogStack.push(root);
    if (scrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLocks += 1;

    const initial =
      initialFocusLatest.current?.current ??
      panel.querySelector<HTMLElement>('[data-autofocus]') ??
      getTabbableElements(panel)[0] ??
      panel;
    focusElement(initial);

    // Fokus, der dennoch hinausgelangt (z. B. per Skript), zurückholen.
    const onFocusIn = (event: FocusEvent): void => {
      if (dialogStack.at(-1) !== root) {
        return;
      }
      if (event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      focusElement(getTabbableElements(panel)[0] ?? panel);
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      const index = dialogStack.lastIndexOf(root);
      if (index !== -1) {
        dialogStack.splice(index, 1);
      }
      for (const element of madeInert) {
        element.removeAttribute('inert');
      }
      scrollLocks -= 1;
      if (scrollLocks === 0) {
        document.body.style.overflow = savedOverflow;
      }
    };
  }, [open]);

  // Fokus zurückgeben – erst nach dem Commit (passiver Effekt), sonst stellt React den
  // zuvor fokussierten Knoten im Dialog wieder her. Liegt inzwischen ein anderer Dialog
  // oben, behält dieser den Fokus; hat die App den Fokus bewusst woandershin gesetzt,
  // bleibt er dort.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    return () => {
      const target = returnFocusRef.current;
      const root = rootRef.current;
      const top = dialogStack.at(-1);
      if (target === null || !target.isConnected) {
        return;
      }
      if (top !== undefined && !top.contains(target)) {
        return;
      }
      const active = document.activeElement;
      const movedElsewhere =
        active !== null &&
        active !== document.body &&
        active !== target &&
        (root === null || !root.contains(active));
      if (!movedElsewhere) {
        focusElement(target);
      }
    };
  }, [open]);

  if (!present || typeof document === 'undefined') {
    return null;
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (open) {
        onClose('escape');
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    event.stopPropagation();
    const tabbables = getTabbableElements(panel);
    const first = tabbables[0];
    const last = tabbables.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      focusElement(panel);
      return;
    }
    const active = document.activeElement;
    const outside = active === panel || !(active instanceof Node) || !panel.contains(active);
    if (event.shiftKey && (active === first || outside)) {
      event.preventDefault();
      focusElement(last);
    } else if (!event.shiftKey && (active === last || outside)) {
      event.preventDefault();
      focusElement(first);
    }
  };

  const hidden = { opacity: 0, scale: reduced ? 1 : 0.97, y: reduced ? 0 : 8 };
  const shown = { opacity: 1, scale: 1, y: 0 };

  return createPortal(
    <div
      ref={attachRoot}
      className="fixed inset-0 z-[80]"
      data-aegis-dialog-root=""
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      aria-hidden={open ? undefined : true}
      onKeyDown={onKeyDown}
    >
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-bg/75"
        initial={{ opacity: 0 }}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration: reduced ? 0 : durations.fast / 1000, ease: easings.standard }}
        onClick={() => {
          if (open && closeOnBackdrop) {
            onClose('backdrop');
          }
        }}
        data-part="backdrop"
      />
      <div
        className={cx(
          'pointer-events-none absolute inset-0 flex justify-center overflow-y-auto p-4 sm:p-6',
          placement === 'center' ? 'items-center' : 'items-start pt-[12vh]',
        )}
      >
        <motion.div
          ref={panelRef}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description === undefined ? undefined : descriptionId}
          tabIndex={-1}
          className={cx(
            'pointer-events-auto relative flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-border shadow-lg outline-none',
            glass ? 'glass' : 'bg-surface-1',
            sizeClasses[size],
            className,
          )}
          initial={hidden}
          animate={open ? shown : hidden}
          transition={
            reduced
              ? { duration: 0 }
              : { duration: durations.base / 1000, ease: open ? easings.enter : easings.exit }
          }
          data-testid={testId}
        >
          <PortalContainerContext value={rootNode}>
            {tone !== undefined && (
              <div
                aria-hidden="true"
                className={cx('absolute inset-x-0 top-0 h-0.5', toneClasses[tone])}
                data-part="tone"
                data-tone={tone}
              />
            )}
            {hideTitle ? (
              <h2 id={titleId} className="sr-only">
                {title}
              </h2>
            ) : (
              <div className="flex items-start gap-4 px-6 pt-5 pb-4">
                {/* Titel und Zusatz umbrechen auf schmalen Fenstern untereinander. */}
                <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1 basis-56">
                    {eyebrow !== undefined && (
                      <p className="mb-1 font-mono text-2xs tracking-caps text-text-subtle uppercase">
                        {eyebrow}
                      </p>
                    )}
                    <h2 id={titleId} className="text-lg font-semibold tracking-tight text-text">
                      {title}
                    </h2>
                    {description !== undefined && (
                      <p id={descriptionId} className="mt-1 text-sm text-text-muted">
                        {description}
                      </p>
                    )}
                  </div>
                  {headerAside !== undefined && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 pt-0.5">
                      {headerAside}
                    </div>
                  )}
                </div>
                {showCloseButton && (
                  <IconButton
                    label={closeLabel}
                    icon={<IconClose />}
                    size="sm"
                    className="-mt-0.5 -mr-2"
                    onClick={() => onClose('close-button')}
                  />
                )}
              </div>
            )}
            {hideTitle && description !== undefined && (
              <p id={descriptionId} className="sr-only">
                {description}
              </p>
            )}
            {children !== undefined && (
              <div
                className={cx(
                  'min-h-0 flex-1 overflow-y-auto',
                  padded && 'px-6 pb-5',
                  bodyClassName,
                )}
              >
                {children}
              </div>
            )}
            {footer !== undefined && (
              <div className="border-t border-border bg-surface-1 px-6 py-4">{footer}</div>
            )}
          </PortalContainerContext>
        </motion.div>
      </div>
    </div>,
    document.body,
  );
}
