import { cx } from '@aegis/ui';
import type { ReactNode } from 'react';
import { useShell } from '../shell/ShellContext.tsx';

export interface PageHeaderProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
}

/**
 * Kopf jeder Seite. Die Überschrift ist das Fokusziel nach dem Start und nach einem
 * Seitenwechsel (nur programmatisch fokussierbar, nicht in der Tab-Reihenfolge).
 */
export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  const { headingRef } = useShell();
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <p className="font-mono text-2xs tracking-caps text-accent uppercase">{eyebrow}</p>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-1.5 text-2xl font-semibold tracking-tight text-text shadow-none outline-none"
          data-testid="page-heading"
        >
          {title}
        </h1>
        {description !== undefined && (
          <p className="mt-1.5 max-w-2xl text-sm text-text-muted">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

const widths = { wide: 'max-w-6xl', narrow: 'max-w-4xl' } as const;

/** Inhaltsbreite und Abstände einer Seite (`narrow` für Formulare und Lesetext). */
export function PageBody({
  children,
  width = 'wide',
}: {
  readonly children: ReactNode;
  readonly width?: keyof typeof widths | undefined;
}) {
  return (
    <div
      className={cx('@container mx-auto flex w-full flex-col gap-6 px-8 pt-7 pb-10', widths[width])}
    >
      {children}
    </div>
  );
}
