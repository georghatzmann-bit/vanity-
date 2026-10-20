/**
 * Windows-Tools (P10): Typen und Parser für die App-Befehle `tools_*`. Jede Änderung beginnt
 * als Vorschau; „Ausführen“ schickt Kennung und Prüfsumme genau dieser Vorschau zurück.
 */

export const categories = [
  'images',
  'documents',
  'archives',
  'programs',
  'audio',
  'video',
  'code',
  'other',
] as const;
export type Category = (typeof categories)[number];

export const toolIds = [
  'sort_downloads',
  'source_folders',
  'rules',
  'desktop_layout',
  'wallpaper',
  'duplicates',
  'large_old',
  'empty_folders',
  'cleaner',
  'autostart',
  'shredder',
  'rename',
  'explorer_tweaks',
  'privacy',
] as const;
export type ToolId = (typeof toolIds)[number];

export type AutostartLocation =
  'run_user' | 'startup_folder_user' | 'run_machine' | 'startup_folder_machine';

export interface AutostartRef {
  readonly location: AutostartLocation;
  readonly name: string;
}

export interface AutostartEntry {
  readonly entry: AutostartRef;
  readonly command: string;
  readonly enabled: boolean;
  readonly editable: boolean;
}

export type PreviewRequest =
  | {
      readonly tool: 'sort_downloads';
      readonly folder: string;
      readonly categories: readonly Category[];
    }
  | {
      readonly tool: 'source_folders';
      readonly folder: string;
      readonly mappings: readonly { readonly host: string; readonly target: string }[];
    }
  | { readonly tool: 'rules'; readonly id: string }
  | { readonly tool: 'wallpaper'; readonly path: string }
  | { readonly tool: 'duplicates'; readonly roots: readonly string[]; readonly minSize: number }
  | {
      readonly tool: 'large_old';
      readonly roots: readonly string[];
      readonly minSize: number;
      readonly days: number;
    }
  | { readonly tool: 'empty_folders'; readonly root: string }
  | { readonly tool: 'cleaner'; readonly days: number }
  | {
      readonly tool: 'autostart';
      readonly changes: readonly { readonly entry: AutostartRef; readonly enable: boolean }[];
    }
  | { readonly tool: 'desktop_layout'; readonly name: string }
  | { readonly tool: 'shredder'; readonly paths: readonly string[] }
  | { readonly tool: 'rename'; readonly folder: string; readonly options: RenameOptions }
  | {
      readonly tool: 'tweaks';
      readonly changes: readonly { readonly id: string; readonly on: boolean }[];
    };

export interface RenameOptions {
  readonly pattern: string;
  readonly find: string;
  readonly replace: string;
  readonly start: number;
  readonly digits: number;
  readonly case: 'keep' | 'lower' | 'upper';
  readonly extensions: readonly string[];
}

export const tweakIds = [
  'show_extensions',
  'show_hidden',
  'open_this_pc',
  'taskbar_left',
  'hide_task_view',
  'classic_context_menu',
  'no_advertising_id',
  'no_tailored_experiences',
  'no_launch_tracking',
  'no_start_suggestions',
  'no_settings_suggestions',
  'no_tips',
  'no_language_list',
  'no_ink_collection',
  'no_text_collection',
  'no_online_speech',
  'no_bing_search',
] as const;
export type TweakId = (typeof tweakIds)[number];

export interface TweakState {
  readonly id: TweakId;
  readonly group: 'explorer' | 'privacy';
  readonly on: boolean;
}

export type HostKind = 'default' | 'block' | 'suspicious' | 'redirect';

export interface HostsReport {
  readonly path: string;
  readonly entries: readonly {
    readonly line: number;
    readonly address: string;
    readonly host: string;
    readonly kind: HostKind;
  }[];
}

export type HealthFinding = 'low_disk' | 'critical_disk' | 'long_uptime' | 'low_memory';

export interface SystemReport {
  readonly info: {
    readonly os: string;
    readonly version: string;
    readonly build: string;
    readonly cpu: string;
    readonly cores: number;
    readonly memory: readonly [number, number] | null;
    readonly uptime: number;
    readonly drives: readonly {
      readonly root: string;
      readonly free: number;
      readonly total: number;
    }[];
    readonly computer: string;
  };
  readonly findings: readonly HealthFinding[];
}

export type ItemKind =
  | 'move'
  | 'recycle'
  | 'remove_empty_dir'
  | 'set_wallpaper'
  | 'autostart'
  | 'desktop_layout'
  | 'registry'
  | 'shred';

export interface PreviewItem {
  readonly label: string;
  readonly kind: ItemKind;
  readonly size: number;
}

export interface FileInfo {
  readonly path: string;
  readonly size: number;
  readonly modified: number;
}

export interface DuplicateGroup {
  readonly size: number;
  readonly hash: string;
  readonly files: readonly FileInfo[];
}

