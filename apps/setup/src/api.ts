/**
 * Schnittstelle des Setup-Fensters zum Rust-Teil. Antworten werden streng geprüft.
 */

export interface Info {
  readonly version: string;
  /** Signaturschlüssel eingebaut (sonst prüft und lädt das Setup nichts). */
  readonly enabled: boolean;
  readonly defaultDir: string;
  readonly windows: boolean;
  /** Offline-Setup: alles eingebettet, kein Download nötig. */
  readonly offline: boolean;
  /** Eingebettete Pakete (nur Offline-Setup). */
  readonly components: readonly Component[];
}

export interface Component {
  readonly kind: 'app' | 'browser';
  readonly name: string;
  readonly size: number;
}

export interface Offer {
  readonly version: string;
  /** Veröffentlicht am (`JJJJ-MM-TT`). */
  readonly published: string;
  readonly notes: string;
  readonly components: readonly Component[];
}

export interface Progress {
  readonly name: string;
  readonly done: number;
  readonly total: number;
  readonly stage: 'download' | 'verify' | 'ok';
}

export interface SetupApi {
  info(): Promise<Info>;
  check(): Promise<Offer>;
  download(browser: boolean): Promise<void>;
  install(browser: boolean): Promise<void>;
  launch(): Promise<void>;
  onProgress(listener: (p: Progress) => void): Promise<() => void>;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function parseComponents(v: unknown): readonly Component[] {
  const list = Array.isArray(v) ? (v as unknown[]) : [];
  return list
    .filter(isObject)
    .filter((c) => c['kind'] === 'app' || c['kind'] === 'browser')
    .slice(0, 8)
    .map((c) => ({
      kind: c['kind'] === 'browser' ? ('browser' as const) : ('app' as const),
      name: str(c['name'], 200),
      size: num(c['size']),
    }));
}

export function parseInfo(v: unknown): Info {
  const o = isObject(v) ? v : {};
  return {
    version: str(o['version'], 32),
    enabled: o['enabled'] === true,
    defaultDir: str(o['defaultDir'], 260),
    windows: o['windows'] === true,
    offline: o['offline'] === true,
    components: parseComponents(o['components']),
  };
}

export function parseOffer(v: unknown): Offer {
  const o = isObject(v) ? v : {};
  const list = Array.isArray(o['components']) ? (o['components'] as unknown[]) : [];
  return {
    version: str(o['version'], 32),
    published:
      typeof o['published'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o['published'])
        ? o['published']
        : '',
    notes: str(o['notes'], 2000),
    components: parseComponents(list),
  };
}

export function parseProgress(v: unknown): Progress {
  const o = isObject(v) ? v : {};
  const stage = o['stage'];
  return {
    name: str(o['name'], 200),
    done: num(o['done']),
    total: num(o['total']),
    stage: stage === 'verify' || stage === 'ok' ? stage : 'download',
  };
}

/** Größe für Menschen (MB mit einer Nachkommastelle). */
export function megabytes(bytes: number, lang: 'de' | 'en'): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toLocaleString(lang === 'de' ? 'de-DE' : 'en-GB', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} MB`;
}

/** Echte Anbindung über Tauri. */
export async function tauriApi(): Promise<SetupApi> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  return {
    info: async () => parseInfo(await invoke<unknown>('setup_info')),
    check: async () => parseOffer(await invoke<unknown>('setup_check')),
    download: (browser) => invoke('setup_download', { browser }),
    install: (browser) => invoke('setup_install', { browser }),
    launch: () => invoke('setup_launch'),
    onProgress: (listener) =>
      listen<unknown>('setup://progress', (e) => listener(parseProgress(e.payload))),
  };
}
