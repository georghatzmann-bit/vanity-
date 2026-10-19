import type { CSSProperties } from 'react';
import { wordmarkCapHeight, wordmarkViewBox, wordmarkWidth } from './geometry.ts';
import { WordmarkGraphic } from './LogoParts.tsx';
import { useSvgId } from './useSvgId.ts';

export interface AegisWordmarkProps {
  /** Versalhöhe in px (oder CSS-Länge). Standard: 14. */
  readonly height?: number | string;
  /** Zugänglicher Name (Standard „AEGIS“). */
  readonly title?: string;
  /** Rein dekorativ: versteckt vor Hilfstechnologien. */
  readonly decorative?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * Schriftzug „AEGIS“: eigene geometrische Versalien, weit gesperrt, Strichstärke 12 % der
 * Versalhöhe. Als Pfade gezeichnet (keine Schriftabhängigkeit), Farbe = currentColor.
 */
export function AegisWordmark({
  height = 14,
  title = 'AEGIS',
  decorative = false,
  className,
  style,
}: AegisWordmarkProps) {
  const titleId = `${useSvgId('aegis-wordmark')}-title`;
  const cssHeight = typeof height === 'number' ? `${height}px` : height;
  const accessibility = decorative
    ? ({ 'aria-hidden': true, focusable: false } as const)
    : ({ role: 'img', 'aria-labelledby': titleId } as const);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={wordmarkViewBox}
      className={className}
      style={{
        height: cssHeight,
        width: `calc(${cssHeight} * ${wordmarkWidth / wordmarkCapHeight})`,
        overflow: 'visible',
        flexShrink: 0,
        ...style,
      }}
      {...accessibility}
    >
      {!decorative && <title id={titleId}>{title}</title>}
      <WordmarkGraphic />
    </svg>
  );
}
