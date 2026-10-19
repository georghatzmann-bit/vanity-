import { motion, type MotionStyle } from 'motion/react';
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { springs } from '../../tokens/tokens.ts';
import { cx } from '../../utils/cx.ts';
import { Spinner } from './Spinner.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Native Button-Props ohne die Animations-/Drag-Handler, die Motion selbst belegt. */
type NativeButtonProps = Omit<
  ComponentPropsWithRef<'button'>,
  | 'children'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
>;

export interface ButtonProps extends NativeButtonProps {
  /** `primary` = Hauptaktion (sparsam), `danger` nur für zerstörerische Bestätigungen. */
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  /**
   * Ladezustand: zeigt einen Kreis, setzt `aria-busy`, blockiert Klicks, bleibt aber
   * fokussierbar (der Fokus springt nicht weg, während etwas läuft).
   */
  readonly loading?: boolean | undefined;
  /** Zusatz für Screenreader im Ladezustand. Standard: „Bitte warten“. */
  readonly loadingLabel?: string | undefined;
  /** Icon vor dem Text (dekorativ). */
  readonly iconStart?: ReactNode;
  /** Icon nach dem Text (dekorativ). */
  readonly iconEnd?: ReactNode;
  /** Volle Breite des Containers. */
  readonly fullWidth?: boolean | undefined;
  readonly children?: ReactNode;
}

const base =
  'relative inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap select-none ' +
  'transition-[background-color,border-color,color] duration-150 ' +
  'disabled:cursor-not-allowed aria-disabled:cursor-not-allowed';

/**
 * Leuchten beim Hover liegt auf einem Pseudo-Element, dessen Deckkraft überblendet wird –
 * Schatten selbst werden nie animiert (60 fps).
 */
const glow =
  "after:pointer-events-none after:absolute after:-inset-px after:rounded-[inherit] after:opacity-0 after:shadow-glow after:transition-opacity after:duration-200 after:content-[''] enabled:hover:after:opacity-100 aria-disabled:after:hidden";

/**
 * Gesperrte Haupt- und Gefahr-Buttons werden neutral grau statt nur blasser: Ein gesperrtes
 * „Ja, ausführen“ darf nie wie eine verfügbare Aktion aussehen.
 */
const disabledNeutral =
  'disabled:border-border disabled:bg-surface-3 disabled:text-text-subtle disabled:shadow-none';

export const buttonVariantClasses: Readonly<Record<ButtonVariant, string>> = {
  primary: cx(
    'border-transparent bg-accent font-semibold text-on-accent shadow-bevel enabled:hover:bg-accent-strong',
    disabledNeutral,
    glow,
  ),
  secondary: cx(
    'border-border bg-surface-2 text-text shadow-bevel enabled:hover:border-border-strong enabled:hover:bg-surface-3 disabled:opacity-45',
    glow,
  ),
  ghost:
    'border-transparent text-text-muted enabled:hover:bg-surface-2 enabled:hover:text-text disabled:opacity-45',
  danger: cx(
    'border-transparent bg-danger font-semibold text-bg shadow-bevel enabled:hover:bg-danger/85',
    disabledNeutral,
  ),
};

export const buttonSizeClasses: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5',
  md: 'h-9 gap-2 px-3.5 text-sm [&_svg]:size-4',
  lg: 'h-11 gap-2.5 px-5 text-base [&_svg]:size-[18px]',
};

const spinnerSize: Readonly<Record<ButtonSize, number>> = { sm: 14, md: 16, lg: 18 };

/** Druck-Feder: nur `transform: scale`, bei „Bewegung reduzieren“ keine Bewegung. */
export function usePressMotion(active: boolean) {
  const reduced = useReducedMotionPreference();
  return active && !reduced ? { whileTap: { scale: 0.97 }, transition: springs.snappy } : {};
}

/**
 * Button der AEGIS-Oberfläche. Varianten `primary`/`secondary`/`ghost`/`danger`, Größen
 * `sm`/`md`/`lg`. `type` ist standardmäßig `button` (kein versehentliches Absenden).
 * Ref-Weitergabe über die `ref`-Prop (React 19).
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel = 'Bitte warten',
  iconStart,
  iconEnd,
  fullWidth = false,
  type = 'button',
  className,
  disabled,
  onClick,
  children,
  style,
  ref,
  ...rest
}: ButtonProps) {
  const press = usePressMotion(!disabled && !loading);
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={handleClick}
      className={cx(
        base,
        buttonVariantClasses[variant],
        buttonSizeClasses[size],
        fullWidth && 'w-full',
        className,
      )}
      data-variant={variant}
      {...(style === undefined ? {} : { style: style as MotionStyle })}
      {...press}
      {...rest}
    >
      {loading ? (
        <Spinner size={spinnerSize[size]} />
      ) : (
        iconStart !== undefined && (
          <span aria-hidden="true" className="inline-flex shrink-0">
            {iconStart}
          </span>
        )
      )}
      {children !== undefined && <span className="truncate">{children}</span>}
      {loading && <span className="sr-only">, {loadingLabel}</span>}
      {iconEnd !== undefined && (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {iconEnd}
        </span>
      )}
    </motion.button>
  );
}
