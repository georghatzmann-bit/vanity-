import type { CSSProperties } from 'react';
import { lockup, lockupViewBox, markViewBox } from './geometry.ts';
import { MarkGraphic, WordmarkGraphic, type LogoAppearance, type LogoTone } from './LogoParts.tsx';
import { useSvgId } from './useSvgId.ts';

export interface AegisLogoProps {
  /** Höhe in px (oder CSS-Länge). Standard: 32. Die Breite folgt dem Seitenverhältnis. */
  readonly size?: number | string;
  /** `mark` = nur Bildzeichen, `full` = Bildzeichen + Schriftzug. */
  readonly variant?: 'mark' | 'full';
  /** `line` = Strichzeichnung (Standard), `solid` = gefülltes Icon mit ausgesparten Formen. */
  readonly appearance?: LogoAppearance;
  /** `accent` = Cyan-Verlauf aus den Tokens, `mono` = einfarbig in currentColor. */
  readonly tone?: LogoTone;
  /** Zugänglicher Name (Standard „AEGIS“). */
  readonly title?: string;
  /** Rein dekorativ (neben sichtbarem Text): versteckt vor Hilfstechnologien. */
  readonly decorative?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

function toCssLength(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value;
}

/**
 * AEGIS-Logo als Inline-SVG. Farben kommen aus den Design-Tokens (CSS-Variablen) bzw.
 * `currentColor`; der Schriftzug im Lockup übernimmt immer die aktuelle Textfarbe.
 */
export function AegisLogo({
  size = 32,
  variant = 'mark',
  appearance = 'line',
  tone = 'accent',
  title = 'AEGIS',
  decorative = false,
  className,
  style,
}: AegisLogoProps) {
  const idPrefix = useSvgId('aegis-logo');
  const titleId = `${idPrefix}-title`;
  const full = variant === 'full';
  const height = toCssLength(size);
  const aspect = lockup.width / lockup.height;

  const accessibility = decorative
    ? ({ 'aria-hidden': true, focusable: false } as const)
    : ({ role: 'img', 'aria-labelledby': titleId } as const);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={full ? lockupViewBox : markViewBox}
      className={className}
      style={{
        height,
        width: full ? `calc(${height} * ${aspect})` : height,
        flexShrink: 0,
        ...style,
      }}
      data-variant={variant}
      data-appearance={appearance}
      {...accessibility}
    >
      {!decorative && <title id={titleId}>{title}</title>}
      {full ? (
        <>
          <g transform={`translate(${lockup.markOffsetX} 0)`}>
            <MarkGraphic appearance={appearance} tone={tone} idPrefix={idPrefix} />
          </g>
          <g
            transform={`translate(${lockup.wordmarkX} ${lockup.wordmarkY}) scale(${lockup.wordmarkScale})`}
          >
            <WordmarkGraphic />
          </g>
        </>
      ) : (
        <MarkGraphic appearance={appearance} tone={tone} idPrefix={idPrefix} />
      )}
    </svg>
  );
}
