/** Einstellungen und Status der Erweiterung (in `chrome.storage.local`, nur auf diesem Gerät). */

export interface Settings {
  /** Listen täglich aus dem Netz aktualisieren (abschaltbar; ohne: nur mitgelieferte Liste). */
  readonly updateLists: boolean;
  /** Hinweis-Banner bei Betrugsmerkmalen auf Seiten. */
  readonly pageHints: boolean;
  /** Hinweise bei riskanten Downloads. */
  readonly downloadHints: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  updateLists: true,
  pageHints: true,
  downloadHints: true,
};

export interface SourceStatus {
  readonly id: string;
  readonly domains: number;
  readonly ok: boolean;
  readonly error?: string;
}

export interface ListStatus {
  /** Zeitpunkt der letzten Aktualisierung (ms seit 1970) oder 0. */
  readonly updatedAt: number;
  readonly sources: readonly SourceStatus[];
  /** Aktive dynamische Domains. */
  readonly domains: number;
}

export const EMPTY_STATUS: ListStatus = { updatedAt: 0, sources: [], domains: 0 };

/** Liest gespeicherte Einstellungen tolerant (unbekannte/falsche Werte → Standard). */
export function readSettings(raw: unknown): Settings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof Settings): boolean =>
    typeof o[key] === 'boolean' ? (o[key] as boolean) : DEFAULT_SETTINGS[key];
  return {
    updateLists: flag('updateLists'),
    pageHints: flag('pageHints'),
    downloadHints: flag('downloadHints'),
  };
}

/** Liest den gespeicherten Status tolerant. */
export function readStatus(raw: unknown): ListStatus {
  if (typeof raw !== 'object' || raw === null) {
    return EMPTY_STATUS;
  }
  const o = raw as Record<string, unknown>;
  const sources = Array.isArray(o.sources)
    ? o.sources.flatMap((s): SourceStatus[] => {
        if (typeof s !== 'object' || s === null) {
          return [];
        }
        const r = s as Record<string, unknown>;
        if (
          typeof r.id !== 'string' ||
          typeof r.domains !== 'number' ||
          typeof r.ok !== 'boolean'
        ) {
          return [];
        }
        return [
          typeof r.error === 'string'
            ? { id: r.id, domains: r.domains, ok: r.ok, error: r.error }
            : { id: r.id, domains: r.domains, ok: r.ok },
        ];
      })
    : [];
  return {
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    sources,
    domains: typeof o.domains === 'number' ? o.domains : 0,
  };
}

/** Ist eine Aktualisierung fällig? */
export function updateDue(status: ListStatus, now: number, minutes: number): boolean {
  return now - status.updatedAt >= minutes * 60_000 || status.updatedAt > now;
}

/** Nachrichten der eigenen Seiten an den Hintergrund. */
export type Message =
  | { readonly type: 'blocked-url' }
  | { readonly type: 'allow-once' }
  | { readonly type: 'update-now' };

export function isMessage(raw: unknown): raw is Message {
  const t = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : null;
  return t === 'blocked-url' || t === 'allow-once' || t === 'update-now';
}
