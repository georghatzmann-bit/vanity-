import { Fragment, type ComponentPropsWithRef } from 'react';
import { cx } from '../../utils/cx.ts';

export interface KbdProps extends ComponentPropsWithRef<'kbd'> {
  /**
   * Tastenkombination als Liste, z. B. `['Strg', 'K']` → `Strg + K` (verschachtelte
   * `<kbd>` nach HTML-Standard). Ohne `keys` wird `children` als eine Taste dargestellt.
   */
  readonly keys?: readonly string[] | undefined;
  readonly size?: 'sm' | 'md' | undefined;
}

const keyClasses = {
  sm: 'h-[18px] min-w-[18px] px-1 text-2xs',
  md: 'h-5 min-w-5 px-1.5 text-2xs',
} as const;

const keyBase =
  'inline-flex items-center justify-center rounded-sm border border-border bg-surface-2 font-mono font-medium text-text-muted shadow-[inset_0_-1px_0_0_var(--aegis-border)]';

/** Tastatur-Taste bzw. Tastenkombination im Stil einer flachen Hardware-Taste. */
export function Kbd({ keys, size = 'md', className, children, ...rest }: KbdProps) {
  if (keys === undefined) {
    return (
      <kbd className={cx(keyBase, keyClasses[size], className)} {...rest}>
        {children}
      </kbd>
    );
  }
  return (
    <kbd className={cx('inline-flex items-center gap-1 font-mono', className)} {...rest}>
      {keys.map((key, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 && <span className="text-2xs text-text-subtle">+</span>}
          <kbd className={cx(keyBase, keyClasses[size])}>{key}</kbd>
        </Fragment>
      ))}
    </kbd>
  );
}
