import { motion } from 'motion/react';
import { useId, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { useControllableState } from '../../hooks/useControllableState.ts';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { springs } from '../../tokens/tokens.ts';
import { cx } from '../../utils/cx.ts';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  /** Icon vor dem Text (dekorativ). */
  readonly icon?: ReactNode;
  /** Zugänglicher Name, falls `label` kein Text ist (z. B. nur Icon). */
  readonly ariaLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
}

export interface SegmentedControlProps<T extends string> {
  /** Name der Gruppe für Hilfstechnologien (Pflicht), z. B. „Farbschema“. */
  readonly label: string;
  readonly options: readonly SegmentedOption<T>[];
  readonly value?: T | undefined;
  readonly defaultValue?: T | undefined;
  readonly onValueChange?: ((value: T) => void) | undefined;
  readonly size?: 'sm' | 'md' | undefined;
  readonly fullWidth?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}

const sizeClasses = {
  sm: 'h-6 px-2.5 text-2xs [&_svg]:size-3',
  md: 'h-7 px-3 text-xs [&_svg]:size-3.5',
} as const;

/**
 * Umschalter für wenige, sich ausschließende Optionen – als Radiogruppe nach WAI-ARIA:
 * ein Tab-Stopp, Pfeiltasten wechseln (Auswahl folgt dem Fokus), Pos1/Ende springen.
 * Die Markierung gleitet per Layout-Transform.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  size = 'md',
  fullWidth = false,
  disabled = false,
  className,
  ref,
}: SegmentedControlProps<T>) {
  const layoutId = `aegis-segmented-${useId()}`;
  const reduced = useReducedMotionPreference();
  const [current, setCurrent] = useControllableState<T | undefined>({
    value,
    defaultValue: defaultValue ?? options.find((option) => !option.disabled)?.value,
    onChange: (next) => {
      if (next !== undefined) {
        onValueChange?.(next);
      }
    },
  });
  const enabled = options.filter((option) => !disabled && !option.disabled);
  const focusValue = enabled.some((option) => option.value === current)
    ? current
    : enabled[0]?.value;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys: Readonly<Record<string, number | 'first' | 'last'>> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      Home: 'first',
      End: 'last',
    };
    const step = keys[event.key];
    if (step === undefined || enabled.length === 0) {
      return;
    }
    event.preventDefault();
    const index = enabled.findIndex((option) => option.value === focusValue);
    let nextIndex: number;
    if (step === 'first') {
      nextIndex = 0;
    } else if (step === 'last') {
      nextIndex = enabled.length - 1;
    } else {
      nextIndex = (index + step + enabled.length) % enabled.length;
    }
    const next = enabled[nextIndex];
    if (next === undefined) {
      return;
    }
    setCurrent(next.value);
    const target = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (element) => element.dataset.value === next.value,
    );
    target?.focus();
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cx(
        'rounded-lg border border-border bg-surface-1 p-0.5 shadow-bevel',
        fullWidth ? 'flex w-full' : 'inline-flex w-fit',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === current;
        const optionDisabled = disabled || option.disabled === true;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            tabIndex={option.value === focusValue ? 0 : -1}
            disabled={optionDisabled}
            data-value={option.value}
            onClick={() => setCurrent(option.value)}
            className={cx(
              'relative inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
              sizeClasses[size],
              fullWidth && 'flex-1',
              selected ? 'text-text' : 'text-text-muted enabled:hover:text-text',
            )}
          >
            {selected && (
              <motion.span
                layoutId={layoutId}
                aria-hidden="true"
                className="absolute inset-0 rounded-md border border-border-strong bg-surface-3 shadow-bevel"
                transition={reduced ? { duration: 0 } : springs.snappy}
              />
            )}
            {option.icon !== undefined && (
              <span aria-hidden="true" className="relative inline-flex">
                {option.icon}
              </span>
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
