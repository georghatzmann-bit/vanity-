import { motion } from 'motion/react';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { IconCheck, IconClose, IconDanger, IconInfo, IconWarning } from '../../icons/icons.tsx';
import type { IconComponent } from '../../icons/createIcon.tsx';
import { durations, easings } from '../../tokens/tokens.ts';
import { cx } from '../../utils/cx.ts';
import { Button } from '../Button/Button.tsx';
import { IconButton } from '../Button/IconButton.tsx';

export type ToastTone = 'info' | 'success' | 'warn' | 'danger';

export interface ToastAction {
  readonly label: string;
  readonly onAction: () => void;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | undefined;
}

export interface ToastOptions {
  /** Eigene ID (z. B. um eine Meldung zu ersetzen); sonst automatisch. */
  readonly id?: string | undefined;
  readonly tone?: ToastTone | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  /**
   * Aktionen. Eine Meldung mit Aktionen fragt nach einer Entscheidung und verschwindet
   * **nie** von selbst – unabhängig von `duration`.
   */
  readonly actions?: readonly ToastAction[] | undefined;
  /**
   * Anzeigedauer in ms. `null` = bleibt, bis sie geschlossen wird. Standard: 6 s,
   * bei `danger` bleibt sie stehen.
   */
  readonly duration?: number | null | undefined;
}

export interface ToastApi {
  /** Zeigt eine Meldung und gibt ihre ID zurück. Gleiche ID ersetzt die alte Meldung. */
  readonly show: (options: ToastOptions) => string;
  readonly dismiss: (id: string) => void;
  readonly clear: () => void;
}

export interface ToastLabels {
  /** Name der Benachrichtigungs-Region. */
  readonly region: string;
  /** Name des Schließen-Buttons einer Meldung. */
  readonly dismiss: string;
}

export const defaultToastLabels: ToastLabels = {
  region: 'Benachrichtigungen',
  dismiss: 'Meldung schließen',
};

interface ToastRecord {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly description: string | undefined;
  readonly actions: readonly ToastAction[];
  /** Restlaufzeit gesamt (ms) oder `null` = bleibt. */
  readonly duration: number | null;
  readonly closing: boolean;
  /** Steigt bei jedem `show` – eine ersetzte Meldung startet ihre Frist neu. */
  readonly version: number;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Zugriff auf die Meldungen der App (innerhalb von `<ToastProvider>`). */
export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (api === null) {
    throw new Error('useToast() braucht einen umgebenden <ToastProvider>.');
  }
  return api;
}

/** Ermittelt die Anzeigedauer nach den Sicherheitsregeln (Entscheidungen bleiben stehen). */
export function resolveToastDuration(
  options: ToastOptions,
  defaultDuration: number,
): number | null {
  if ((options.actions?.length ?? 0) > 0) {
    return null;
  }
  if (options.duration === null) {
    return null;
  }
  if (options.duration !== undefined) {
    return Number.isFinite(options.duration) && options.duration > 0 ? options.duration : null;
  }
  return options.tone === 'danger' ? null : defaultDuration;
}

const toneIcon: Readonly<Record<ToastTone, IconComponent>> = {
  info: IconInfo,
  success: IconCheck,
  warn: IconWarning,
  danger: IconDanger,
};

const toneText: Readonly<Record<ToastTone, string>> = {
  info: 'text-accent',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
};