export interface Preview {
  readonly needsFinal: boolean;
  readonly id: string;
  readonly digest: string;
  readonly tool: ToolId;
  readonly items: readonly PreviewItem[];
  readonly totalSize: number;
  readonly groups: readonly DuplicateGroup[];
}

export type ItemStatus = 'done' | 'skipped' | 'failed' | 'undone';

export interface RunItem {
  readonly label: string;
  readonly status: ItemStatus;
  readonly reason: string | null;
}

export interface ToolRun {
  readonly id: string;
  readonly tool: ToolId;
  readonly rule: string | null;
  readonly at: number;
  readonly undone: number | null;
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
  /** Lässt sich etwas zurücknehmen? (Shredder: nie.) */
  readonly undoable: boolean;
  readonly items: readonly RunItem[];
}

export interface RuleCondition {
  readonly categories: readonly Category[];
  readonly extensions: readonly string[];
  readonly nameContains: string;
  readonly sourceHost: string;
}

export interface ToolRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly watch: boolean;
  readonly folder: string;
  readonly condition: RuleCondition;
  readonly target: string;
}

export interface FolderSize {
  readonly path: string;
  readonly size: number;
  readonly files: number;
}

export interface SpaceReport {
  readonly total: number;
  readonly files: number;
  readonly children: readonly FolderSize[];
  readonly largest: readonly FileInfo[];
  readonly byCategory: readonly (readonly [Category, number])[];
  readonly disk: readonly [number, number] | null;
}

export interface ToolDefaults {
  readonly downloads: string | null;
  readonly pictures: string | null;
  readonly desktop: string | null;
  readonly cleaner: readonly string[];
  readonly windows: boolean;
}

export interface DesktopLayout {
  readonly name: string;
  readonly saved: number;
  readonly icons: readonly { readonly name: string; readonly x: number; readonly y: number }[];
}

