import { useId, type ReactNode, type Ref, type SVGProps } from 'react';

/** Strichstärke der AEGIS-Icons auf dem 24-px-Raster. */
export const ICON_STROKE_WIDTH = 1.75;
/** Rastergröße (viewBox) der AEGIS-Icons. */
export const ICON_GRID = 24;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'ref'> {
  /** Kantenlänge (px oder CSS-Länge). Standard: 24 (= Raster). */
  readonly size?: number | string | undefined;
  /**
   * Zugänglicher Name. Ohne `title` ist das Icon dekorativ (`aria-hidden`) – der Normalfall
   * neben sichtbarem Text. Mit `title` wird es zur Grafik mit Namen (`role="img"`).
   */
  readonly title?: string | undefined;
  /** Strichstärke im Raster (Standard 1,75). */
  readonly strokeWidth?: number | undefined;
  readonly ref?: Ref<SVGSVGElement> | undefined;
}

export type IconComponent = ((props: IconProps) => ReactNode) & { readonly displayName: string };

/**
 * Erzeugt eine Icon-Komponente aus Strich-Pfaden (24 × 24, `currentColor`, runde Enden).
 * Alle Icons sind eigene Zeichnungen für AEGIS – keine übernommenen Icon-Sätze.
 */
export function createIcon(displayName: string, paths: ReactNode): IconComponent {
  function Icon({
    size = ICON_GRID,
    title,
    strokeWidth = ICON_STROKE_WIDTH,
    ref,
    ...rest
  }: IconProps): ReactNode {
    const titleId = useId();
    const labelled = title !== undefined && title !== '';
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${ICON_GRID} ${ICON_GRID}`}
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
        data-icon={displayName}
        {...(labelled
          ? { role: 'img', 'aria-labelledby': titleId }
          : { 'aria-hidden': true as const })}
        {...rest}
      >
        {labelled && <title id={titleId}>{title}</title>}
        {paths}
      </svg>
    );
  }
  Icon.displayName = displayName;
  return Icon;
}
