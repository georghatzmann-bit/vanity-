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
  | { readonly tool: 'desktop_layout'; readonly name: string };

export type ItemKind =
  'move' | 'recycle' | 'remove_empty_dir' | 'set_wallpaper' | 'autostart' | 'desktop_layout';

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
  execute(id: string, digest: string, skip: readonly number[]): Promise<ToolRun>;
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
