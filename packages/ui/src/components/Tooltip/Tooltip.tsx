import { motion } from 'motion/react';
import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { durations, easings } from '../../tokens/tokens.ts';
import { cx } from '../../utils/cx.ts';
import { usePortalContainer } from '../Dialog/portal.ts';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /**
   * Inhalt – nur ergänzende Hinweise. Wesentliche Informationen gehören sichtbar in die
   * Oberfläche: Tooltips erreichen Touch-Nutzer nicht und verschwinden.
   */
  readonly content: ReactNode;
  /** Genau ein fokussierbares Element (Button, Link …); bekommt `aria-describedby`. */
  readonly children: ReactElement<{ 'aria-describedby'?: string | undefined }>;
  readonly placement?: TooltipPlacement | undefined;
  /** Verzögerung beim Überfahren mit der Maus (ms, Standard 350). Fokus zeigt sofort. */
  readonly delay?: number | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
}

const GAP = 8;
const VIEWPORT_MARGIN = 8;
const HIDE_DELAY = 120;

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Position des Tooltips (fixed) inkl. Umklappen, wenn auf der gewünschten Seite kein Platz ist. */
export function computeTooltipPosition(
  trigger: Rect,
  tooltip: { readonly width: number; readonly height: number },
  placement: TooltipPlacement,
  viewport: { readonly width: number; readonly height: number },
): { readonly top: number; readonly left: number; readonly placement: TooltipPlacement } {
  const fits: Record<TooltipPlacement, boolean> = {
    top: trigger.top - GAP - tooltip.height >= VIEWPORT_MARGIN,
    bottom:
      trigger.top + trigger.height + GAP + tooltip.height <= viewport.height - VIEWPORT_MARGIN,
    left: trigger.left - GAP - tooltip.width >= VIEWPORT_MARGIN,
    right: trigger.left + trigger.width + GAP + tooltip.width <= viewport.width - VIEWPORT_MARGIN,
  };
  const opposite: Record<TooltipPlacement, TooltipPlacement> = {
    top: 'bottom',
    bottom: 'top',
    left: 'right',
    right: 'left',
  };
  const resolved = fits[placement] || !fits[opposite[placement]] ? placement : opposite[placement];
  let top: number;
  let left: number;
  if (resolved === 'top' || resolved === 'bottom') {
    top =
      resolved === 'top' ? trigger.top - GAP - tooltip.height : trigger.top + trigger.height + GAP;
    left = trigger.left + trigger.width / 2 - tooltip.width / 2;
  } else {
    left =
      resolved === 'left' ? trigger.left - GAP - tooltip.width : trigger.left + trigger.width + GAP;
    top = trigger.top + trigger.height / 2 - tooltip.height / 2;
  }
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - tooltip.width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - tooltip.height - VIEWPORT_MARGIN);
  return {
    top: Math.min(Math.max(VIEWPORT_MARGIN, top), maxTop),
    left: Math.min(Math.max(VIEWPORT_MARGIN, left), maxLeft),
    placement: resolved,
  };
}

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Tooltip nach WCAG 1.4.13: erscheint bei Hover (verzögert) und Tastaturfokus (sofort),
 * bleibt beim Überfahren des Tooltips selbst offen, schließt mit Escape (ohne Fokus oder
 * Maus zu bewegen) und beim Verlassen. Der Inhalt ist per `aria-describedby` verknüpft.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 350,
  disabled = false,
  className,
}: TooltipProps) {
  const id = useId();
  const reduced = useReducedMotionPreference();
  const container = usePortalContainer();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visible = open && !disabled;

  const clearTimers = (): void => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
  };
  const show = (after: number): void => {
    clearTimers();
    if (after <= 0) {
      setOpen(true);
    } else {
      showTimer.current = setTimeout(() => setOpen(true), after);
    }
  };
  const hide = (after: number): void => {
    clearTimers();
    if (after <= 0) {
      setOpen(false);
    } else {
      hideTimer.current = setTimeout(() => setOpen(false), after);
    }
  };

  useEffect(() => () => clearTimeout(showTimer.current), []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // Escape schließt nur den Tooltip (Erfassungsphase: vor Dialogen und Paletten).
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [visible]);

  // Position direkt am DOM setzen (vor dem Zeichnen) und bei Scrollen/Größenänderung nachführen.
  useLayoutEffect(() => {
    if (!visible) {
      return undefined;
    }
    const place = (): void => {
      const wrapper = wrapperRef.current;
      const tooltip = tooltipRef.current;
      if (wrapper === null || tooltip === null) {
        return;
      }
      const position = computeTooltipPosition(
        wrapper.getBoundingClientRect(),
        { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
        placement,
        { width: window.innerWidth, height: window.innerHeight },
      );
      tooltip.style.top = `${position.top}px`;
      tooltip.style.left = `${position.left}px`;
      tooltip.dataset.placement = position.placement;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [visible, placement]);

  const describedBy = [children.props['aria-describedby'], visible ? id : undefined]
    .filter(Boolean)
    .join(' ');
  const trigger = cloneElement(children, {
    'aria-describedby': describedBy === '' ? undefined : describedBy,
  });

  const offset = reduced ? 0 : 4;
  const from: Record<TooltipPlacement, { x: number; y: number }> = {
    top: { x: 0, y: offset },
    bottom: { x: 0, y: -offset },
    left: { x: offset, y: 0 },
    right: { x: -offset, y: 0 },
  };

  return (
    <span
      ref={wrapperRef}
      className="inline-flex"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') {
          show(delay);
        }
      }}
      onPointerLeave={() => hide(HIDE_DELAY)}
      onFocus={(event: FocusEvent<HTMLSpanElement>) => {
        if (isFocusVisible(event.target)) {
          show(0);
        }
      }}
      onBlur={() => hide(0)}
    >
      {trigger}
      {visible &&
        container !== null &&
        createPortal(
          <motion.div
            ref={tooltipRef}
            id={id}
            role="tooltip"
            className={cx(
              'pointer-events-auto fixed top-0 left-0 z-[90] max-w-xs rounded-md border border-border-strong/60 bg-surface-3 px-2.5 py-1.5 text-xs leading-snug text-text shadow-md',
              className,
            )}
            initial={{ opacity: 0, ...from[placement] }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            transition={{ duration: durations.fast / 1000, ease: easings.enter }}
            onPointerEnter={() => clearTimers()}
            onPointerLeave={() => hide(HIDE_DELAY)}
          >
            {content}
          </motion.div>,
          container,
        )}
    </span>
  );
}
