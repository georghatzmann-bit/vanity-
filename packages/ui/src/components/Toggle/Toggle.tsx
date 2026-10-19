import { motion } from 'motion/react';
import { useId, type ComponentPropsWithRef, type MouseEvent, type ReactNode } from 'react';
import { useControllableState } from '../../hooks/useControllableState.ts';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { springs } from '../../tokens/tokens.ts';
import { cx } from '../../utils/cx.ts';

export interface ToggleProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'onChange' | 'value' | 'defaultValue' | 'children' | 'role' | 'type'
> {
  /** Kontrollierter Zustand. */
  readonly checked?: boolean | undefined;
  /** Startzustand (unkontrolliert). */
  readonly defaultChecked?: boolean | undefined;
  readonly onCheckedChange?: ((checked: boolean) => void) | undefined;
  /**
   * Sichtbare Beschriftung (benennt den Schalter). Ohne `label` ist `aria-label` bzw.
   * `aria-labelledby` Pflicht.
   */
  readonly label?: ReactNode;
  /** Erklärung unter der Beschriftung (`aria-describedby`). */
  readonly description?: ReactNode;
  readonly size?: 'sm' | 'md' | undefined;
  /** Beschriftung links (`start`) oder rechts (`end`, Standard) vom Schalter. */
  readonly labelPosition?: 'start' | 'end' | undefined;
}

const trackSize = { sm: 'h-4 w-7', md: 'h-5 w-9' } as const;
const knobSize = { sm: 'size-2.5', md: 'size-3.5' } as const;
const knobTravel = { sm: 12, md: 16 } as const;

/**
 * Schalter (`role="switch"`, `aria-checked`). Leertaste/Enter schalten (nativer Button),
 * ein Klick auf die Beschriftung ebenfalls. Der Knopf gleitet per transform.
 */
export function Toggle({
  checked,
  defaultChecked = false,
  onCheckedChange,
  label,
  description,
  size = 'md',
  labelPosition = 'end',
  disabled,
  className,
  id,
  onClick,
  ref,
  ...rest
}: ToggleProps) {
  const generatedId = useId();
  const buttonId = id ?? generatedId;
  const descriptionId = `${buttonId}-description`;
  const reduced = useReducedMotionPreference();
  const [on, setOn] = useControllableState({
    value: checked,
    defaultValue: defaultChecked,
    onChange: onCheckedChange,
  });

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      setOn(!on);
    }
  };

  const control = (
    <button
      ref={ref}
      id={buttonId}
      type="button"
      role="switch"
      aria-checked={on}
      aria-describedby={description === undefined ? undefined : descriptionId}
      disabled={disabled}
      onClick={handleClick}
      className={cx(
        'group relative inline-flex shrink-0 items-center rounded-full border p-[2px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
        trackSize[size],
        on
          ? 'border-accent bg-accent'
          : 'border-border-strong bg-surface-3 enabled:hover:border-text-subtle',
      )}
      data-state={on ? 'on' : 'off'}
      {...rest}
    >
      <motion.span
        aria-hidden="true"
        className={cx(
          'block rounded-full shadow-sm',
          knobSize[size],
          on ? 'bg-on-accent' : 'bg-text-muted',
        )}
        initial={false}
        animate={{ x: on ? knobTravel[size] : 0 }}
        transition={reduced ? { duration: 0 } : springs.snappy}
      />
    </button>
  );

  if (label === undefined && description === undefined) {
    return <span className={cx('inline-flex', className)}>{control}</span>;
  }

  return (
    <div
      className={cx(
        'inline-flex items-start gap-3',
        labelPosition === 'start' && 'flex-row-reverse justify-between',
        className,
      )}
    >
      <span className={cx('flex', size === 'md' ? 'h-5 items-center' : 'h-4 items-center')}>
        {control}
      </span>
      <span className="min-w-0">
        {label !== undefined && (
          <label
            htmlFor={buttonId}
            className={cx(
              'block text-sm text-text select-none',
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            )}
          >
            {label}
          </label>
        )}
        {description !== undefined && (
          <span id={descriptionId} className="mt-0.5 block text-xs text-text-muted">
            {description}
          </span>
        )}
      </span>
    </div>
  );
}
