import type { CSSProperties } from 'react';
import { cx } from '../../utils/cx.ts';

export interface SkeletonProps {
  /** Breite (px oder CSS-Länge, Standard 100 %). */
  readonly width?: number | string | undefined;
  /** Höhe (px oder CSS-Länge, Standard 12 px). */
  readonly height?: number | string | undefined;
  readonly radius?: 'sm' | 'md' | 'lg' | 'full' | undefined;
  readonly className?: string | undefined;
}

const radiusClasses = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
} as const;

/**
 * Platzhalter-Fläche während des Ladens. Dekorativ (`aria-hidden`) – den Ladezustand meldet
 * der Container (`aria-busy="true"` plus Text wie „Wird geladen …“). Der Schimmer läuft per
 * transform; bei „Bewegung reduzieren“ entfällt er.
 */
export function Skeleton({ width = '100%', height = 12, radius = 'md', className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  return (
    <span
      aria-hidden="true"
      className={cx(
        'relative block overflow-hidden bg-surface-3',
        radiusClasses[radius],
        className,
      )}
      style={style}
      data-skeleton=""
    >
      <span className="absolute inset-0 animate-aegis-shimmer bg-linear-to-r from-transparent via-border/70 to-transparent motion-reduce:hidden" />
    </span>
  );
}

export interface SkeletonTextProps {
  /** Anzahl der Zeilen (Standard 3). */
  readonly lines?: number | undefined;
  readonly className?: string | undefined;
}

/** Mehrere Textzeilen als Platzhalter; die letzte ist kürzer. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  const count = Math.max(1, Math.floor(lines));
  return (
    <span aria-hidden="true" className={cx('flex flex-col gap-2', className)}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          key={index}
          height={10}
          width={index === count - 1 && count > 1 ? '62%' : '100%'}
        />
      ))}
    </span>
  );
}
