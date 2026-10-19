import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../utils/cx.ts';

/** Flächen-Ebene: 1 = Karte auf dem Hintergrund, 2/3 = darin verschachtelt bzw. hervorgehoben. */
export type SurfaceLevel = 1 | 2 | 3;
export type SurfacePadding = 'none' | 'sm' | 'md' | 'lg';

const levelClasses: Readonly<Record<SurfaceLevel, string>> = {
  1: 'bg-surface-1',
  2: 'bg-surface-2',
  3: 'bg-surface-3',
};

const paddingClasses: Readonly<Record<SurfacePadding, string>> = {
  none: '',
  sm: 'p-3',
  md: 'p-5',
  lg: 'p-6',
};

interface SurfaceOptions {
  readonly level?: SurfaceLevel | undefined;
  /** Glas nur sparsam (Overlays); fällt ohne backdrop-filter auf eine deckende Fläche zurück. */
  readonly glass?: boolean | undefined;
  /** Leuchten nur für aktive/hervorgehobene Elemente (z. B. Hero-Karte). */
  readonly glow?: boolean | undefined;
}

/** Klassen einer AEGIS-Fläche (1-px-Rahmen, Kante oben, Ebene, optional Glas/Leuchten). */
export function surfaceClasses({ level = 1, glass = false, glow = false }: SurfaceOptions): string {
  return cx(
    'rounded-xl border border-border shadow-bevel',
    glass ? 'glass' : levelClasses[level],
    glow && 'shadow-glow',
  );
}

export interface CardProps extends ComponentPropsWithRef<'div'>, SurfaceOptions {
  readonly padding?: SurfacePadding | undefined;
}

/** Schlichte Fläche ohne Kopfzeile. */
export function Card({
  level,
  glass,
  glow,
  padding = 'md',
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cx(surfaceClasses({ level, glass, glow }), paddingClasses[padding], className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface PanelProps
  extends Omit<ComponentPropsWithRef<'section'>, 'title'>, SurfaceOptions {
  /** Überschrift; benennt die Region (`aria-labelledby`). */
  readonly title?: ReactNode;
  /** Kleine Zeile über der Überschrift (Mono, Versalien). */
  readonly eyebrow?: ReactNode;
  readonly description?: ReactNode;
  /** Aktionen rechts in der Kopfzeile (Buttons, Menüs). */
  readonly actions?: ReactNode;
  /** Fußzeile mit Trennlinie. */
  readonly footer?: ReactNode;
  /** Überschriften-Ebene (Standard h2). */
  readonly headingLevel?: 2 | 3 | 4 | undefined;
  readonly padding?: SurfacePadding | undefined;
}

/**
 * Fläche mit optionaler Kopfzeile (Überschrift, Beschreibung, Aktionen) und Fußzeile.
 * Mit `title` ist sie eine benannte Region (`<section aria-labelledby>`).
 */
export function Panel({
  title,
  eyebrow,
  description,
  actions,
  footer,
  headingLevel = 2,
  padding = 'md',
  level,
  glass,
  glow,
  className,
  children,
  ...rest
}: PanelProps) {
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  const hasHeader = title !== undefined || actions !== undefined || eyebrow !== undefined;
  return (
    <section
      aria-labelledby={title === undefined ? undefined : headingId}
      className={cx(surfaceClasses({ level, glass, glow }), 'flex flex-col', className)}
      {...rest}
    >
      {hasHeader && (
        <header
          className={cx(
            'flex items-start justify-between gap-4',
            padding === 'none' ? 'px-5 pt-4' : paddingClasses[padding],
            children !== undefined && 'pb-0',
          )}
        >
          <div className="min-w-0">
            {eyebrow !== undefined && (
              <p className="font-mono text-2xs tracking-caps text-text-subtle uppercase">
                {eyebrow}
              </p>
            )}
            {title !== undefined && (
              <Heading
                id={headingId}
                className={cx('text-md font-semibold text-text', eyebrow !== undefined && 'mt-1')}
              >
                {title}
              </Heading>
            )}
            {description !== undefined && (
              <p className="mt-1 text-sm text-text-muted">{description}</p>
            )}
          </div>
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      {children !== undefined && (
        <div className={cx('min-w-0 flex-1', paddingClasses[padding], hasHeader && 'pt-4')}>
          {children}
        </div>
      )}
      {footer !== undefined && (
        <footer
          className={cx(
            'border-t border-border',
            padding === 'none' ? 'px-5 py-3' : paddingClasses[padding],
            'py-3',
          )}
        >
          {footer}
        </footer>
      )}
    </section>
  );
}
