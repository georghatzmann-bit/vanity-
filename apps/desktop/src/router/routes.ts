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
  'defender',
  'vault',
  'tools',
  'quarantine',
  'safe',
  'reports',
  'settings',
  'about',
] as const;

export type RouteId = (typeof routeIds)[number];

export const DEFAULT_ROUTE: RouteId = 'dashboard';

/** Module, die es noch nicht gibt, mit der Phase, in der sie kommen. */
export const routePhases: Readonly<Partial<Record<RouteId, string>>> = {
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
