import {
  IconDashboard,
  IconInfo,
  IconKey,
  IconLab,
  IconLock,
  IconNetwork,
  IconQuarantine,
  IconReport,
  IconSafe,
  IconScan,
  IconSettings,
  IconShield,
  IconTools,
  type IconComponent,
} from '@aegis/ui';
import type { TextKey } from '../i18n/translator.ts';
import type { RouteId } from '../router/routes.ts';

export type NavGroupId = 'overview' | 'protection' | 'system' | 'privacy' | 'app';

export interface NavGroup {
  readonly id: NavGroupId;
  readonly routes: readonly RouteId[];
}

/** Reihenfolge der Seitenleiste; „App“ steht unten abgesetzt. */
export const navGroups: readonly NavGroup[] = [
  { id: 'overview', routes: ['dashboard', 'reports'] },
  { id: 'protection', routes: ['scan', 'realtime', 'quarantine', 'safe', 'lab'] },
  { id: 'system', routes: ['hardening', 'network'] },
  { id: 'privacy', routes: ['vault', 'tools'] },
  { id: 'app', routes: ['settings', 'about'] },
];

export const routeIcons: Readonly<Record<RouteId, IconComponent>> = {
  dashboard: IconDashboard,
  scan: IconScan,
  realtime: IconShield,
  lab: IconLab,
  network: IconNetwork,
  hardening: IconLock,
  vault: IconKey,
  tools: IconTools,
  quarantine: IconQuarantine,
  safe: IconSafe,
  reports: IconReport,
  settings: IconSettings,
  about: IconInfo,
};

export const groupLabels: Readonly<Record<NavGroupId, TextKey>> = {
  overview: 'nav.groups.overview',
  protection: 'nav.groups.protection',
  system: 'nav.groups.system',
  privacy: 'nav.groups.privacy',
  app: 'nav.groups.app',
};

/** Navigations-Beschriftung je Seite. */
export function navLabelKey(route: RouteId): TextKey {
  return `pages.${route}.nav`;
}

export function titleKey(route: RouteId): TextKey {
  return `pages.${route}.title`;
}

export function eyebrowKey(route: RouteId): TextKey {
  return `pages.${route}.eyebrow`;
}
