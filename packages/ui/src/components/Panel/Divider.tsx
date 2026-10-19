import type { ReactNode } from 'react';
import { cx } from '../../utils/cx.ts';

export interface DividerProps {
  readonly orientation?: 'horizontal' | 'vertical' | undefined;
  /** Text in der Mitte (z. B. „oder“) – nur waagerecht. */
  readonly label?: ReactNode;
  /**
   * Dekorativ (Standard): rein optische Linie, für Hilfstechnologien unsichtbar. `false` ergibt
   * eine semantische Trennung (`role="separator"`).
   */
  readonly decorative?: boolean | undefined;
  readonly className?: string | undefined;
}

/** Haarlinie in Rahmenfarbe – trennt Gruppen, ohne zu lärmen. */
export function Divider({
  orientation = 'horizontal',
  label,
  decorative = true,
  className,
}: DividerProps) {
  const semantics = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'separator', 'aria-orientation': orientation } as const);
  if (orientation === 'vertical') {
    return <div {...semantics} className={cx('w-px self-stretch bg-border', className)} />;
  }
  if (label !== undefined) {
    return (
      <div {...semantics} className={cx('flex items-center gap-3', className)}>
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono text-2xs tracking-caps text-text-subtle uppercase">{label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return <div {...semantics} className={cx('h-px w-full bg-border', className)} />;
}
