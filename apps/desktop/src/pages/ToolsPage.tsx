/**
 * Windows-Tools (P10): Jedes Werkzeug erstellt zuerst eine Vorschau; erst „Ausführen“ ändert
 * etwas, und zwar genau die gezeigten (nicht abgewählten) Schritte. Jeder Lauf steht im
 * Protokoll und lässt sich zurücknehmen. Regeln handeln nur, wenn der Nutzer sie einschaltet.
 */
import { Button, Panel, SafeText, Toggle } from '@aegis/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { TextKey } from '../i18n/translator.ts';
import { usePlatform } from '../platform/PlatformContext.tsx';
import {
  categories,
  formatBytes,
  type AutostartEntry,
  type AutostartRef,
  type Category,
  type DesktopLayout,
  type SpaceReport,
  type ToolDefaults,
  type ToolRule,
  type ToolRun,
  type ToolsApi,
} from '../platform/tools.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import {
  HostsTool,
  LinksTool,
  RenameTool,
  ShredderTool,
  SystemTool,
  TweaksTool,
} from './ToolsExtra.tsx';
import { FolderPicker, NumberField, PreviewFlow, TextField, message } from './ToolsShared.tsx';

type Tab =
  | 'sort_downloads'
  | 'source_folders'
  | 'rules'
  | 'space'
  | 'duplicates'
  | 'large_old'
  | 'empty_folders'
  | 'cleaner'
  | 'desktop_layout'
  | 'wallpaper'
  | 'autostart'
  | 'shredder'
  | 'rename'
  | 'explorer_tweaks'
  | 'privacy'
  | 'hosts'
  | 'system'
  | 'more'
  | 'log';

const groups: readonly (readonly ['order' | 'clean' | 'system', readonly Tab[]])[] = [
  ['order', ['sort_downloads', 'source_folders', 'rules', 'rename']],
  ['clean', ['duplicates', 'space', 'large_old', 'empty_folders', 'cleaner', 'shredder']],
  [
    'system',
    [
      'desktop_layout',
      'wallpaper',
      'autostart',
      'explorer_tweaks',
      'privacy',
      'hosts',
      'system',
      'more',
    ],
  ],
];

