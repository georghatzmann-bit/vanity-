import type { ComponentPropsWithRef } from 'react';
import {
  IconCheck,
  IconDanger,
  IconEye,
  IconGamepad,
  IconInfo,
  IconTools,
} from '../../icons/icons.tsx';
import type { IconComponent } from '../../icons/createIcon.tsx';
import { riskLabels, type RiskLevel } from '../../tokens/risk.ts';
import { cx } from '../../utils/cx.ts';

/**
 * Icon je Risikostufe – jede Stufe hat eine eigene Form, damit die Einstufung nie nur über
 * die Farbe erkennbar ist (WCAG 1.4.1).
 */
export const riskIcons: Readonly<Record<RiskLevel, IconComponent>> = {
  clean: IconCheck,
  info: IconInfo,
  game: IconGamepad,
  risky: IconTools,
  suspicious: IconEye,
  dangerous: IconDanger,
};

const toneClasses: Readonly<Record<RiskLevel, string>> = {
  clean: 'text-risk-clean bg-risk-clean-subtle border-risk-clean/35',
  info: 'text-risk-info bg-risk-info-subtle border-risk-info/35',
  game: 'text-risk-game bg-risk-game-subtle border-risk-game/35',
  risky: 'text-risk-risky bg-risk-risky-subtle border-risk-risky/35',
  suspicious: 'text-risk-suspicious bg-risk-suspicious-subtle border-risk-suspicious/35',
  dangerous: 'text-risk-dangerous bg-risk-dangerous-subtle border-risk-dangerous/45',
};

const sizeClasses = {
  sm: 'h-5 gap-1 px-1.5 text-2xs [&_svg]:size-3',
  md: 'h-6 gap-1.5 px-2 text-xs [&_svg]:size-3.5',
} as const;

export interface RiskBadgeProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  readonly level: RiskLevel;
  readonly size?: 'sm' | 'md' | undefined;
  /** Eigene Beschriftung (Standard: deutsche Bezeichnung der Stufe, z. B. „Gefährlich“). */
  readonly label?: string | undefined;
  /** Icon anzeigen (Standard: an). */
  readonly showIcon?: boolean | undefined;
}

/** Einstufung als Plakette: Text + eigenes Icon + Farbe (nie nur Farbe). */
export function RiskBadge({
  level,
  size = 'md',
  label,
  showIcon = true,
  className,
  ...rest
}: RiskBadgeProps) {
  const Icon = riskIcons[level];
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full border font-semibold whitespace-nowrap',
        toneClasses[level],
        sizeClasses[size],
        className,
      )}
      data-level={level}
      {...rest}
    >
      {showIcon && <Icon strokeWidth={2.25} />}
      {label ?? riskLabels[level]}
    </span>
  );
}
