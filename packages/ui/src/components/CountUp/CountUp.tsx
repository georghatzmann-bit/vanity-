import { useEffect, useRef, useState } from 'react';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { cx } from '../../utils/cx.ts';

export interface CountUpProps {
  /** Zielwert. */
  readonly value: number;
  /** Startwert beim ersten Einblenden (Standard 0). Spätere Änderungen zählen vom alten Wert. */
  readonly from?: number | undefined;
  /** Dauer in ms (Standard 900). 0 = sofort. */
  readonly duration?: number | undefined;
  /** Nachkommastellen (Standard 0). */
  readonly decimals?: number | undefined;
  /** Gebietsschema für die Zahlformatierung (Standard `de-DE`). */
  readonly locale?: string | undefined;
  /** Eigene Formatierung (überschreibt `decimals`/`locale`). */
  readonly format?: ((value: number) => string) | undefined;
  /**
   * Ansage des **Endwerts** für Screenreader. Standard `off` – Zwischenwerte werden nie
   * angesagt, der Endwert steht als verborgener Text bereit.
   */
  readonly live?: 'off' | 'polite' | undefined;
  readonly className?: string | undefined;
}

/** Schnell starten, weich auslaufen. */
function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

/**
 * Zählt eine Zahl hoch (requestAnimationFrame, tabellarische Ziffern – nichts springt).
 * Bei „Bewegung reduzieren“ erscheint sofort der Endwert.
 */
export function CountUp({
  value,
  from = 0,
  duration = 900,
  decimals = 0,
  locale = 'de-DE',
  format,
  live = 'off',
  className,
}: CountUpProps) {
  const reduced = useReducedMotionPreference();
  const instant = reduced || duration <= 0;
  const [display, setDisplay] = useState(from);
  const currentRef = useRef(from);

  useEffect(() => {
    if (instant) {
      currentRef.current = value;
      return undefined;
    }
    const start = currentRef.current;
    if (start === value) {
      return undefined;
    }
    let frame = 0;
    let startedAt: number | null = null;
    const tick = (timestamp: number): void => {
      startedAt ??= timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const next = start + (value - start) * easeOutCubic(progress);
      currentRef.current = next;
      setDisplay(next);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration, instant]);

  const formatValue = (number: number): string =>
    format === undefined
      ? number.toLocaleString(locale, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })
      : format(number);

  const shown = instant ? value : display;
  return (
    <span className={cx('tabular-nums', className)}>
      <span aria-hidden="true">{formatValue(shown)}</span>
      <span className="sr-only" aria-live={live} aria-atomic="true">
        {formatValue(value)}
      </span>
    </span>
  );
}
