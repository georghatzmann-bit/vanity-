import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { IconCheck, IconDanger, IconWarning } from '../../icons/icons.tsx';
import type { IconComponent } from '../../icons/createIcon.tsx';
import { easings } from '../../tokens/tokens.ts';
import { cx } from '../../utils/cx.ts';
import { CountUp } from '../CountUp/CountUp.tsx';

/** Bewertungsbereiche des Scores. */
export type ScoreBand = 'low' | 'medium' | 'high';

/** Untergrenzen der Bereiche: ab 50 „medium“, ab 80 „high“. */
export const scoreBandThresholds = { medium: 50, high: 80 } as const;

export const scoreBandLabels: Readonly<Record<ScoreBand, string>> = {
  low: 'Kritisch',
  medium: 'Verbesserungswürdig',
  high: 'Gut',
};

const bandTone: Readonly<Record<ScoreBand, string>> = {
  low: 'text-danger',
  medium: 'text-warn',
  high: 'text-success',
};

const bandIcon: Readonly<Record<ScoreBand, IconComponent>> = {
  low: IconDanger,
  medium: IconWarning,
  high: IconCheck,
};

/** Bereich eines (auf 0–100 begrenzten) Scores. */
export function scoreBand(value: number): ScoreBand {
  if (value >= scoreBandThresholds.high) {
    return 'high';
  }
  if (value >= scoreBandThresholds.medium) {
    return 'medium';
  }
  return 'low';
}

/** Begrenzt auf 0–100 und rundet; ungültige Werte (NaN, ±∞) → `null` (nie raten). */
export function normalizeScore(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, value)));
}

export interface ScoreGaugeProps {
  /**
   * Score 0–100 – oder `null`, solange keine echten Messwerte existieren. Dann zeigt die
   * Anzeige neutral „–“ und eine Erklärung. Niemals einen Schätzwert übergeben.
   */
  readonly value: number | null;
  /** Name der Anzeige (sichtbar und zugänglich). Standard: „Sicherheits-Score“. */
  readonly label?: string | undefined;
  /** Durchmesser in px (Standard 200). */
  readonly size?: number | undefined;
  /** Text bei `null` (Standard: „Noch keine Daten“). */
  readonly unavailableText?: string | undefined;
  /** Erklärung bei `null` – ehrlich, warum es keinen Wert gibt. */
  readonly unavailableHint?: ReactNode;
  /** Eigene Bereichs-Beschriftungen. */
  readonly bandLabels?: Partial<Record<ScoreBand, string>> | undefined;
  /** Text „von 100“ unter der Zahl. */
  readonly outOfLabel?: string | undefined;
  /** Dezentes Leuchten hinter der Anzeige (nur für die Hero-Position). */
  readonly glow?: boolean | undefined;
  /**
   * Namen sichtbar über der Anzeige zeigen (Standard: aus – meist trägt die umgebende Karte
   * die Überschrift). Zugänglich benannt ist die Anzeige immer.
   */
  readonly showLabel?: boolean | undefined;
  readonly className?: string | undefined;
}

const VIEWBOX = 120;
const CENTER = VIEWBOX / 2;
const RADIUS = 48;
const STROKE = 7;
const START_ANGLE = 135;
const SWEEP = 270;

function polar(radius: number, angleDeg: number): readonly [number, number] {
  const angle = (angleDeg * Math.PI) / 180;
  return [CENTER + radius * Math.cos(angle), CENTER + radius * Math.sin(angle)];
}

const [startX, startY] = polar(RADIUS, START_ANGLE);
const [endX, endY] = polar(RADIUS, START_ANGLE + SWEEP);
const ARC_PATH = `M${startX.toFixed(2)} ${startY.toFixed(2)}A${RADIUS} ${RADIUS} 0 1 1 ${endX.toFixed(2)} ${endY.toFixed(2)}`;