const toneStripe: Readonly<Record<ToastTone, string>> = {
  info: 'bg-accent',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

export interface ToastProviderProps {
  readonly children?: ReactNode;
  /** Standarddauer in ms (Standard 6000). */
  readonly defaultDuration?: number | undefined;
  readonly labels?: Partial<ToastLabels> | undefined;
  /**
   * Abstand der Meldungen vom unteren Fensterrand (Zahl = px, sonst CSS-Länge). Standard
   * 16 px. Die App setzt ihn, damit Meldungen z. B. eine Statusleiste nicht verdecken.
   */
  readonly bottomOffset?: number | string | undefined;
  readonly className?: string | undefined;
}

let toastCounter = 0;

/**
 * Stellt `useToast()` bereit und rendert die Meldungen unten rechts.
 *
 * Ansagen: Eine höfliche Live-Region (`role="status"`) für normale Meldungen, eine
 * dringliche (`role="alert"`) nur für `danger`. Die Meldungen selbst sind nicht live,
 * damit Buttons darin nicht doppelt angesagt werden.
 * Selbstständiges Ausblenden pausiert, solange Maus oder Fokus auf den Meldungen liegen
 * oder das Fenster im Hintergrund ist; Meldungen mit Aktionen verschwinden nie von selbst.
 */
export function ToastProvider({
  children,
  defaultDuration = 6000,
  labels,
  bottomOffset,
  className,
}: ToastProviderProps) {
  const resolvedLabels = { ...defaultToastLabels, ...labels };
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [windowBlurred, setWindowBlurred] = useState(false);
  const reduced = useReducedMotionPreference();
  const removalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    removalTimers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      if (reduced) {
        remove(id);
        return;
      }
      setToasts((current) =>
        current.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast)),
      );
      if (!removalTimers.current.has(id)) {
        removalTimers.current.set(
          id,
          setTimeout(() => remove(id), durations.fast),
        );
      }
    },
    [reduced, remove],
  );

  const show = useCallback(
    (options: ToastOptions) => {
      toastCounter += 1;
      const id = options.id ?? `aegis-toast-${toastCounter}`;
      const pending = removalTimers.current.get(id);
      if (pending !== undefined) {
        clearTimeout(pending);
        removalTimers.current.delete(id);
      }
      const record: ToastRecord = {
        id,
        tone: options.tone ?? 'info',
        title: options.title,
        description: options.description,
        actions: options.actions ?? [],
        duration: resolveToastDuration(options, defaultDuration),
        closing: false,
        version: toastCounter,
      };
      setToasts((current) => [...current.filter((toast) => toast.id !== id), record]);
      return id;
    },
    [defaultDuration],
  );

  const clear = useCallback(() => {
    for (const timer of removalTimers.current.values()) {
      clearTimeout(timer);
    }
    removalTimers.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    const timers = removalTimers.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    const onBlur = (): void => setWindowBlurred(true);
    const onFocus = (): void => setWindowBlurred(false);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss, clear }), [show, dismiss, clear]);
  const paused = hovered || focused || windowBlurred;
  const visible = toasts.filter((toast) => !toast.closing);

  return (
    <ToastContext value={api}>
      {children}
      <section
        aria-label={resolvedLabels.region}
        className={cx(
          'pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2',
          className,
        )}
        style={
          bottomOffset === undefined
            ? undefined
            : { bottom: typeof bottomOffset === 'number' ? `${bottomOffset}px` : bottomOffset }
        }
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocused(false);
          }
        }}
        data-paused={paused || undefined}
      >
        <div role="status" aria-live="polite" className="sr-only" data-testid="toast-polite">
          {visible
            .filter((toast) => toast.tone !== 'danger')
            .map((toast) => (
              <p key={toast.id}>{announcement(toast)}</p>
            ))}
        </div>
        <div role="alert" aria-live="assertive" className="sr-only" data-testid="toast-assertive">
          {visible
            .filter((toast) => toast.tone === 'danger')
            .map((toast) => (
              <p key={toast.id}>{announcement(toast)}</p>
            ))}
        </div>
        {toasts.length > 0 && (
          <ol className="flex flex-col gap-2">
            {toasts.map((toast) => (
              <ToastItem
                key={`${toast.id}:${toast.version}`}
                toast={toast}
                paused={paused}
                reduced={reduced}
                dismissLabel={resolvedLabels.dismiss}
                onDismiss={dismiss}
              />
            ))}
          </ol>
        )}
      </section>
    </ToastContext>
  );
}

function announcement(toast: ToastRecord): string {
  return toast.description === undefined ? toast.title : `${toast.title}. ${toast.description}`;
}

interface ToastItemProps {
  readonly toast: ToastRecord;
  readonly paused: boolean;
  readonly reduced: boolean;
  readonly dismissLabel: string;
  readonly onDismiss: (id: string) => void;
}

function ToastItem({ toast, paused, reduced, dismissLabel, onDismiss }: ToastItemProps) {
  const remainingRef = useRef(toast.duration);
  const Icon = toneIcon[toast.tone];
  const { id, duration, closing } = toast;

  useEffect(() => {
    const remaining = remainingRef.current;
    if (paused || closing || remaining === null || duration === null) {
      return undefined;
    }
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(id), remaining);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remaining - (Date.now() - startedAt));
    };
  }, [paused, closing, duration, id, onDismiss]);

  const offset = reduced ? 0 : 12;
  return (
    <motion.li
      className="pointer-events-auto relative overflow-hidden rounded-lg border border-border bg-surface-2 shadow-lg"
      initial={{ opacity: 0, x: offset }}
      animate={closing ? { opacity: 0, x: offset } : { opacity: 1, x: 0 }}
      transition={{
        duration: reduced ? 0 : durations.base / 1000,
        ease: closing ? easings.exit : easings.enter,
      }}
      data-tone={toast.tone}
      data-persistent={duration === null || undefined}
      inert={closing}
    >
      <span
        aria-hidden="true"
        className={cx('absolute inset-y-0 left-0 w-0.5', toneStripe[toast.tone])}
      />
      <div className="flex items-start gap-3 py-3 pr-2 pl-4">
        <span
          aria-hidden="true"
          className={cx('mt-0.5 inline-flex [&_svg]:size-4', toneText[toast.tone])}
        >
          <Icon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text">{toast.title}</p>
          {toast.description !== undefined && (
            <p className="mt-0.5 text-xs text-text-muted">{toast.description}</p>
          )}
          {toast.actions.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {toast.actions.map((action) => (
                <Button
                  key={action.label}
                  size="sm"
                  variant={action.variant ?? 'secondary'}
                  onClick={() => {
                    action.onAction();
                    onDismiss(id);
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        <IconButton
          label={dismissLabel}
          icon={<IconClose />}
          size="sm"
          onClick={() => onDismiss(id)}
        />
      </div>
      {duration !== null && (
        <span
          aria-hidden="true"
          className={cx(
            'absolute inset-x-0 bottom-0 h-px origin-left animate-aegis-drain opacity-60 motion-reduce:hidden',
            toneStripe[toast.tone],
          )}
          style={{
            animationDuration: `${duration}ms`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
          data-part="timer"
        />
      )}
    </motion.li>
  );
}
