import type { ReactNode } from 'react';
import { Card as LibraryCard, cx } from '../src/index.ts';

/** Baustein-Komponenten nur für die Showcase-Seite (nicht Teil der Paket-API). */

export { cx };

interface SectionProps {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}

export function Section({ id, eyebrow, title, description, children }: SectionProps) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-20 py-12 sm:py-14">
      <p className="font-mono text-2xs tracking-caps text-accent uppercase">{eyebrow}</p>
      <h2
        id={headingId}
        tabIndex={-1}
        className="mt-2 text-2xl font-semibold tracking-tight text-text outline-none"
      >
        {title}
      </h2>
      {description !== undefined && (
        <p className="mt-2 max-w-2xl text-sm text-text-muted">{description}</p>
      )}
      <div className="mt-8">{children}</div>
    </section>
  );
}

/** Fläche ohne Standard-Innenabstand (die Showcase-Abschnitte setzen ihn selbst). */
export function Card({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <LibraryCard padding="none" className={className}>
      {children}
    </LibraryCard>
  );
}

/** Kleine Überschrift innerhalb einer Karte. */
export function Label({ children }: { readonly children: ReactNode }) {
  return (
    <p className="text-xs font-semibold tracking-caps text-text-subtle uppercase">{children}</p>
  );
}

/** Kennzeichnung für erfundene Werte – deutlich, nicht zu übersehen. */
export function DemoTag({ children = 'Demo-Daten (Showcase)' }: { readonly children?: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-risk-risky/45 bg-risk-risky-subtle px-2.5 font-mono text-2xs font-semibold tracking-wide text-risk-risky">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-risk-risky" />
      {children}
    </span>
  );
}

export function Pass({ ok, children }: { readonly ok: boolean; readonly children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-sm px-1.5 font-mono text-2xs font-medium',
        ok
          ? 'bg-risk-clean-subtle text-risk-clean'
          : 'bg-risk-dangerous-subtle text-risk-dangerous',
      )}
    >
      <span aria-hidden="true">{ok ? '✓' : '✕'}</span>
      {children}
      <span className="sr-only">{ok ? ' erfüllt' : ' nicht erfüllt'}</span>
    </span>
  );
}
