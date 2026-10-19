import type { ReactNode } from 'react';
import { IconInfo } from '../../icons/icons.tsx';
import { cx } from '../../utils/cx.ts';

export interface PhaseBadgeProps {
  /** Phase, z. B. `P3`. */
  readonly phase: string;
  /** Beschriftung (Standard: „Folgt in P3“). */
  readonly format?: ((phase: string) => string) | undefined;
  readonly className?: string | undefined;
}

/** Ehrliche Plakette für Funktionen, die es noch nicht gibt: „Folgt in P3“. */
export function PhaseBadge({ phase, format = (p) => `Folgt in ${p}`, className }: PhaseBadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center gap-1.5 rounded-full border border-border-strong/60 bg-surface-2 px-2 font-mono text-2xs font-medium tracking-wide text-text-muted',
        className,
      )}
      data-phase={phase}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full border border-text-subtle" />
      {format(phase)}
    </span>
  );
}

export interface EmptyStateProps {
  /** Großes Icon (dekorativ). */
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Phase der Umsetzung – zeigt „Folgt in …“. */
  readonly phase?: string | undefined;
  readonly formatPhase?: ((phase: string) => string) | undefined;
  /** Ehrlicher Zusatz (z. B. warum hier keine Werte stehen). */
  readonly note?: ReactNode;
  /** Aktionen (Buttons). */
  readonly actions?: ReactNode;
  readonly headingLevel?: 2 | 3 | 4 | undefined;
  readonly size?: 'md' | 'lg' | undefined;
  readonly className?: string | undefined;
}

/**
 * Leerer Zustand bzw. Platzhalter-Seite: Icon, Titel, Beschreibung, optional Phase und ein
 * ehrlicher Hinweis. Für Module, die es noch nicht gibt – niemals Fantasiewerte zeigen.
 */
export function EmptyState({
  icon,
  title,
  description,
  phase,
  formatPhase,
  note,
  actions,
  headingLevel = 2,
  size = 'md',
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      className={cx(
        'flex flex-col items-center text-center',
        size === 'lg' ? 'gap-4 px-6 py-16' : 'gap-3 px-5 py-10',
        className,
      )}
    >
      {icon !== undefined && (
        <span
          aria-hidden="true"
          className={cx(
            'relative grid place-items-center rounded-xl border border-border bg-surface-2 text-text-muted shadow-bevel',
            size === 'lg' ? 'size-16 [&_svg]:size-7' : 'size-12 [&_svg]:size-6',
          )}
        >
          {/* Eckmarken wie ein Sucher – ruhige Instrumenten-Anmutung. */}
          <span className="absolute -inset-1.5 rounded-[14px] border border-dashed border-border" />
          {icon}
        </span>
      )}
      {phase !== undefined && <PhaseBadge phase={phase} format={formatPhase} />}
      <Heading
        className={cx(
          'font-semibold tracking-tight text-text',
          size === 'lg' ? 'text-xl' : 'text-md',
        )}
      >
        {title}
      </Heading>
      {description !== undefined && (
        <p className="max-w-md text-sm text-text-muted">{description}</p>
      )}
      {note !== undefined && (
        <p className="flex max-w-md items-start gap-2 rounded-lg border border-border bg-surface-1 px-3 py-2 text-left text-xs text-text-muted [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0">
          <IconInfo strokeWidth={2} aria-hidden="true" />
          <span>{note}</span>
        </p>
      )}
      {actions !== undefined && (
        <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export interface ComingSoonProps extends Omit<EmptyStateProps, 'phase'> {
  /** Phase, in der das Modul kommt, z. B. `P3`. */
  readonly phase: string;
}

/** Standard-Hinweis für Platzhalter-Seiten. */
export const comingSoonNoteDe =
  'Bis dahin zeigt AEGIS hier bewusst nichts an – keine Beispiel- oder Schätzwerte.';

/** Platzhalter für ein Modul, das in einer späteren Phase kommt (ehrlich, ohne Fantasiewerte). */
export function ComingSoon({ note = comingSoonNoteDe, size = 'lg', ...rest }: ComingSoonProps) {
  return <EmptyState note={note} size={size} {...rest} />;
}