function CategoryChoice({
  value,
  onChange,
}: {
  readonly value: readonly Category[];
  readonly onChange: (value: readonly Category[]) => void;
}) {
  const { t } = useT();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-text-muted">{t('toolbox.categories')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {categories.map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              className="accent-accent"
              checked={value.includes(c)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, c] : value.filter((x) => x !== c))
              }
            />
            {t(`toolbox.category.${c}` satisfies TextKey)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SortTool({
  tools,
  defaults,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly defaults: ToolDefaults | null;
  readonly onDone: () => void;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const [chosen, setChosen] = useState<readonly Category[]>(categories);
  const target = folder ?? defaults?.downloads ?? null;
  return (
    <div className="space-y-4">
      <FolderPicker value={target} onChange={setFolder} defaults={defaults} />
      <CategoryChoice value={chosen} onChange={setChosen} />
      <PreviewFlow
        tools={tools}
        onDone={onDone}
        request={
          target === null || chosen.length === 0
            ? null
            : { tool: 'sort_downloads', folder: target, categories: chosen }
        }
      />
    </div>
  );
}

interface Mapping {
  readonly host: string;
  readonly target: string;
}

function SourceTool({
  tools,
  defaults,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly defaults: ToolDefaults | null;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const [folder, setFolder] = useState<string | null>(null);
  const [mappings, setMappings] = useState<readonly Mapping[]>([
    { host: 'claude.ai', target: 'Claude-Tools' },
  ]);
  const [saved, setSaved] = useState<string | null>(null);
  const target = folder ?? defaults?.downloads ?? null;
  const valid = mappings.filter((m) => m.host.trim() !== '' && m.target.trim() !== '');
  const update = (index: number, change: Partial<Mapping>) =>
    setMappings(mappings.map((m, i) => (i === index ? { ...m, ...change } : m)));
  return (
    <div className="space-y-4">
      <FolderPicker value={target} onChange={setFolder} defaults={defaults} />
      <ul className="space-y-3">
        {mappings.map((m, index) => (
          <li
            key={index}
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto_auto]"
          >
            <TextField
              label={t('toolbox.host')}
              value={m.host}
              onChange={(host) => update(index, { host })}
            />
            <TextField
              label={t('toolbox.target')}
              value={m.target}
              onChange={(value) => update(index, { target: value })}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={target === null || m.host.trim() === '' || m.target.trim() === ''}
              onClick={() =>
                void tools
                  .saveRule({
                    id: '',
                    name: `${m.host} → ${m.target}`,
                    enabled: false,
                    watch: false,
                    folder: target ?? '',
                    condition: {
                      categories: [],
                      extensions: [],
                      nameContains: '',
                      sourceHost: m.host,
                    },
                    target: m.target,
                  })
                  .then(
                    (rule) => setSaved(rule.name),
                    (e: unknown) => setSaved(message(e)),
                  )
              }
            >
              {t('toolbox.asRule')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMappings(mappings.filter((_, i) => i !== index))}
            >
              {t('toolbox.remove')}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setMappings([...mappings, { host: '', target: '' }])}
      >
        {t('toolbox.addMapping')}
      </Button>
      {saved !== null && (
        <p role="status" className="text-sm text-text-muted">
          <SafeText value={saved} />
        </p>
      )}
      <PreviewFlow
        tools={tools}
        onDone={onDone}
        request={
          target === null || valid.length === 0
            ? null
            : { tool: 'source_folders', folder: target, mappings: valid }
        }
      />
    </div>
  );
}

const emptyRule: ToolRule = {
  id: '',
  name: '',
  enabled: false,
  watch: false,
  folder: '',
  condition: { categories: [], extensions: [], nameContains: '', sourceHost: '' },
  target: '',
};

function RuleEditor({
  initial,
  defaults,
  onSave,
  onCancel,
}: {
  readonly initial: ToolRule;
  readonly defaults: ToolDefaults | null;
  readonly onSave: (rule: ToolRule) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const { t } = useT();
  const [rule, setRule] = useState<ToolRule>(
    initial.folder === '' ? { ...initial, folder: defaults?.downloads ?? '' } : initial,
  );
  const [error, setError] = useState<string | null>(null);
  const [extensions, setExtensions] = useState(initial.condition.extensions.join(', '));
  const condition = rule.condition;
  return (
    <form
      className="space-y-4 rounded-xl border border-border bg-surface-2 p-4"
      aria-label={initial.id === '' ? t('toolbox.ruleNew') : t('toolbox.ruleEdit')}
      onSubmit={(e) => {
        e.preventDefault();
        const next: ToolRule = {
          ...rule,
          condition: {
            ...condition,
            extensions: extensions
              .split(/[\s,;]+/)
              .map((x) => x.trim())
              .filter((x) => x !== ''),
          },
        };
        onSave(next).catch((err: unknown) => setError(message(err)));
      }}
    >
      <TextField
        label={t('toolbox.ruleName')}
        value={rule.name}
        onChange={(name) => setRule({ ...rule, name })}
      />
      <FolderPicker
        value={rule.folder === '' ? null : rule.folder}
        onChange={(folder) => setRule({ ...rule, folder })}
        defaults={defaults}
      />
      <CategoryChoice
        value={condition.categories}
        onChange={(c) => setRule({ ...rule, condition: { ...condition, categories: c } })}
      />
      <TextField label={t('toolbox.ruleExtensions')} value={extensions} onChange={setExtensions} />
      <TextField
        label={t('toolbox.ruleNameContains')}
        value={condition.nameContains}
        onChange={(v) => setRule({ ...rule, condition: { ...condition, nameContains: v } })}
      />
      <TextField
        label={t('toolbox.ruleSource')}
        value={condition.sourceHost}
        onChange={(v) => setRule({ ...rule, condition: { ...condition, sourceHost: v } })}
      />
      <p className="text-xs text-text-muted">{t('toolbox.ruleSourceHint')}</p>
      <TextField
        label={t('toolbox.target')}
        value={rule.target}
        onChange={(target) => setRule({ ...rule, target })}
      />
      <Toggle
        label={t('toolbox.ruleEnabled')}
        checked={rule.enabled}
        onCheckedChange={(enabled) => setRule({ ...rule, enabled })}
      />
      <Toggle
        label={t('toolbox.ruleWatch')}
        checked={rule.watch}
        onCheckedChange={(watch) => setRule({ ...rule, watch })}
      />
      <p className="text-xs text-text-muted">{t('toolbox.ruleWatchHint')}</p>
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          <SafeText value={error} />
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary">
          {t('toolbox.ruleSave')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('toolbox.cancel')}
        </Button>
      </div>
    </form>
  );
}

function RulesTool({
  tools,
  defaults,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly defaults: ToolDefaults | null;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const [rules, setRules] = useState<readonly ToolRule[] | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<ToolRule | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ToolRule | null>(null);

  useEffect(() => {
    let active = true;
    void tools.rules().then((r) => {
      if (active) {
        setRules(r);
      }
    });
    return () => {
      active = false;
    };
  }, [tools, version]);

  const save = async (rule: ToolRule) => {
    await tools.saveRule(rule);
    setEditing(null);
    setVersion((v) => v + 1);
  };

  return (
    <div className="space-y-4">
      {editing !== null ? (
        <RuleEditor
          initial={editing}
          defaults={defaults}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <Button variant="secondary" onClick={() => setEditing(emptyRule)}>
          {t('toolbox.ruleNew')}
        </Button>
      )}
      {rules === null ? (
        <p className="text-sm text-text-muted">{t('toolbox.loading')}</p>
      ) : rules.length === 0 ? (
        <p className="text-sm text-text-muted">{t('toolbox.rulesEmpty')}</p>
      ) : (
        <ul className="space-y-3" data-testid="rules-list">
          {rules.map((rule) => (
            <li key={rule.id} className="space-y-3 rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium text-text">
                  <SafeText value={rule.name} />
                </p>
                <p className="text-xs text-text-subtle">
                  <SafeText value={`${rule.folder} → ${rule.target}`} />
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Toggle
                  size="sm"
                  label={t('toolbox.ruleEnabled')}
                  checked={rule.enabled}
                  onCheckedChange={(enabled) => void save({ ...rule, enabled })}
                />
                <Toggle
                  size="sm"
                  label={t('toolbox.ruleWatch')}
                  checked={rule.watch}
                  onCheckedChange={(watch) => void save({ ...rule, watch })}
                />
                <Button size="sm" variant="ghost" onClick={() => setEditing(rule)}>
                  {t('toolbox.edit')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setApplying(rule.id)}>
                  {t('toolbox.ruleApply')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(rule)}>
                  {t('toolbox.ruleDelete')}
                </Button>
              </div>
              {deleting?.id === rule.id && (
                <div className="flex flex-wrap items-center gap-2 text-sm" role="alert">
                  <span>{t('toolbox.ruleDeleteConfirm', { name: rule.name })}</span>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      void tools.deleteRule(rule.id).then(() => {
                        setDeleting(null);
                        setVersion((v) => v + 1);
                      })
                    }
                  >
                    {t('toolbox.ruleDelete')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                    {t('toolbox.cancel')}
                  </Button>
                </div>
              )}
              {applying === rule.id && (
                <PreviewFlow
                  tools={tools}
                  onDone={onDone}
                  request={{ tool: 'rules', id: rule.id }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FolderList({
  value,
  onChange,
  defaults,
}: {
  readonly value: readonly string[];
  readonly onChange: (value: readonly string[]) => void;
  readonly defaults: ToolDefaults | null;
}) {
  const { t } = useT();
  const pick = usePlatform().pickPaths;
  return (
    <div className="space-y-2">
      <p className="text-sm text-text-muted">{t('toolbox.folders')}</p>
      {value.length === 0 ? (
        <p className="text-sm text-text-subtle">{t('toolbox.noFolder')}</p>
      ) : (
        <ul className="space-y-1 text-sm" data-testid="tool-folders">
          {value.map((f) => (
            <li key={f} className="flex flex-wrap items-center gap-2">
              <SafeText value={f} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange(value.filter((x) => x !== f))}
              >
                {t('toolbox.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {pick !== null && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void pick('folder').then((paths) => {
                const first = paths[0];
                if (first !== undefined && !value.includes(first)) {
                  onChange([...value, first]);
                }
              })
            }
          >
            {t('toolbox.addFolder')}
          </Button>
        )}
        {defaults?.downloads != null && !value.includes(defaults.downloads) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange([...value, defaults.downloads ?? ''])}
          >
            {t('toolbox.useDownloads')}
          </Button>
        )}
      </div>
    </div>
  );
}

function DuplicatesTool({
  tools,
  defaults,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly defaults: ToolDefaults | null;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const [roots, setRoots] = useState<readonly string[]>([]);
  const [minMb, setMinMb] = useState(1);
  return (
    <div className="space-y-4">
      <FolderList value={roots} onChange={setRoots} defaults={defaults} />
      <NumberField label={t('toolbox.minSize')} value={minMb} min={0} onChange={setMinMb} />
      <PreviewFlow
        tools={tools}
        onDone={onDone}
        request={
          roots.length === 0
            ? null
            : { tool: 'duplicates', roots, minSize: Math.round(minMb * 1024 * 1024) }
        }
      />
    </div>
  );
}

function LargeOldTool({
  tools,
  defaults,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly defaults: ToolDefaults | null;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const [roots, setRoots] = useState<readonly string[]>([]);
  const [minMb, setMinMb] = useState(100);
  const [days, setDays] = useState(365);
  return (
    <div className="space-y-4">
      <FolderList value={roots} onChange={setRoots} defaults={defaults} />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField label={t('toolbox.minSize')} value={minMb} min={1} onChange={setMinMb} />
        <NumberField label={t('toolbox.days')} value={days} min={1} onChange={setDays} />
      </div>
      <PreviewFlow
        tools={tools}
        onDone={onDone}
        request={
          roots.length === 0
            ? null
            : { tool: 'large_old', roots, minSize: Math.round(minMb * 1024 * 1024), days }
        }
      />
    </div>
  );
}

function EmptyFoldersTool({
  tools,
  defaults,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly defaults: ToolDefaults | null;
  readonly onDone: () => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <FolderPicker value={root} onChange={setRoot} defaults={defaults} />
      <PreviewFlow
        tools={tools}
        onDone={onDone}
        request={root === null ? null : { tool: 'empty_folders', root }}
      />
    </div>
  );
}

function CleanerTool({
  tools,
  defaults,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly defaults: ToolDefaults | null;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const [days, setDays] = useState(2);
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-text-muted">{t('toolbox.locations')}</p>
        <ul className="mt-1 space-y-1 text-sm text-text">
          {(defaults?.cleaner ?? []).map((l) => (
            <li key={l}>
              <SafeText value={l} />
            </li>
          ))}
        </ul>
      </div>
      <NumberField label={t('toolbox.olderThan')} value={days} min={1} onChange={setDays} />
      <PreviewFlow tools={tools} onDone={onDone} request={{ tool: 'cleaner', days }} />
    </div>
  );
}

function SpaceTool({
  tools,
  defaults,
}: {
  readonly tools: ToolsApi;
  readonly defaults: ToolDefaults | null;
}) {
  const { t, locale } = useT();
  const [root, setRoot] = useState<string | null>(null);
  const [report, setReport] = useState<SpaceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = root ?? defaults?.downloads ?? null;
  const biggest = report?.children[0]?.size ?? 0;
  return (
    <div className="space-y-4">
      <FolderPicker value={target} onChange={setRoot} defaults={defaults} />
      <Button
        variant="secondary"
        loading={busy}
        disabled={target === null}
        onClick={() => {
          if (target === null) {
            return;
          }
          setBusy(true);
          setError(null);
          tools.space(target).then(
            (r) => {
              setReport(r);
              setBusy(false);
            },
            (e: unknown) => {
              setError(message(e));
              setBusy(false);
            },
          );
        }}
      >
        {t('toolbox.analyze')}
      </Button>
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          <SafeText value={error} />
        </p>
      )}
      {report !== null && (
        <div className="space-y-4 text-sm" data-testid="space-report">
          <p className="font-medium text-text">
            {t('toolbox.spaceTotal', {
              size: formatBytes(report.total, locale),
              count: String(report.files),
            })}
          </p>
          {report.disk !== null && (
            <p className="text-text-muted">
              {t('toolbox.spaceDisk', {
                free: formatBytes(report.disk[0], locale),
                total: formatBytes(report.disk[1], locale),
              })}
            </p>
          )}
          <div>
            <p className="mb-2 text-text-muted">{t('toolbox.spaceFolders')}</p>
            <ul className="space-y-2">
              {report.children.slice(0, 20).map((c) => (
                <li key={c.path}>
                  <div className="flex justify-between gap-3">
                    <span className="min-w-0 break-all">
                      <SafeText value={c.path} />
                    </span>
                    <span className="tabular-nums text-text-muted">
                      {formatBytes(c.size, locale)}
                    </span>
                  </div>
                  <div
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full origin-left rounded-full bg-accent motion-safe:transition-transform"
                      style={{ transform: `scaleX(${biggest > 0 ? c.size / biggest : 0})` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-text-muted">{t('toolbox.spaceCategories')}</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {report.byCategory.map(([c, size]) => (
                <li key={c}>
                  {t(`toolbox.category.${c}` satisfies TextKey)}:{' '}
                  <span className="tabular-nums">{formatBytes(size, locale)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-text-muted">{t('toolbox.spaceFiles')}</p>
            <ul className="space-y-1">
              {report.largest.slice(0, 15).map((f) => (
                <li key={f.path} className="flex justify-between gap-3">
                  <span className="min-w-0 break-all">
                    <SafeText value={f.path} />
                  </span>
                  <span className="tabular-nums text-text-muted">
                    {formatBytes(f.size, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function WallpaperTool({
  tools,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const pick = usePlatform().pickPaths;
  const [image, setImage] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <p className="text-sm text-text">
        {image === null ? (
          <span className="text-text-subtle">{t('toolbox.noFolder')}</span>
        ) : (
          <SafeText value={image} />
        )}
      </p>
      {pick !== null && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void pick('files').then((paths) => {
              const first = paths[0];
              if (first !== undefined) {
                setImage(first);
              }
            })
          }
        >
          {t('toolbox.pickImage')}
        </Button>
      )}
      <PreviewFlow
        tools={tools}
        onDone={onDone}
        request={image === null ? null : { tool: 'wallpaper', path: image }}
      />
    </div>
  );
}

function DesktopTool({ tools, onDone }: { readonly tools: ToolsApi; readonly onDone: () => void }) {
  const { t, locale } = useT();
  const [layouts, setLayouts] = useState<readonly DesktopLayout[] | null>(null);
  const [version, setVersion] = useState(0);
  const [name, setName] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void tools.layouts().then((l) => {
      if (active) {
        setLayouts(l);
      }
    });
    return () => {
      active = false;
    };
  }, [tools, version]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <TextField label={t('toolbox.layoutName')} value={name} onChange={setName} />
        </div>
        <Button
          variant="secondary"
          disabled={name.trim() === ''}
          onClick={() =>
            void tools.saveLayout(name.trim()).then(
              () => {
                setName('');
                setError(null);
                setVersion((v) => v + 1);
              },
              (e: unknown) => setError(message(e)),
            )
          }
        >
          {t('toolbox.layoutSave')}
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          <SafeText value={error} />
        </p>
      )}
      {layouts === null ? (
        <p className="text-sm text-text-muted">{t('toolbox.loading')}</p>
      ) : layouts.length === 0 ? (
        <p className="text-sm text-text-muted">{t('toolbox.layoutsEmpty')}</p>
      ) : (
        <ul className="space-y-3">
          {layouts.map((l) => (
            <li key={l.name} className="space-y-2 rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-text">
                  <SafeText value={l.name} />
                </p>
                <p className="text-xs text-text-subtle">
                  {t('toolbox.layoutIcons', { count: String(l.icons.length) })} ·{' '}
                  {new Date(l.saved * 1000).toLocaleString(locale)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setRestoring(l.name)}>
                  {t('toolbox.layoutRestore')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void tools.deleteLayout(l.name).then(() => setVersion((v) => v + 1))
                  }
                >
                  {t('toolbox.deleteLayout')}
                </Button>
              </div>
              {restoring === l.name && (
                <PreviewFlow
                  tools={tools}
                  onDone={onDone}
                  request={{ tool: 'desktop_layout', name: l.name }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function refKey(r: AutostartRef): string {
  return `${r.location}:${r.name}`;
}

function AutostartTool({
  tools,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const [entries, setEntries] = useState<readonly AutostartEntry[] | null>(null);
  const [version, setVersion] = useState(0);
  const [wanted, setWanted] = useState<ReadonlyMap<string, boolean>>(new Map());

  useEffect(() => {
    let active = true;
    void tools.autostart().then((e) => {
      if (active) {
        setEntries(e);
        setWanted(new Map());
      }
    });
    return () => {
      active = false;
    };
  }, [tools, version]);

  const changes = (entries ?? [])
    .filter(
      (e) => e.editable && wanted.has(refKey(e.entry)) && wanted.get(refKey(e.entry)) !== e.enabled,
    )
    .map((e) => ({ entry: e.entry, enable: wanted.get(refKey(e.entry)) ?? e.enabled }));

  const list = (editable: boolean) =>
    (entries ?? [])
      .filter((e) => e.editable === editable)
      .map((e) => (
        <li
          key={refKey(e.entry)}
          className="flex flex-wrap items-center justify-between gap-3 py-2"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">
              <SafeText value={e.entry.name} />
            </p>
            <p className="break-all text-xs text-text-subtle">
              <SafeText value={e.command} />
            </p>
          </div>
          {editable ? (
            <Toggle
              size="sm"
              aria-label={e.entry.name}
              checked={wanted.get(refKey(e.entry)) ?? e.enabled}
              onCheckedChange={(on) => setWanted(new Map(wanted).set(refKey(e.entry), on))}
            />
          ) : (
            <span className="text-xs text-text-muted">
              {e.enabled ? t('toolbox.on') : t('toolbox.off')}
            </span>
          )}
        </li>
      ));

  if (entries === null) {
    return <p className="text-sm text-text-muted">{t('toolbox.loading')}</p>;
  }
  if (entries.length === 0) {
    return <p className="text-sm text-text-muted">{t('toolbox.autostartEmpty')}</p>;
  }
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-text-muted">{t('toolbox.autostartUser')}</p>
        <ul className="divide-y divide-border" data-testid="autostart-list">
          {list(true)}
        </ul>
      </div>
      <div>
        <p className="text-sm text-text-muted">{t('toolbox.autostartMachine')}</p>
        <ul className="divide-y divide-border">{list(false)}</ul>
      </div>
      {changes.length > 0 && (
        <p className="text-sm text-text">
          {t('toolbox.autostartChanged', { count: String(changes.length) })}
        </p>
      )}
      <PreviewFlow
        tools={tools}
        onDone={() => {
          setVersion((v) => v + 1);
          onDone();
        }}
        request={changes.length === 0 ? null : { tool: 'autostart', changes }}
      />
    </div>
  );
}

function LogTool({ tools, version }: { readonly tools: ToolsApi; readonly version: number }) {
  const { t, locale } = useT();
  const [runs, setRuns] = useState<readonly ToolRun[] | null>(null);
  const [own, setOwn] = useState(0);
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let active = true;
    void tools.runs().then((r) => {
      if (active) {
        setRuns(r);
      }
    });
    return () => {
      active = false;
    };
  }, [tools, version, own]);

  if (runs === null) {
    return <p className="text-sm text-text-muted">{t('toolbox.loading')}</p>;
  }
  if (runs.length === 0) {
    return <p className="text-sm text-text-muted">{t('toolbox.logEmpty')}</p>;
  }
  return (
    <ul className="space-y-3" data-testid="tool-log">
      {runs.map((run) => (
        <li key={run.id} className="space-y-2 rounded-xl border border-border p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium text-text">
              {t(`toolbox.tool.${run.tool}` satisfies TextKey)}
              {run.rule !== null && (
                <span className="ml-2 text-text-subtle">({t('toolbox.byRule')})</span>
              )}
            </p>
            <p className="text-xs text-text-subtle tabular-nums">
              {new Date(run.at * 1000).toLocaleString(locale)}
            </p>
          </div>
          <p className="text-text-muted">
            {t('toolbox.result', {
              done: String(run.done),
              skipped: String(run.skipped),
              failed: String(run.failed),
            })}
          </p>
          <details>
            <summary className="cursor-pointer text-text-muted">
              {t('toolbox.previewTitle')}
            </summary>
            <ul className="mt-2 space-y-1">
              {run.items.slice(0, 200).map((item, i) => (
                <li key={`${i}-${item.label}`} className="break-all">
                  <span className="text-text-subtle">
                    {t(`toolbox.status.${item.status}` satisfies TextKey)}
                  </span>{' '}
                  <SafeText value={item.label} />
                  {item.reason !== null && (
                    <span className="text-text-subtle">
                      {' '}
                      – <SafeText value={item.reason} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
          {run.undone !== null ? (
            <p className="text-text-subtle">{notes.get(run.id) ?? t('toolbox.undone')}</p>
          ) : (
            run.done > 0 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void tools.undo(run.id).then(
                    (errors) => {
                      setNotes(
                        new Map(notes).set(
                          run.id,
                          errors.length === 0
                            ? t('toolbox.undone')
                            : `${t('toolbox.undoPartial')} ${errors.join(' · ')}`,
                        ),
                      );
                      setOwn((v) => v + 1);
                    },
                    (e: unknown) => setNotes(new Map(notes).set(run.id, message(e))),
                  )
                }
              >
                {t('toolbox.undo')}
              </Button>
            )
          )}
        </li>
      ))}
    </ul>
  );
}

export function ToolsPage() {
  const { t } = useT();
  const tools = usePlatform().tools;
  const [tab, setTab] = useState<Tab>('sort_downloads');
  const [defaults, setDefaults] = useState<ToolDefaults | null>(null);
  const [logVersion, setLogVersion] = useState(0);

  useEffect(() => {
    if (tools === null) {
      return undefined;
    }
    let active = true;
    void tools.defaults().then((d) => {
      if (active) {
        setDefaults(d);
      }
    });
    return () => {
      active = false;
    };
  }, [tools]);

  const onDone = () => setLogVersion((v) => v + 1);
  const windowsOnly =
    (['wallpaper', 'desktop_layout', 'autostart', 'explorer_tweaks', 'privacy'] as const).some(
      (x) => x === tab,
    ) && defaults?.windows === false;

  let body: ReactNode = null;
  if (tools !== null && !windowsOnly) {
    switch (tab) {
      case 'sort_downloads':
        body = <SortTool tools={tools} defaults={defaults} onDone={onDone} />;
        break;
      case 'source_folders':
        body = <SourceTool tools={tools} defaults={defaults} onDone={onDone} />;
        break;
      case 'rules':
        body = <RulesTool tools={tools} defaults={defaults} onDone={onDone} />;
        break;
      case 'space':
        body = <SpaceTool tools={tools} defaults={defaults} />;
        break;
      case 'duplicates':
        body = <DuplicatesTool tools={tools} defaults={defaults} onDone={onDone} />;
        break;
      case 'large_old':
        body = <LargeOldTool tools={tools} defaults={defaults} onDone={onDone} />;
        break;
      case 'empty_folders':
        body = <EmptyFoldersTool tools={tools} defaults={defaults} onDone={onDone} />;
        break;
      case 'cleaner':
        body = <CleanerTool tools={tools} defaults={defaults} onDone={onDone} />;
        break;
      case 'wallpaper':
        body = <WallpaperTool tools={tools} onDone={onDone} />;
        break;
      case 'desktop_layout':
        body = <DesktopTool tools={tools} onDone={onDone} />;
        break;
      case 'autostart':
        body = <AutostartTool tools={tools} onDone={onDone} />;
        break;
      case 'shredder':
        body = <ShredderTool tools={tools} onDone={onDone} />;
        break;
      case 'rename':
        body = <RenameTool tools={tools} defaults={defaults} onDone={onDone} />;
        break;
      case 'explorer_tweaks':
        body = <TweaksTool tools={tools} group="explorer" onDone={onDone} />;
        break;
      case 'privacy':
        body = <TweaksTool tools={tools} group="privacy" onDone={onDone} />;
        break;
      case 'hosts':
        body = <HostsTool tools={tools} />;
        break;
      case 'system':
        body = <SystemTool tools={tools} />;
        break;
      case 'more':
        body = <LinksTool />;
        break;
      case 'log':
        body = <LogTool tools={tools} version={logVersion} />;
        break;
    }
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.tools.eyebrow')}
        title={t('pages.tools.title')}
        description={t('toolbox.intro')}
      />
      {tools === null ? (
        <Panel title={t('pages.tools.title')}>
          <p className="text-sm text-text-muted" role="status">
            {t('toolbox.preview')}
          </p>
        </Panel>
      ) : (
        <>
          <nav aria-label={t('toolbox.choose')} className="space-y-3">
            {groups.map(([group, tabs]) => (
              <div key={group} className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-xs font-medium uppercase tracking-wide text-text-subtle">
                  {t(`toolbox.group.${group}` satisfies TextKey)}
                </span>
                {tabs.map((id) => (
                  <Button
                    key={id}
                    size="sm"
                    variant={tab === id ? 'primary' : 'ghost'}
                    aria-pressed={tab === id}
                    onClick={() => setTab(id)}
                  >
                    {t(`toolbox.tool.${id}` satisfies TextKey)}
                  </Button>
                ))}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24" />
              <Button
                size="sm"
                variant={tab === 'log' ? 'primary' : 'ghost'}
                aria-pressed={tab === 'log'}
                onClick={() => setTab('log')}
              >
                {t('toolbox.tool.log')}
              </Button>
            </div>
          </nav>
          <Panel title={t(`toolbox.tool.${tab}` satisfies TextKey)}>
            <div className="space-y-4" data-testid={`tool-${tab}`}>
              {tab !== 'log' && (
                <p className="text-sm text-text-muted">
                  {t(`toolbox.hint.${tab}` satisfies TextKey)}
                </p>
              )}
              {windowsOnly ? <p className="text-sm text-warn">{t('toolbox.windowsOnly')}</p> : body}
            </div>
          </Panel>
        </>
      )}
    </PageBody>
  );
}
