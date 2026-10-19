/**
 * Seiten der App und ihre Hash-Adressen (`#/dashboard`, `#/scan` …).
 * Phasen der noch fehlenden Module laut docs/PROGRESS.md – die Oberfläche zeigt dort
 * „Folgt in Pn“ statt erfundener Inhalte.
 */

export const routeIds = [
  'dashboard',
  'scan',
  'realtime',
  'lab',
  'network',
  'hardening',
  'vault',
  'tools',
  'quarantine',
  'reports',
  'settings',
  'about',
] as const;

export type RouteId = (typeof routeIds)[number];

export const DEFAULT_ROUTE: RouteId = 'dashboard';

/** Module, die es noch nicht gibt, mit der Phase, in der sie kommen. */
export const routePhases: Readonly<Partial<Record<RouteId, string>>> = {
  scan: 'P2',
  quarantine: 'P2',
  realtime: 'P3',
  reports: 'P3',
  lab: 'P4',
  hardening: 'P6',
  network: 'P7',
  vault: 'P9',
  tools: 'P10',
};

export function isRouteId(value: string): value is RouteId {
  return (routeIds as readonly string[]).includes(value);
}

/** `#/scan` → `scan`; leer, unbekannt oder fremd → `null`. */
export function parseHash(hash: string): RouteId | null {
  const match = /^#\/([a-z]+)\/?$/i.exec(hash.trim());
  const candidate = match?.[1]?.toLowerCase();
  return candidate !== undefined && isRouteId(candidate) ? candidate : null;
}

export function hashFor(route: RouteId): string {
  return `#/${route}`;
}