/** Skalenstriche alle 10 Punkte; an den Bereichsgrenzen etwas länger. */
const TICK_PATH = Array.from({ length: 11 }, (_, index) => {
  const value = index * 10;
  const angle = START_ANGLE + (SWEEP * value) / 100;
  const major =
    value === 0 ||
    value === 100 ||
    value === scoreBandThresholds.medium ||
    value === scoreBandThresholds.high;
  const inner = RADIUS + STROKE / 2 + 2.5;
  const [x1, y1] = polar(inner, angle);
  const [x2, y2] = polar(inner + (major ? 4 : 2.25), angle);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
}).join('');

/**
 * Halbrunde Anzeige (270°) für den Sicherheits-Score mit hochzählender Zahl.
 * Der Bereich steht als Text mit eigenem Icon darunter (nie nur Farbe). Mit `value = null`
 * gibt es bewusst keinen Wert – nur „–“ und eine ehrliche Erklärung.
 */
export function ScoreGauge({
  value,
  label = 'Sicherheits-Score',
  size = 200,
  unavailableText = 'Noch keine Daten',
  unavailableHint = 'Es wird nichts geschätzt: Der Score entsteht erst aus echten Prüfergebnissen.',
  bandLabels,
  outOfLabel = 'von 100',
  glow = false,
  showLabel = false,
  className,
}: ScoreGaugeProps) {
  const reduced = useReducedMotionPreference();
  const score = normalizeScore(value);
  const band = score === null ? null : scoreBand(score);
  const labels = { ...scoreBandLabels, ...bandLabels };
  const BandIcon = band === null ? null : bandIcon[band];

  const caption = showLabel ? (
    <span className="mb-2 font-mono text-2xs tracking-caps text-text-subtle uppercase">
      {label}
    </span>
  ) : null;

  const gauge = (
    <div className="relative" style={{ width: size, height: size * 0.86 }}>
      {glow && score !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-[8%] rounded-full opacity-70"
          style={{
            background: 'radial-gradient(closest-side, var(--aegis-accent-glow), transparent)',
          }}
        />
      )}
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX * 0.86}`}
        className="relative block size-full overflow-visible"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d={TICK_PATH}
          className="stroke-border-strong"
          strokeWidth="1"
          strokeLinecap="round"
        />
        {score === null ? (
          <path
            d={ARC_PATH}
            fill="none"
            className="stroke-border-strong"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray="0.5 6"
            data-part="track-empty"
          />
        ) : (
          <path
            d={ARC_PATH}
            fill="none"
            className="stroke-surface-3"
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
        )}
        {score !== null && band !== null && (
          <motion.path
            d={ARC_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
            className={bandTone[band]}
            initial={{ pathLength: reduced ? score / 100 : 0 }}
            animate={{ pathLength: score / 100 }}
            transition={reduced ? { duration: 0 } : { duration: 0.9, ease: easings.enter }}
            data-part="value"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-[4%]">
        {score === null ? (
          <span
            aria-hidden="true"
            className="font-semibold text-text-subtle"
            style={{ fontSize: size * 0.26, lineHeight: 1.05 }}
          >
            –
          </span>
        ) : (
          <span
            className="font-semibold tracking-tight text-text"
            style={{ fontSize: size * 0.26, lineHeight: 1.05 }}
          >
            <CountUp value={score} />
          </span>
        )}
        <span className="text-2xs text-text-subtle">
          {score === null ? unavailableText : outOfLabel}
        </span>
      </div>
    </div>
  );

  if (score === null || band === null || BandIcon === null) {
    return (
      <div
        role="group"
        aria-label={label}
        className={cx('flex flex-col items-center text-center', className)}
        data-score="none"
      >
        {caption}
        {gauge}
        <p className="mt-1 max-w-[18rem] text-xs text-text-muted">{unavailableHint}</p>
      </div>
    );
  }

  const bandLabel = labels[band];
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score}
      aria-valuetext={`${score} ${outOfLabel} – ${bandLabel}`}
      className={cx('flex flex-col items-center text-center', className)}
      data-score={score}
      data-band={band}
    >
      {caption}
      {gauge}
      <p
        className={cx(
          'mt-1 inline-flex items-center gap-1.5 text-xs font-semibold [&_svg]:size-3.5',
          bandTone[band],
        )}
      >
        <BandIcon strokeWidth={2.25} />
        {bandLabel}
      </p>
    </div>
  );
}