export interface ToolsApi {
  preview(request: PreviewRequest): Promise<Preview>;
  /**
   * Führt die Vorschau aus. Bei endgültigem Löschen kommt zuerst der Fehler
   * `confirm_final:<kennung>`; erst mit dieser Kennung aus dem zweiten Dialog (`confirm`)
   * passiert etwas.
   */
  execute(id: string, digest: string, skip: readonly number[], confirm?: string): Promise<ToolRun>;
  runs(): Promise<readonly ToolRun[]>;
  undo(id: string): Promise<readonly string[]>;
  space(root: string): Promise<SpaceReport>;
  autostart(): Promise<readonly AutostartEntry[]>;
  defaults(): Promise<ToolDefaults>;
  rules(): Promise<readonly ToolRule[]>;
  saveRule(rule: ToolRule): Promise<ToolRule>;
  deleteRule(id: string): Promise<void>;
  layouts(): Promise<readonly DesktopLayout[]>;
  saveLayout(name: string): Promise<DesktopLayout>;
  deleteLayout(name: string): Promise<void>;
  tweaks(): Promise<readonly TweakState[]>;
  hosts(): Promise<HostsReport>;
  system(): Promise<SystemReport>;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

const itemKinds: readonly ItemKind[] = [
  'move',
  'recycle',
  'remove_empty_dir',
  'set_wallpaper',
  'autostart',
  'desktop_layout',
  'registry',
  'shred',
];
const statuses: readonly ItemStatus[] = ['done', 'skipped', 'failed', 'undone'];
const locations: readonly AutostartLocation[] = [
  'run_user',
  'startup_folder_user',
  'run_machine',
  'startup_folder_machine',
];

function parseFile(v: unknown): FileInfo {
  const o = rec(v);
  return { path: str(o['path']), size: num(o['size']), modified: num(o['modified']) };
}

export function parsePreview(v: unknown): Preview {
  const o = rec(v);
  const id = str(o['id']);
  const digest = str(o['digest']);
  if (id === '' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new TypeError('tools_preview: unerwartete Antwort.');
  }
  return {
    needsFinal: o['needsFinal'] === true,
    id,
    digest,
    tool: oneOf(toolIds, o['tool'], 'rules'),
    items: arr(o['items']).map((i) => {
      const r = rec(i);
      return {
        label: str(r['label']),
        kind: oneOf(itemKinds, r['kind'], 'move'),
        size: num(r['size']),
      };
    }),
    totalSize: num(o['totalSize']),
    groups: arr(o['groups']).map((g) => {
      const r = rec(g);
      return { size: num(r['size']), hash: str(r['hash']), files: arr(r['files']).map(parseFile) };
    }),
  };
}

export function parseRun(v: unknown): ToolRun {
  const o = rec(v);
  return {
    id: str(o['id']),
    tool: oneOf(toolIds, o['tool'], 'rules'),
    rule: strOrNull(o['rule']),
    at: num(o['at']),
    undone: numOrNull(o['undone']),
    done: num(o['done']),
    skipped: num(o['skipped']),
    failed: num(o['failed']),
    undoable: o['undoable'] === true,
    items: arr(o['items']).map((i) => {
      const r = rec(i);
      return {
        label: str(r['label']),
        status: oneOf(statuses, r['status'], 'failed'),
        reason: strOrNull(r['reason']),
      };
    }),
  };
}

export function parseRule(v: unknown): ToolRule {
  const o = rec(v);
  const c = rec(o['condition']);
  return {
    id: str(o['id']),
    name: str(o['name']),
    enabled: o['enabled'] === true,
    watch: o['watch'] === true,
    folder: str(o['folder']),
    condition: {
      categories: arr(c['categories']).filter((x): x is Category =>
        (categories as readonly unknown[]).includes(x),
      ),
      extensions: arr(c['extensions'])
        .map(str)
        .filter((x) => x !== ''),
      nameContains: str(c['nameContains']),
      sourceHost: str(c['sourceHost']),
    },
    target: str(o['target']),
  };
}

export function parseSpace(v: unknown): SpaceReport {
  const o = rec(rec(v)['space']);
  const disk = arr(o['disk']);
  return {
    total: num(o['total']),
    files: num(o['files']),
    children: arr(o['children']).map((c) => {
      const r = rec(c);
      return { path: str(r['path']), size: num(r['size']), files: num(r['files']) };
    }),
    largest: arr(o['largest']).map(parseFile),
    byCategory: arr(o['byCategory']).map((p) => {
      const pair = arr(p);
      return [oneOf(categories, pair[0], 'other'), num(pair[1])] as const;
    }),
    disk: disk.length === 2 ? [num(disk[0]), num(disk[1])] : null,
  };
}

export function parseAutostart(v: unknown): readonly AutostartEntry[] {
  return arr(rec(v)['entries']).map((e) => {
    const o = rec(e);
    const r = rec(o['entry']);
    return {
      entry: { location: oneOf(locations, r['location'], 'run_machine'), name: str(r['name']) },
      command: str(o['command']),
      enabled: o['enabled'] !== false,
      editable: o['editable'] === true,
    };
  });
}

export function parseDefaults(v: unknown): ToolDefaults {
  const o = rec(rec(v)['defaults']);
  return {
    downloads: strOrNull(o['downloads']),
    pictures: strOrNull(o['pictures']),
    desktop: strOrNull(o['desktop']),
    cleaner: arr(o['cleaner'])
      .map(str)
      .filter((x) => x !== ''),
    windows: o['windows'] === true,
  };
}

export function parseLayout(v: unknown): DesktopLayout {
  const o = rec(v);
  return {
    name: str(o['name']),
    saved: num(o['saved']),
    icons: arr(o['icons']).map((i) => {
      const r = rec(i);
      return { name: str(r['name']), x: num(r['x']), y: num(r['y']) };
    }),
  };
}

/** Byte als lesbare Größe (de/en). */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit] ?? 'B'}`;
}

/** Kennung der zweiten Bestätigung aus dem Fehler von `execute` (sonst `null`). */
export function finalChallenge(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^confirm_final:([0-9a-f]{16,64})$/.exec(text);
  return match?.[1] ?? null;
}

export function parseTweaks(v: unknown): readonly TweakState[] {
  return arr(rec(v)['tweaks']).flatMap((x) => {
    const o = rec(x);
    const id = o['id'];
    if (typeof id !== 'string' || !(tweakIds as readonly string[]).includes(id)) {
      return [];
    }
    return {
      id: id as TweakId,
      group: o['group'] === 'privacy' ? 'privacy' : 'explorer',
      on: o['on'] === true,
    };
  });
}

const hostKinds: readonly HostKind[] = ['default', 'block', 'suspicious', 'redirect'];

export function parseHosts(v: unknown): HostsReport {
  const o = rec(rec(v)['hosts']);
  return {
    path: str(o['path']),
    entries: arr(o['entries']).map((e) => {
      const r = rec(e);
      return {
        line: num(r['line']),
        address: str(r['address']),
        host: str(r['host']),
        kind: oneOf(hostKinds, r['kind'], 'redirect'),
      };
    }),
  };
}

const findings: readonly HealthFinding[] = [
  'low_disk',
  'critical_disk',
  'long_uptime',
  'low_memory',
];

export function parseSystem(v: unknown): SystemReport {
  const o = rec(rec(v)['system']);
  const i = rec(o['info']);
  const memory = arr(i['memory']);
  return {
    info: {
      os: str(i['os']),
      version: str(i['version']),
      build: str(i['build']),
      cpu: str(i['cpu']),
      cores: num(i['cores']),
      memory: memory.length === 2 ? [num(memory[0]), num(memory[1])] : null,
      uptime: num(i['uptime']),
      drives: arr(i['drives']).map((d) => {
        const r = rec(d);
        return { root: str(r['root']), free: num(r['free']), total: num(r['total']) };
      }),
      computer: str(i['computer']),
    },
    findings: arr(o['findings']).filter((f): f is HealthFinding =>
      (findings as readonly unknown[]).includes(f),
    ),
  };
}
