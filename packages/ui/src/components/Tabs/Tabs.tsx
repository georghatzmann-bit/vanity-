import { motion } from 'motion/react';
import {
  createContext,
  use,
  useId,
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useControllableState } from '../../hooks/useControllableState.ts';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { springs } from '../../tokens/tokens.ts';
import { cx } from '../../utils/cx.ts';

export type TabsOrientation = 'horizontal' | 'vertical';
/** `automatic`: Auswahl folgt dem Fokus. `manual`: Pfeile bewegen nur den Fokus, Enter/Leertaste wählt. */
export type TabsActivation = 'automatic' | 'manual';

interface TabsContextValue {
  readonly baseId: string;
  readonly value: string;
  readonly select: (value: string) => void;
  readonly orientation: TabsOrientation;
  readonly activation: TabsActivation;
  readonly reduced: boolean;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = use(TabsContext);
  if (context === null) {
    throw new Error(`<${component}> muss innerhalb von <Tabs> stehen.`);
  }
  return context;
}

/** Werte → gültige ID-Bestandteile (Werte dürfen beliebige Zeichen enthalten). */
function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => `_${character.codePointAt(0) ?? 0}`);
}

export function tabId(baseId: string, value: string): string {
  return `${baseId}-tab-${idPart(value)}`;
}

export function tabPanelId(baseId: string, value: string): string {
  return `${baseId}-panel-${idPart(value)}`;
}

type TabsValueProps =
  | {
      /** Kontrollierter Wert. */
      readonly value: string;
      readonly onValueChange: (value: string) => void;
      readonly defaultValue?: undefined;
    }
  | {
      readonly value?: undefined;
      /** Startwert (unkontrolliert) – Pflicht, damit immer genau ein Reiter aktiv ist. */
      readonly defaultValue: string;
      readonly onValueChange?: ((value: string) => void) | undefined;
    };

export type TabsProps = TabsValueProps & {
  readonly orientation?: TabsOrientation | undefined;
  readonly activation?: TabsActivation | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
};

/**
 * Reiter nach dem WAI-ARIA-Muster „Tabs“: `tablist`/`tab`/`tabpanel`, ein Tab-Stopp für die
 * Liste, Pfeiltasten (waagerecht ←/→, senkrecht ↑/↓), Pos1/Ende.
 */
export function Tabs({
  value,
  defaultValue,
  onValueChange,
  orientation = 'horizontal',
  activation = 'automatic',
  className,
  children,
}: TabsProps) {
  const baseId = `aegis-tabs-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const reduced = useReducedMotionPreference();
  const [current, setCurrent] = useControllableState({
    value,
    defaultValue: defaultValue ?? '',
    onChange: onValueChange,
  });
  return (
    <TabsContext
      value={{ baseId, value: current, select: setCurrent, orientation, activation, reduced }}
    >
      <div
        className={cx(orientation === 'vertical' ? 'flex gap-6' : 'flex flex-col', className)}
        data-orientation={orientation}
      >
        {children}
      </div>
    </TabsContext>
  );
}

export interface TabListProps extends ComponentPropsWithRef<'div'> {
  /** Name der Reiterleiste (Pflicht, sofern kein `aria-labelledby`). */
  readonly 'aria-label'?: string | undefined;
}

export function TabList({ className, children, onKeyDown, ...rest }: TabListProps) {
  const { orientation, activation, select } = useTabsContext('TabList');
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    const previous = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const tabs = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].filter((tab) => !tab.disabled);
    if (tabs.length === 0) {
      return;
    }
    const index = tabs.findIndex((tab) => tab === document.activeElement);
    let target: HTMLButtonElement | undefined;
    if (event.key === next) {
      target = tabs[(index + 1 + tabs.length) % tabs.length];
    } else if (event.key === previous) {
      target = tabs[(index - 1 + tabs.length) % tabs.length];
    } else if (event.key === 'Home') {
      target = tabs[0];
    } else if (event.key === 'End') {
      target = tabs.at(-1);
    }
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    target.focus();
    const targetValue = target.dataset.value;
    if (activation === 'automatic' && targetValue !== undefined) {
      select(targetValue);
    }
  };
  return (
    <div
      role="tablist"
      aria-orientation={orientation}
      onKeyDown={handleKeyDown}
      className={cx(
        'relative flex',
        orientation === 'horizontal'
          ? // Schmale Fenster: waagerecht scrollen; die Grundlinie ist ein Innenschatten, damit
            // die Markierung des aktiven Reiters nicht abgeschnitten wird.
            'gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_0_var(--aegis-border)] [scrollbar-width:none]'
          : 'w-48 shrink-0 flex-col gap-0.5 border-r border-border pr-2',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface TabProps extends Omit<ComponentPropsWithRef<'button'>, 'value' | 'type'> {
  readonly value: string;
  /** Icon vor dem Text (dekorativ). */
  readonly icon?: ReactNode;
}

export function Tab({ value, icon, className, children, onClick, disabled, ...rest }: TabProps) {
  const context = useTabsContext('Tab');
  const selected = context.value === value;
  const horizontal = context.orientation === 'horizontal';
  return (
    <button
      type="button"
      role="tab"
      id={tabId(context.baseId, value)}
      aria-selected={selected}
      aria-controls={tabPanelId(context.baseId, value)}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      data-value={value}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          context.select(value);
        }
      }}
      className={cx(
        'relative inline-flex items-center gap-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-4',
        horizontal ? 'h-10 shrink-0 px-3' : 'h-9 rounded-md px-3 text-left',
        selected ? 'text-text' : 'text-text-muted enabled:hover:text-text',
        !horizontal && !selected && 'enabled:hover:bg-surface-2',
        className,
      )}
      {...rest}
    >
      {selected && (
        <motion.span
          layoutId={`${context.baseId}-indicator`}
          aria-hidden="true"
          className={cx(
            'absolute',
            horizontal
              ? 'inset-x-2 bottom-0 h-0.5 rounded-full bg-accent'
              : 'inset-0 rounded-md border border-border bg-surface-2',
          )}
          transition={context.reduced ? { duration: 0 } : springs.snappy}
        />
      )}
      {!horizontal && selected && (
        <span
          aria-hidden="true"
          className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent"
        />
      )}
      {icon !== undefined && (
        <span aria-hidden="true" className="relative inline-flex">
          {icon}
        </span>
      )}
      <span className="relative">{children}</span>
    </button>
  );
}

export interface TabPanelProps extends ComponentPropsWithRef<'div'> {
  readonly value: string;
  /** Inhalt auch eingehängt lassen, wenn der Reiter nicht aktiv ist (versteckt). */
  readonly keepMounted?: boolean | undefined;
}

export function TabPanel({
  value,
  keepMounted = false,
  className,
  children,
  ...rest
}: TabPanelProps) {
  const context = useTabsContext('TabPanel');
  const selected = context.value === value;
  if (!selected && !keepMounted) {
    return null;
  }
  return (
    <div
      role="tabpanel"
      id={tabPanelId(context.baseId, value)}
      aria-labelledby={tabId(context.baseId, value)}
      tabIndex={0}
      hidden={!selected}
      className={cx('min-w-0 flex-1 pt-4', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
