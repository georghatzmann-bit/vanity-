/**
 * Windows-Tools 12–22 (P11): Shredder (endgültig, zweite Bestätigung, ehrlicher SSD-Hinweis),
 * Batch-Umbenenner, Explorer- und Datenschutz-Schalter (`HKCU`, Rückgängig), Hosts-Ansicht und
 * Systeminfo (nur lesend) sowie Verweise auf Werkzeuge, die AEGIS schon an anderer Stelle hat.
 */
import { Button, SafeText, Toggle } from '@aegis/ui';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { TextKey } from '../i18n/translator.ts';
import { usePlatform } from '../platform/PlatformContext.tsx';
import { hashFor, type RouteId } from '../router/routes.ts';
import {
  formatBytes,
  type HostsReport,
  type RenameOptions,
  type SystemReport,
  type ToolDefaults,
  type ToolsApi,
  type TweakState,
} from '../platform/tools.ts';
import { FolderPicker, NumberField, PreviewFlow, TextField } from './ToolsShared.tsx';

export function ShredderTool({
  tools,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const pick = usePlatform().pickPaths;
  const [paths, setPaths] = useState<readonly string[]>([]);
  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-warn/40 bg-surface-2 p-3 text-sm text-warn">
        {t('toolbox.ssdHint')}
      </p>
      {paths.length === 0 ? (
        <p className="text-sm text-text-subtle">{t('toolbox.noFiles')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {paths.map((p) => (
            <li key={p} className="flex flex-wrap items-center gap-2">
              <SafeText value={p} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPaths(paths.filter((x) => x !== p))}
              >
                {t('toolbox.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {pick !== null && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void pick('files').then((picked) =>
              setPaths([...paths, ...picked.filter((p) => !paths.includes(p))]),
            )
          }
        >
          {t('toolbox.pickFiles')}
        </Button>
      )}
      <PreviewFlow
        tools={tools}
        onDone={onDone}
        request={paths.length === 0 ? null : { tool: 'shredder', paths }}
      />
    </div>
  );
}

export function RenameTool({
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
  const [options, setOptions] = useState<RenameOptions>({
    pattern: '{name}',
    find: '',
    replace: '',
    start: 1,
    digits: 2,
    case: 'keep',
    extensions: [],
  });
  const [extensions, setExtensions] = useState('');
  const set = (change: Partial<RenameOptions>) => setOptions({ ...options, ...change });
  return (
    <div className="space-y-4">
      <FolderPicker value={folder} onChange={setFolder} defaults={defaults} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t('toolbox.renamePattern')}
          value={options.pattern}
          onChange={(pattern) => set({ pattern })}
        />
        <TextField
          label={t('toolbox.ruleExtensions')}
          value={extensions}
          onChange={setExtensions}
        />
        <TextField
          label={t('toolbox.renameFind')}
          value={options.find}
          onChange={(find) => set({ find })}
        />
        <TextField
          label={t('toolbox.renameReplace')}
          value={options.replace}
          onChange={(replace) => set({ replace })}
        />
        <NumberField
          label={t('toolbox.renameStart')}
          value={options.start}
          min={0}
          onChange={(start) => set({ start })}
        />
        <NumberField
          label={t('toolbox.renameDigits')}
          value={options.digits}
          min={1}
          onChange={(digits) => set({ digits: Math.min(8, digits) })}
        />
      </div>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="mb-1 text-text-muted">{t('toolbox.renameCase')}</legend>
        {(['keep', 'lower', 'upper'] as const).map((c) => (
          <label key={c} className="flex items-center gap-2">
            <input
              type="radio"
              name="rename-case"
              className="accent-accent"
              checked={options.case === c}
              onChange={() => set({ case: c })}
            />
            {t(`toolbox.case.${c}` satisfies TextKey)}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-text-subtle">{t('toolbox.renameHelp')}</p>
      <PreviewFlow
        tools={tools}
        onDone={onDone}
        request={
          folder === null
            ? null
            : {
                tool: 'rename',
                folder,
                options: {
                  ...options,
                  extensions: extensions
                    .split(/[\s,;]+/)
                    .map((x) => x.trim())
                    .filter((x) => x !== ''),
                },
              }
        }
      />
    </div>
  );
}

export function TweaksTool({
  tools,
  group,
  onDone,
}: {
  readonly tools: ToolsApi;
  readonly group: 'explorer' | 'privacy';
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const [states, setStates] = useState<readonly TweakState[] | null>(null);
  const [version, setVersion] = useState(0);
  const [wanted, setWanted] = useState<ReadonlyMap<string, boolean>>(new Map());

  useEffect(() => {
    let active = true;
    void tools.tweaks().then((s) => {
      if (active) {
        setStates(s.filter((x) => x.group === group));
        setWanted(new Map());
      }
    });
    return () => {
      active = false;
    };
  }, [tools, group, version]);

  if (states === null) {
    return <p className="text-sm text-text-muted">{t('toolbox.loading')}</p>;
  }
  const changes = states
    .filter((s) => wanted.has(s.id) && wanted.get(s.id) !== s.on)
    .map((s) => ({ id: s.id, on: wanted.get(s.id) ?? s.on }));
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border" data-testid={`tweaks-${group}`}>
        {states.map((s) => (
          <li key={s.id} className="py-2">
            <Toggle
              size="sm"
              label={t(`toolbox.tweak.${s.id}` satisfies TextKey)}
              checked={wanted.get(s.id) ?? s.on}
              onCheckedChange={(on) => setWanted(new Map(wanted).set(s.id, on))}
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-subtle">{t('toolbox.tweaksHint')}</p>
      <PreviewFlow
        tools={tools}
        onDone={() => {
          setVersion((v) => v + 1);
          onDone();
        }}
        request={changes.length === 0 ? null : { tool: 'tweaks', changes }}
      />
    </div>
  );
}

export function HostsTool({ tools }: { readonly tools: ToolsApi }) {
  const { t } = useT();
  const [report, setReport] = useState<HostsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    tools.hosts().then(
      (r) => {
        if (active) {
          setReport(r);
        }
      },
      (e: unknown) => {
        if (active) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [tools]);

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-danger">
        <SafeText value={error} />
      </p>
    );
  }
  if (report === null) {
    return <p className="text-sm text-text-muted">{t('toolbox.loading')}</p>;
  }
  const suspicious = report.entries.filter((e) => e.kind === 'suspicious').length;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-text-muted">
        <SafeText value={report.path} />
      </p>
      <p className={suspicious > 0 ? 'font-medium text-warn' : 'text-success'} role="status">
        {suspicious > 0
          ? t('toolbox.hostsSuspicious', { count: String(suspicious) })
          : t('toolbox.hostsClean')}
      </p>
      {report.entries.length === 0 ? (
        <p className="text-text-subtle">{t('toolbox.hostsEmpty')}</p>
      ) : (
        <ul className="max-h-96 space-y-1 overflow-auto" data-testid="hosts-list">
          {report.entries.slice(0, 500).map((e) => (
            <li key={`${e.line}-${e.host}`} className="flex flex-wrap gap-x-3">
              <span className="w-12 text-text-subtle tabular-nums">{e.line}</span>
              <span className="min-w-32 font-mono">
                <SafeText value={e.address} />
              </span>
              <span className="font-mono">
                <SafeText value={e.host} />
              </span>
              <span className={e.kind === 'suspicious' ? 'text-warn' : 'text-text-subtle'}>
                {t(`toolbox.hostsKind.${e.kind}` satisfies TextKey)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-text-subtle">{t('toolbox.hostsHint')}</p>
    </div>
  );
}

function duration(seconds: number, t: ReturnType<typeof useT>['t']): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return t('toolbox.uptimeValue', { days: String(days), hours: String(hours) });
}

export function SystemTool({ tools }: { readonly tools: ToolsApi }) {
  const { t, locale } = useT();
  const [report, setReport] = useState<SystemReport | null>(null);

  useEffect(() => {
    let active = true;
    void tools.system().then((r) => {
      if (active) {
        setReport(r);
      }
    });
    return () => {
      active = false;
    };
  }, [tools]);

  if (report === null) {
    return <p className="text-sm text-text-muted">{t('toolbox.loading')}</p>;
  }
  const { info } = report;
  const rows: readonly [TextKey, string][] = [
    ['toolbox.sysOs', [info.os, info.version, info.build].filter((x) => x !== '').join(' · ')],
    ['toolbox.sysComputer', info.computer],
    ['toolbox.sysCpu', info.cores > 0 ? `${info.cpu} (${info.cores})` : info.cpu],
    [
      'toolbox.sysMemory',
      info.memory === null
        ? '–'
        : t('toolbox.memoryValue', {
            free: formatBytes(info.memory[1], locale),
            total: formatBytes(info.memory[0], locale),
          }),
    ],
    ['toolbox.sysUptime', duration(info.uptime, t)],
  ];
  return (
    <div className="space-y-4 text-sm" data-testid="system-report">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="text-text-muted">{t(label)}</dt>
            <dd className="text-right">
              <SafeText value={value === '' ? '–' : value} />
            </dd>
          </div>
        ))}
      </dl>
      <ul className="space-y-1">
        {info.drives.map((d) => (
          <li key={d.root}>
            <SafeText value={d.root} />{' '}
            {t('toolbox.spaceDisk', {
              free: formatBytes(d.free, locale),
              total: formatBytes(d.total, locale),
            })}
          </li>
        ))}
      </ul>
      {report.findings.length === 0 ? (
        <p className="font-medium text-success" role="status">
          {t('toolbox.healthOk')}
        </p>
      ) : (
        <ul className="space-y-1" role="status">
          {report.findings.map((f) => (
            <li key={f} className="text-warn">
              {t(`toolbox.health.${f}` satisfies TextKey)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const links: readonly (readonly [TextKey, TextKey, RouteId])[] = [
  ['toolbox.link.updates', 'toolbox.link.updatesHint', 'hardening'],
  ['toolbox.link.drivers', 'toolbox.link.driversHint', 'hardening'],
  ['toolbox.link.monitor', 'toolbox.link.monitorHint', 'network'],
  ['toolbox.link.focus', 'toolbox.link.focusHint', 'realtime'],
  ['toolbox.link.restore', 'toolbox.link.restoreHint', 'hardening'],
];

/** Werkzeuge, die AEGIS schon an anderer Stelle hat (13, 14, 17, 20, 21). */
export function LinksTool() {
  const { t } = useT();
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {links.map(([title, hint, route]) => (
        <li key={title} className="rounded-xl border border-border p-4">
          <a
            href={hashFor(route)}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            {t(title)}
          </a>
          <p className="mt-1 text-sm text-text-muted">{t(hint)}</p>
        </li>
      ))}
    </ul>
  );
}
