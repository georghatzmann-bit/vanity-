/** Signierte Updates (P13): Stand und Aufrufe. Netz nur auf Klick. */

export interface UpdateView {
  /** Updates in diesem Build möglich (Signaturschlüssel eingebaut)? */
  readonly enabled: boolean;
  readonly current: string;
  readonly latest: string | null;
  readonly notes: string;
  readonly newer: boolean;
  /** Geprüft heruntergeladen. */
  readonly ready: boolean;
}

export interface UpdatesApi {
  status(): Promise<UpdateView>;
  check(): Promise<UpdateView>;
  download(): Promise<UpdateView>;
  install(): Promise<void>;
}

export function parseUpdate(v: unknown): UpdateView {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const text = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');
  return {
    enabled: o['enabled'] === true,
    current: text(o['current'], 32),
    latest: typeof o['latest'] === 'string' ? o['latest'].slice(0, 32) : null,
    notes: text(o['notes'], 2000),
    newer: o['newer'] === true,
    ready: o['ready'] === true,
  };
}
