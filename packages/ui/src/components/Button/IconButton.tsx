import { motion, type MotionStyle } from 'motion/react';
import type { ReactNode } from 'react';
import { cx } from '../../utils/cx.ts';
import {
  buttonVariantClasses,
  usePressMotion,
  type ButtonProps,
  type ButtonSize,
} from './Button.tsx';

export interface IconButtonProps extends Omit<
  ButtonProps,
  'iconStart' | 'iconEnd' | 'children' | 'loading' | 'loadingLabel' | 'fullWidth' | 'aria-label'
> {
  /** Pflicht: zugänglicher Name (wird `aria-label`), da kein sichtbarer Text existiert. */
  readonly label: string;
  /** Das Icon (dekorativ; der Name kommt aus `label`). */
  readonly icon: ReactNode;
  /** Umschalt-Button: setzt `aria-pressed`. */
  readonly pressed?: boolean | undefined;
}

const sizeClasses: Readonly<Record<ButtonSize, string>> = {
  sm: 'size-7 [&_svg]:size-4',
  md: 'size-9 [&_svg]:size-[18px]',
  lg: 'size-11 [&_svg]:size-5',
};

/**
 * Quadratischer Button nur mit Icon (z. B. Fenster-Steuerung, Schließen). `label` ist
 * Pflicht – ein Icon allein ist für Screenreader und Sprachsteuerung nicht benennbar.
 */
export function IconButton({
  label,
  icon,
  pressed,
  variant = 'ghost',
  size = 'md',
  type = 'button',
  className,
  disabled,
  style,
  ref,
  ...rest
}: IconButtonProps) {
  const press = usePressMotion(!disabled);
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      className={cx(
        'relative inline-flex shrink-0 items-center justify-center rounded-md border transition-[background-color,border-color,color] duration-150 select-none disabled:cursor-not-allowed disabled:opacity-45',
        buttonVariantClasses[variant],
        sizeClasses[size],
        pressed === true && 'border-border-strong bg-surface-3 text-text',
        className,
      )}
      {...(style === undefined ? {} : { style: style as MotionStyle })}
      {...press}
      {...rest}
    >
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
    </motion.button>
  );
}
