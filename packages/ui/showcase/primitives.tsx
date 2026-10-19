import { motion, type HTMLMotionProps } from 'motion/react';
import type { ReactNode } from 'react';
import { springs } from '../src/index.ts';

/** Baustein-Komponenten nur für die Showcase-Seite (nicht Teil der Paket-API). */

export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

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
    <section id={id} aria-labelledby={headingId} className="scroll-mt-24 py-12 sm:py-16">
      <p className="font-mono text-2xs tracking-caps text-accent uppercase">{eyebrow}</p>
      <h2 id={headingId} className="mt-2 text-2xl font-semibold tracking-tight text-text">
        {title}
      </h2>
      {description !== undefined && (
        <p className="mt-2 max-w-2xl text-sm text-text-muted">{description}</p>
      )}
      <div className="mt-8">{children}</div>
    </section>
  );
}

export function Card({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cx('rounded-xl border border-border bg-surface-1 shadow-bevel', className)}>
      {children}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const buttonVariants: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'bg-accent text-on-accent hover:bg-accent-strong after:shadow-glow font-semibold border border-transparent',
  secondary:
    'bg-surface-2 text-text border border-border-strong hover:bg-surface-3 after:shadow-glow',
  ghost: 'text-text-muted hover:text-text hover:bg-surface-2 border border-transparent',
};

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

/**
 * Button mit Feder (nur transform) und Leuchten beim Hover: Das Leuchten liegt auf einem
 * Pseudo-Element, dessen Deckkraft überblendet wird – Schatten selbst werden nie animiert.
 */
export function Button({ variant = 'secondary', className, children, ...rest }: ButtonProps) {
  return (
    <motion.button
      type="button"
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.97, y: 0 }}
      transition={springs.snappy}
      className={cx(
        'relative inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm select-none',
        'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:opacity-0 after:transition-opacity after:duration-200 after:content-[""] hover:after:opacity-100',
        'disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
}

/** Schalter (role="switch"); der Knopf bewegt sich per transform. */
export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2.5 rounded-md py-1 text-sm text-text-muted hover:text-text"
    >
      <span
        aria-hidden="true"
        className={cx(
          'relative inline-flex h-5 w-9 items-center rounded-full border p-0.5',
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface-2',
        )}
      >
        <motion.span
          className={cx('block size-3.5 rounded-full', checked ? 'bg-on-accent' : 'bg-text-muted')}
          initial={false}
          animate={{ x: checked ? 16 : 0 }}
          transition={springs.snappy}
        />
      </span>
      {label}
    </button>
  );
}

interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SegmentedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  readonly layoutId: string;
}

/** Umschalter aus Buttons mit aria-pressed; die Markierung gleitet per Layout-Transform. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  layoutId,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-lg border border-border bg-surface-1 p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              'relative h-7 rounded-md px-3 text-xs font-medium',
              selected ? 'text-text' : 'text-text-muted hover:text-text',
            )}
          >
            {selected && (
              <motion.span
                layoutId={layoutId}
                aria-hidden="true"
                className="absolute inset-0 rounded-md border border-border-strong bg-surface-3"
                transition={springs.snappy}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
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
