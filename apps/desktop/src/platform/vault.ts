/**
 * Passwort-Tresor (P9): Typen und Parser für die App-Befehle `vault_*`. Passwörter kommen nur
 * auf ausdrücklichen Klick (`reveal`, `copy`) in die Oberfläche.
 */

export interface VaultStatus {
  readonly exists: boolean;
  readonly unlocked: boolean;
  readonly lockMinutes: number;
  readonly retryIn: number;
}

export interface VaultEntrySummary {
  readonly id: string;
  readonly title: string;
  readonly username: string;
  readonly urls: readonly string[];
  readonly folder: string;
  readonly tags: readonly string[];
  readonly favorite: boolean;
  readonly modified: number;
  readonly passwordChanged: number;
  readonly hasNotes: boolean;
  readonly hasPassword: boolean;
}

export interface VaultList {
  readonly entries: readonly VaultEntrySummary[];
  readonly folders: readonly string[];
  readonly weak: readonly string[];
  readonly reused: readonly string[];
}

export interface VaultEntryInput {
  readonly title: string;
  readonly username: string;
  readonly password: string;
  readonly urls: readonly string[];
  readonly notes: string;
  readonly folder: string;
  readonly tags: readonly string[];
  readonly favorite: boolean;
}

export interface GenerateOptions {
  readonly length: number;
  readonly lower: boolean;
  readonly upper: boolean;
  readonly digits: boolean;
  readonly symbols: boolean;
  readonly avoidAmbiguous: boolean;
}

export const strengthLevels = ['very_weak', 'weak', 'fair', 'strong', 'very_strong'] as const;
export type StrengthLevel = (typeof strengthLevels)[number];

export interface VaultApi {
  status(): Promise<VaultStatus>;
  setup(master: string): Promise<void>;
  unlock(master: string): Promise<void>;
  lock(): Promise<void>;
  setLockMinutes(minutes: number): Promise<void>;
  list(): Promise<VaultList>;
  reveal(id: string): Promise<{ readonly password: string; readonly notes: string }>;
  save(id: string | null, entry: VaultEntryInput): Promise<string>;
  remove(id: string): Promise<void>;
  copy(id: string, field: 'password' | 'username'): Promise<number>;
  generate(options: GenerateOptions): Promise<string>;
  strength(password: string): Promise<{ readonly level: StrengthLevel; readonly bits: number }>;
  importCsv(path: string): Promise<{ readonly imported: number; readonly skipped: number }>;
  changeMaster(old: string, next: string): Promise<void>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strs = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .slice(0, max)
        .map((x) => str(x))
        .filter((x) => x !== '')
    : [];

export function parseVaultStatus(raw: unknown): VaultStatus {
  const o = isObj(raw) ? raw : {};
  return {
    exists: o.exists === true,
    unlocked: o.unlocked === true,
    lockMinutes: num(o.lockMinutes) || 5,
    retryIn: num(o.retryIn),
  };
}

export function parseVaultList(raw: unknown): VaultList {
  const o = isObj(raw) ? raw : {};
  const entries = Array.isArray(o.entries)
    ? o.entries
        .filter(isObj)
        .slice(0, 20_000)
        .map((e): VaultEntrySummary => ({
          id: str(e.id, 64),
          title: str(e.title, 200),
          username: str(e.username, 300),
          urls: strs(e.urls, 20),
          folder: str(e.folder, 200),
          tags: strs(e.tags, 20),
          favorite: e.favorite === true,
          modified: num(e.modified),
          passwordChanged: num(e.passwordChanged),
          hasNotes: e.hasNotes === true,
          hasPassword: e.hasPassword === true,
        }))
    : [];
  return {
    entries: entries.filter((e) => e.id !== ''),
    folders: strs(o.folders, 500),
    weak: strs(o.weak, 20_000),
    reused: strs(o.reused, 20_000),
  };
}

export function parseStrength(raw: unknown): { level: StrengthLevel; bits: number } {
  const o = isObj(raw) ? raw : {};
  const level = (strengthLevels as readonly unknown[]).includes(o.level)
    ? (o.level as StrengthLevel)
    : 'very_weak';
  return { level, bits: num(o.bits) };
}

/** Bekannte Fehlerkennungen der Befehle (sonst `null` = Text anzeigen). */
export function vaultErrorCode(
  error: unknown,
): 'locked' | 'wrong_password' | 'wait' | 'windows_only' | null {
  return error === 'locked' ||
    error === 'wrong_password' ||
    error === 'wait' ||
    error === 'windows_only'
    ? error
    : null;
}
