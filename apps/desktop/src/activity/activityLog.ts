/**
 * Live-Aktivität: echte Ereignisse der Oberfläche in dieser Sitzung – nur im Arbeitsspeicher,
 * höchstens `ACTIVITY_LIMIT` Einträge (die ältesten fallen heraus). Gespeichert werden
 * Ereignis-Art und Werte, nicht fertige Sätze: Der Text entsteht beim Anzeigen in der
 * aktiven Sprache. Schutz-Ereignisse (Funde, Scans) kommen erst mit dem Dienst (ab P2).
 */
import type { NavigateTarget } from '../platform/platform.ts';
import type { SettingKey, Settings } from '../settings/schema.ts';

export const ACTIVITY_LIMIT = 50;

export type ActivityEvent =
  | { readonly kind: 'app-started'; readonly platform: 'tauri' | 'browser' }
  | {
      readonly kind: 'setting-changed';
      readonly setting: SettingKey;
      readonly value: Settings[SettingKey];
    }
  | { readonly kind: 'boot-replayed' }
  | { readonly kind: 'tray-navigate'; readonly target: NavigateTarget }
  | { readonly kind: 'save-failed' };

export type ActivityEntry = ActivityEvent & {
  readonly id: number;
  /** Zeitpunkt (ms seit Epoche). */
  readonly at: number;
};

export interface ActivityLog {
  /** Neueste zuerst. */
  getSnapshot(): readonly ActivityEntry[];
  subscribe(listener: () => void): () => void;
  record(event: ActivityEvent): void;
}

export function createActivityLog(now: () => number = Date.now): ActivityLog {
  let entries: readonly ActivityEntry[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    record(event) {
      const entry: ActivityEntry = { ...event, id: nextId, at: now() };
      nextId += 1;
      entries = [entry, ...entries].slice(0, ACTIVITY_LIMIT);
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}
