import { IconChevronLeft, IconChevronRight, Tooltip, cx, springs } from '@aegis/ui';
import { motion } from 'motion/react';
import { useId, useState, type KeyboardEvent, type Ref } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { hashFor, routePhases, type RouteId } from '../router/routes.ts';
import { groupLabels, navGroups, navLabelKey, routeIcons, type NavGroup } from './navigation.ts';

export interface SidebarProps {
  readonly route: RouteId;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  /** Wird vor dem Seitenwechsel über die Navigation aufgerufen (Ansage für Screenreader). */
  readonly onNavigate: (route: RouteId) => void;
  readonly ref?: Ref<HTMLElement> | undefined;
}

const allRoutes: readonly RouteId[] = navGroups.flatMap((group) => group.routes);

/**
 * Seitenleiste: Gruppen mit Symbol + Beschriftung, einklappbar auf Symbole. Ein Tab-Stopp
 * für die ganze Navigation (roving tabindex): ↑/↓ wechseln den Fokus, Pos1/Ende springen,
 * Enter öffnet die Seite. Die aktive Seite trägt `aria-current="page"` und eine Leuchtmarke,
 * die per transform zur neuen Seite gleitet.
 */
export function Sidebar({ route, collapsed, onCollapsedChange, onNavigate, ref }: SidebarProps) {
  const { t } = useT();
  const listId = useId();
  const [focusRoute, setFocusRoute] = useState<RouteId | null>(null);
  // Tab-Stopp: zuletzt fokussierter Eintrag, sonst die aktive Seite.
  const tabStop = focusRoute ?? route;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const focused = event.target instanceof HTMLElement ? event.target.dataset['route'] : undefined;
    const current = allRoutes.findIndex((id) => id === focused);
    if (current === -1) {
      return;
    }
    let next: number | null = null;
    if (event.key === 'ArrowDown') {
      next = (current + 1) % allRoutes.length;
    } else if (event.key === 'ArrowUp') {
      next = (current - 1 + allRoutes.length) % allRoutes.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = allRoutes.length - 1;
    }
    const target = next === null ? undefined : allRoutes[next];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    setFocusRoute(target);
    event.currentTarget.querySelector<HTMLElement>(`a[data-route="${target}"]`)?.focus();
  };

  const mainGroups = navGroups.filter((group) => group.id !== 'app');
  const appGroup = navGroups.find((group) => group.id === 'app');

  const renderGroup = (group: NavGroup, index: number, showLabel: boolean) => {
    const labelId = `${listId}-${group.id}`;
    const labelled = showLabel && !collapsed;
    return (
      <div key={group.id} className={cx(index > 0 && (collapsed ? 'mt-2.5' : 'mt-4'))}>
        {collapsed
          ? index > 0 && <div aria-hidden="true" className="mx-auto mb-2.5 h-px w-6 bg-border" />
          : labelled && (
              <p
                id={labelId}
                className="px-3 pb-1 font-mono text-2xs tracking-caps text-text-subtle uppercase"
              >
                {t(groupLabels[group.id])}
              </p>
            )}
        <ul
          aria-labelledby={labelled ? labelId : undefined}
          aria-label={labelled ? undefined : t(groupLabels[group.id])}
          className="flex flex-col gap-0.5"
        >
          {group.routes.map((id) => (
            <li key={id} className={cx(collapsed && 'flex justify-center')}>
              <NavLink
                route={id}
                active={id === route}
                collapsed={collapsed}
                tabbable={id === tabStop}
                onFocus={() => setFocusRoute(id)}
                onActivate={() => onNavigate(id)}
              />
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <nav
      ref={ref}
      aria-label={t('nav.label')}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Fokus verlässt die Navigation: Tab-Stopp wieder auf die aktive Seite.
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusRoute(null);
        }
      }}
      className={cx(
        'relative z-10 flex shrink-0 flex-col border-r border-border bg-surface-1/50',
        collapsed ? 'w-[4.25rem]' : 'w-60',
      )}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-testid="sidebar"
    >
      {/* Ein-/Ausklappen: rund auf der Kante, oben – braucht keinen Platz in der Liste. */}
      <button
        type="button"
        aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
        title={collapsed ? t('nav.expand') : t('nav.collapse')}
        aria-expanded={!collapsed}
        onClick={() => onCollapsedChange(!collapsed)}
        className="absolute top-5 -right-3 z-10 grid size-6 place-items-center rounded-full border border-border bg-surface-1 text-text-subtle shadow-sm transition-colors duration-150 hover:border-border-strong hover:text-text"
        data-testid="sidebar-toggle"
      >
        {collapsed ? (
          <IconChevronRight size={14} strokeWidth={2} aria-hidden="true" />
        ) : (
          <IconChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      <div
        className={cx(
          'aegis-scroll-fade min-h-0 flex-1 overflow-y-auto pt-4 pb-3',
          collapsed ? 'px-2' : 'px-3',
        )}
      >
        {mainGroups.map((group, index) => renderGroup(group, index, true))}
      </div>
      {appGroup !== undefined && (
        <div className={cx('border-t border-border py-2.5', collapsed ? 'px-2' : 'px-3')}>
          {renderGroup(appGroup, 0, false)}
        </div>
      )}
    </nav>
  );
}

interface NavLinkProps {
  readonly route: RouteId;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly tabbable: boolean;
  readonly onFocus: () => void;
  readonly onActivate: () => void;
}

function NavLink({ route, active, collapsed, tabbable, onFocus, onActivate }: NavLinkProps) {
  const { t } = useT();
  const Icon = routeIcons[route];
  const phase = routePhases[route];
  const label = t(navLabelKey(route));
  const phaseText = phase === undefined ? undefined : t('phase.comingInShort', { phase });

  const link = (
    <a
      href={hashFor(route)}
      aria-current={active ? 'page' : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-route={route}
      onFocus={onFocus}
      onClick={onActivate}
      className={cx(
        'group relative flex items-center rounded-lg text-sm transition-colors duration-150',
        'focus-visible:outline-offset-0',
        collapsed ? 'size-9 justify-center' : 'h-[2.125rem] gap-3 px-3',
        active
          ? 'bg-surface-2 text-text shadow-bevel'
          : 'text-text-muted hover:bg-surface-2/60 hover:text-text',
      )}
    >
      {active && (
        <motion.span
          layoutId="aegis-nav-indicator"
          aria-hidden="true"
          className={cx(
            'absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent shadow-glow',
            collapsed ? '-left-2' : '-left-3',
          )}
          transition={springs.snappy}
        />
      )}
      <Icon
        size={18}
        strokeWidth={active ? 2 : 1.75}
        className={cx(
          'shrink-0 transition-colors duration-150',
          active ? 'text-accent' : 'text-text-subtle group-hover:text-text-muted',
        )}
      />
      {collapsed ? (
        <span className="sr-only">
          {label}
          {phaseText !== undefined && `, ${phaseText}`}
        </span>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {phase !== undefined && (
            <>
              <span
                aria-hidden="true"
                className="shrink-0 rounded-sm border border-border px-1 font-mono text-[0.625rem] leading-4 text-text-subtle"
              >
                {phase}
              </span>
              <span className="sr-only">, {phaseText}</span>
            </>
          )}
        </>
      )}
    </a>
  );

  if (!collapsed) {
    return link;
  }
  return (
    <Tooltip
      placement="right"
      content={
        phaseText === undefined
          ? label
          : `${label} · ${t('phase.comingIn', { phase: phase ?? '' })}`
      }
    >
      {link}
    </Tooltip>
  );
}
