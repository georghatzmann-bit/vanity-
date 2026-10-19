/**
 * Passwort-Tresor (P9): anlegen, entsperren, Einträge (Ordner, Schlagwörter, Favoriten,
 * Suche), Generator, Stärke, Wiederverwendung und Leck-Check (k-Anonymität). Passwörter kommen
 * nur auf Klick in die Oberfläche; Kopieren leert die Zwischenablage nach 30 s.
 */
import { Button, Panel, SafeText, SegmentedControl } from '@aegis/ui';
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { TextKey } from '../i18n/translator.ts';
import { pwnedCount } from '../platform/leak.ts';
import { usePlatform } from '../platform/PlatformContext.tsx';
import {
  vaultErrorCode,
  type StrengthLevel,
  type VaultApi,
  type VaultEntryInput,
  type VaultEntrySummary,
  type VaultList,
  type VaultStatus,
} from '../platform/vault.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';

const inputClass =
  'mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-subtle';

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete = 'off',
  multiline = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'password';
  readonly autoComplete?: string;
  readonly multiline?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm text-text-muted">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className={`${inputClass} min-h-20`}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          type={type}
          className={inputClass}
          value={value}
          autoComplete={autoComplete}
          spellCheck={false}
          maxLength={1024}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function errorText(t: ReturnType<typeof useT>['t'], error: unknown, retryIn = 0): string {
  const code = vaultErrorCode(error);
  if (code === 'wrong_password') {
    return t('pwvault.wrongPassword');
  }
  if (code === 'wait') {
    return t('pwvault.wait', { seconds: String(Math.max(retryIn, 1)) });
  }
  if (code === 'windows_only') {
    return t('pwvault.copyWindowsOnly');
  }
  return typeof error === 'string' ? error : String(error);
}

function Setup({ vault, onDone }: { readonly vault: VaultApi; readonly onDone: () => void }) {
  const { t } = useT();
  const [master, setMaster] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if ([...master].length < 12) {
      setError(t('pwvault.tooShort'));
      return;
    }
    if (master !== repeat) {
      setError(t('pwvault.mismatch'));
      return;
    }
    setBusy(true);
    vault.setup(master).then(
      () => {
        setMaster('');
        setRepeat('');
        onDone();
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorText(t, err));
      },
    );
  };
  return (
    <Panel title={t('pwvault.setupTitle')} description={t('pwvault.setupIntro')}>
      <form onSubmit={submit} className="max-w-sm space-y-3" data-testid="vault-setup">
        <Field
          label={t('pwvault.master')}
          type="password"
          value={master}
          onChange={setMaster}
          autoComplete="new-password"
        />
        <Field
          label={t('pwvault.masterRepeat')}
          type="password"
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
        />
        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          {t('pwvault.create')}
        </Button>
      </form>
    </Panel>
  );
}

function Unlock({
  vault,
  status,
  onDone,
}: {
  readonly vault: VaultApi;
  readonly status: VaultStatus;
  readonly onDone: () => void;
}) {
  const { t } = useT();
  const [master, setMaster] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const value = master;
    setMaster('');
    vault.unlock(value).then(
      () => {
        setBusy(false);
        onDone();
      },
      (err: unknown) => {
        setBusy(false);
        void vault.status().then(
          (s) => setError(errorText(t, err, s.retryIn)),
          () => setError(errorText(t, err)),
        );
      },
    );
  };
  return (
    <Panel title={t('pwvault.unlockTitle')}>
      <form onSubmit={submit} className="max-w-sm space-y-3" data-testid="vault-unlock">
        <Field
          label={t('pwvault.master')}
          type="password"
          value={master}
          onChange={setMaster}
          autoComplete="current-password"
        />
        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {status.retryIn > 0 && error === null && (
          <p className="text-sm text-warn">
            {t('pwvault.wait', { seconds: String(status.retryIn) })}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          {t('pwvault.unlock')}
        </Button>
      </form>
    </Panel>
  );
}

const emptyInput: VaultEntryInput = {
  title: '',
  username: '',
  password: '',
  urls: [],
  notes: '',
  folder: '',
  tags: [],
  favorite: false,
};

function Editor({
  vault,
  entry,
  onClose,
}: {
  readonly vault: VaultApi;
  readonly entry: VaultEntrySummary | null;
  readonly onClose: (changed: boolean) => void;
}) {
  const { t } = useT();
  const [form, setForm] = useState<VaultEntryInput>(
    entry === null
      ? emptyInput
      : {
          ...emptyInput,
          title: entry.title,
          username: entry.username,
          urls: entry.urls,
          folder: entry.folder,
          tags: entry.tags,
          favorite: entry.favorite,
        },
  );
  const [loaded, setLoaded] = useState(entry === null);
  const [strength, setStrength] = useState<StrengthLevel | null>(null);
  const [length, setLength] = useState(20);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (entry === null) {
      return undefined;
    }
    let active = true;
    vault.reveal(entry.id).then(
      (secret) => {
        if (active) {
          setForm((f) => ({ ...f, password: secret.password, notes: secret.notes }));
          setLoaded(true);
        }
      },
      (err: unknown) => {
        if (active) {
          setError(errorText(t, err));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [entry, vault, t]);

  useEffect(() => {
    let active = true;
    vault.strength(form.password).then(
      (s) => {
        if (active) {
          setStrength(form.password === '' ? null : s.level);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [form.password, vault]);

  const set = <K extends keyof VaultEntryInput>(key: K, value: VaultEntryInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    vault.save(entry?.id ?? null, form).then(
      () => onClose(true),
      (err: unknown) => setError(errorText(t, err)),
    );
  };

  return (
    <Panel title={entry === null ? t('pwvault.editorNew') : t('pwvault.editorEdit')}>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" data-testid="vault-editor">
        <Field label={t('pwvault.title')} value={form.title} onChange={(v) => set('title', v)} />
        <Field
          label={t('pwvault.username')}
          value={form.username}
          onChange={(v) => set('username', v)}
          autoComplete="username"
        />
        <div className="sm:col-span-2">
          <Field
            label={t('pwvault.password')}
            type="password"
            value={loaded ? form.password : ''}
            onChange={(v) => set('password', v)}
            autoComplete="new-password"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2 text-text-muted">
              {t('pwvault.length')}
              <input
                type="number"
                min={8}
                max={128}
                value={length}
                onChange={(e) => setLength(Number(e.target.value))}
                className="w-20 rounded-lg border border-border bg-surface-2 px-2 py-1 text-text"
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                void vault
                  .generate({
                    length: Math.min(128, Math.max(8, length)),
                    lower: true,
                    upper: true,
                    digits: true,
                    symbols: true,
                    avoidAmbiguous: true,
                  })
                  .then((p) => set('password', p))
              }
            >
              {t('pwvault.generate')}
            </Button>
            {strength !== null && (
              <span
                data-testid="vault-strength"
                className={
                  strength === 'very_weak' || strength === 'weak'
                    ? 'text-danger'
                    : strength === 'fair'
                      ? 'text-warn'
                      : 'text-success'
                }
              >
                {t('pwvault.strengthLabel', {
                  level: t(`pwvault.strength.${strength}` satisfies TextKey),
                })}
              </span>
            )}
          </div>
        </div>
        <div className="sm:col-span-2">
          <Field
            label={t('pwvault.urls')}
            value={form.urls.join('\n')}
            onChange={(v) => set('urls', v.split('\n'))}
            multiline
          />
        </div>
        <Field label={t('pwvault.folder')} value={form.folder} onChange={(v) => set('folder', v)} />
        <Field
          label={t('pwvault.tags')}
          value={form.tags.join(', ')}
          onChange={(v) => set('tags', v.split(','))}
        />
        <div className="sm:col-span-2">
          <Field
            label={t('pwvault.notes')}
            value={loaded ? form.notes : ''}
            onChange={(v) => set('notes', v)}
            multiline
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={form.favorite}
            onChange={(e) => set('favorite', e.target.checked)}
          />
          {t('pwvault.favorite')}
        </label>
        {error !== null && (
          <p role="alert" className="text-sm text-danger sm:col-span-2">
            {error}
          </p>
        )}
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" disabled={!loaded}>
            {t('pwvault.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose(false)}>
            {t('pwvault.cancel')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

type Filter = 'all' | 'favorites' | 'weak' | 'reused' | 'leaked';

function EntryRow({
  entry,
  vault,
  flags,
  onEdit,
  onDeleted,
  onNotice,
}: {
  readonly entry: VaultEntrySummary;
  readonly vault: VaultApi;
  readonly flags: { readonly weak: boolean; readonly reused: boolean; readonly leaked: boolean };
  readonly onEdit: () => void;
  readonly onDeleted: () => void;
  readonly onNotice: (text: string) => void;
}) {
  const { t } = useT();
  const [shown, setShown] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const copy = (field: 'password' | 'username') =>
    vault.copy(entry.id, field).then(
      (seconds) => onNotice(t('pwvault.copied', { seconds: String(seconds) })),
      (err: unknown) => onNotice(errorText(t, err)),
    );
  return (
    <li className="rounded-lg border border-border bg-surface-1 p-3" data-testid="vault-entry">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-text">
          {entry.favorite && <span aria-label={t('pwvault.favorite')}>★ </span>}
          <SafeText value={entry.title} />
        </span>
        <span className="text-sm text-text-muted">
          <SafeText value={entry.username} />
        </span>
        {entry.folder !== '' && (
          <span className="text-xs text-text-subtle">
            <SafeText value={entry.folder} />
          </span>
        )}
        {entry.tags.map((tag) => (
          <span key={tag} className="text-xs text-text-subtle">
            #<SafeText value={tag} />
          </span>
        ))}
        {flags.weak && <span className="text-xs font-medium text-warn">{t('pwvault.weak')}</span>}
        {flags.reused && (
          <span className="text-xs font-medium text-warn">{t('pwvault.reused')}</span>
        )}
        {flags.leaked && (
          <span className="text-xs font-medium text-danger">{t('pwvault.leaked')}</span>
        )}
      </div>
      {shown !== null && (
        <p className="mt-1 font-mono text-sm text-text" data-testid="vault-shown">
          <SafeText value={shown} mono />
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => void copy('username')}>
          {t('pwvault.copyUser')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!entry.hasPassword}
          onClick={() => void copy('password')}
        >
          {t('pwvault.copyPassword')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!entry.hasPassword}
          onClick={() =>
            shown !== null
              ? setShown(null)
              : void vault.reveal(entry.id).then(
                  (s) => setShown(s.password),
                  (err: unknown) => onNotice(errorText(t, err)),
                )
          }
        >
          {shown !== null ? t('pwvault.hide') : t('pwvault.show')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          {t('pwvault.edit')}
        </Button>
        {confirm ? (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-text">{t('pwvault.deleteConfirm', { title: entry.title })}</span>
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                void vault
                  .remove(entry.id)
                  .then(onDeleted, (err: unknown) => onNotice(errorText(t, err)))
              }
            >
              {t('pwvault.deleteYes')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              {t('pwvault.cancel')}
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            {t('pwvault.delete')}
          </Button>
        )}
      </div>
    </li>
  );
}

function Unlocked({
  vault,
  status,
  onLocked,
}: {
  readonly vault: VaultApi;
  readonly status: VaultStatus;
  readonly onLocked: () => void;
}) {
  const { t } = useT();
  const platform = usePlatform();
  const [list, setList] = useState<VaultList | null>(null);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [folder, setFolder] = useState('');
  const [editing, setEditing] = useState<VaultEntrySummary | null | 'new'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaked, setLeaked] = useState<ReadonlySet<string>>(new Set());
  const [leakProgress, setLeakProgress] = useState<{ done: number; total: number } | null>(null);
  const [oldMaster, setOldMaster] = useState('');
  const [newMaster, setNewMaster] = useState('');

  const fail = useCallback(
    (err: unknown) => {
      if (vaultErrorCode(err) === 'locked') {
        onLocked();
      } else {
        setNotice(errorText(t, err));
      }
    },
    [onLocked, t],
  );

  useEffect(() => {
    let active = true;
    vault.list().then((l) => {
      if (active) {
        setList(l);
      }
    }, fail);
    return () => {
      active = false;
    };
  }, [vault, version, fail]);

  const sets = useMemo(
    () => ({ weak: new Set(list?.weak ?? []), reused: new Set(list?.reused ?? []) }),
    [list],
  );

  if (list === null) {
    return <p className="text-sm text-text-muted">{t('pwvault.loading')}</p>;
  }

  const q = query.trim().toLowerCase();
  const visible = list.entries.filter((e) => {
    if (folder !== '' && e.folder !== folder) {
      return false;
    }
    if (filter === 'favorites' && !e.favorite) {
      return false;
    }
    if (filter === 'weak' && !sets.weak.has(e.id)) {
      return false;
    }
    if (filter === 'reused' && !sets.reused.has(e.id)) {
      return false;
    }
    if (filter === 'leaked' && !leaked.has(e.id)) {
      return false;
    }
    return (
      q === '' ||
      [e.title, e.username, e.folder, ...e.urls, ...e.tags].some((f) => f.toLowerCase().includes(q))
    );
  });

  const checkLeaks = async () => {
    const range = platform.leakPasswordRange;
    if (range === null) {
      return;
    }
    const targets = list.entries.filter((e) => e.hasPassword);
    const found = new Set<string>();
    setLeakProgress({ done: 0, total: targets.length });
    for (const [i, e] of targets.entries()) {
      try {
        const secret = await vault.reveal(e.id);
        if ((await pwnedCount(secret.password, range)) > 0) {
          found.add(e.id);
        }
      } catch (err) {
        fail(err);
        break;
      }
      setLeakProgress({ done: i + 1, total: targets.length });
    }
    setLeaked(found);
    setLeakProgress(null);
  };

  const importCsv = async () => {
    const picked = await platform.pickPaths?.('files');
    const path = picked?.[0];
    if (path === undefined) {
      return;
    }
    vault.importCsv(path).then((r) => {
      setNotice(
        t('pwvault.imported', { imported: String(r.imported), skipped: String(r.skipped) }),
      );
      setVersion((v) => v + 1);
    }, fail);
  };

  return (
    <>
      <Panel
        title={t('pages.vault.title')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-text-muted">
              {t('pwvault.autoLock')}
              <select
                className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-text"
                value={status.lockMinutes}
                onChange={(e) => void vault.setLockMinutes(Number(e.target.value)).catch(fail)}
              >
                {[1, 5, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    {t('pwvault.minutes', { count: String(m) })}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="secondary" onClick={() => void vault.lock().then(onLocked)}>
              {t('pwvault.lock')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm" data-testid="vault-main">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <Field label={t('pwvault.search')} value={query} onChange={setQuery} />
            </div>
            {list.folders.length > 0 && (
              <label className="text-sm text-text-muted">
                {t('pwvault.folder')}
                <select
                  className={`${inputClass} w-auto`}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                >
                  <option value="">{t('pwvault.allFolders')}</option>
                  {list.folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button variant="primary" onClick={() => setEditing('new')}>
              {t('pwvault.add')}
            </Button>
            {platform.pickPaths !== null && (
              <Button variant="secondary" onClick={() => void importCsv()}>
                {t('pwvault.importCsv')}
              </Button>
            )}
          </div>
          <SegmentedControl
            label={t('pwvault.filter')}
            value={filter}
            onValueChange={setFilter}
            options={[
              {
                value: 'all',
                label: t('pwvault.filterAll', { count: String(list.entries.length) }),
              },
              { value: 'favorites', label: t('pwvault.filterFavorites') },
              { value: 'weak', label: t('pwvault.filterWeak', { count: String(sets.weak.size) }) },
              {
                value: 'reused',
                label: t('pwvault.filterReused', { count: String(sets.reused.size) }),
              },
              { value: 'leaked', label: t('pwvault.filterLeaked', { count: String(leaked.size) }) },
            ]}
          />
          {notice !== null && (
            <p role="status" className="text-text-muted" data-testid="vault-notice">
              {notice}
            </p>
          )}
          {list.entries.length === 0 ? (
            <p className="text-text-muted">{t('pwvault.empty')}</p>
          ) : visible.length === 0 ? (
            <p className="text-text-muted">{t('pwvault.noMatch')}</p>
          ) : (
            <ul className="space-y-2">
              {visible.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  vault={vault}
                  flags={{
                    weak: sets.weak.has(e.id),
                    reused: sets.reused.has(e.id),
                    leaked: leaked.has(e.id),
                  }}
                  onEdit={() => setEditing(e)}
                  onDeleted={() => setVersion((v) => v + 1)}
                  onNotice={setNotice}
                />
              ))}
            </ul>
          )}
          <p className="text-xs text-text-subtle">{t('pwvault.importHint')}</p>
        </div>
      </Panel>

      {editing !== null && (
        <Editor
          key={editing === 'new' ? 'new' : editing.id}
          vault={vault}
          entry={editing === 'new' ? null : editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) {
              setVersion((v) => v + 1);
            }
          }}
        />
      )}

      <Panel title={t('pwvault.healthTitle')}>
        <div className="space-y-2 text-sm" data-testid="vault-health">
          <p className="text-text">
            {t('pwvault.healthSummary', {
              weak: String(sets.weak.size),
              reused: String(sets.reused.size),
              leaked: String(leaked.size),
            })}
          </p>
          {platform.leakPasswordRange !== null && (
            <>
              <Button
                variant="secondary"
                loading={leakProgress !== null}
                onClick={() => void checkLeaks()}
              >
                {t('pwvault.leakAll')}
              </Button>
              {leakProgress !== null && (
                <p role="status" className="text-text-muted">
                  {t('pwvault.leakRunning', {
                    done: String(leakProgress.done),
                    total: String(leakProgress.total),
                  })}
                </p>
              )}
              <p className="text-xs text-text-subtle">{t('pwvault.leakAllHint')}</p>
            </>
          )}
        </div>
      </Panel>

      <Panel title={t('pwvault.changeTitle')}>
        <form
          className="max-w-sm space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const [o, n] = [oldMaster, newMaster];
            setOldMaster('');
            setNewMaster('');
            vault.changeMaster(o, n).then(() => setNotice(t('pwvault.changed')), fail);
          }}
        >
          <Field
            label={t('pwvault.oldMaster')}
            type="password"
            value={oldMaster}
            onChange={setOldMaster}
            autoComplete="current-password"
          />
          <Field
            label={t('pwvault.newMaster')}
            type="password"
            value={newMaster}
            onChange={setNewMaster}
            autoComplete="new-password"
          />
          <Button type="submit" variant="secondary">
            {t('pwvault.change')}
          </Button>
        </form>
        <p className="mt-3 text-xs text-text-subtle">{t('pwvault.extension')}</p>
      </Panel>
    </>
  );
}

export function VaultPage() {
  const { t } = useT();
  const vault = usePlatform().vault;
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (vault === null) {
      return undefined;
    }
    let active = true;
    const load = () =>
      vault.status().then(
        (s) => {
          if (active) {
            setStatus(s);
          }
        },
        () => undefined,
      );
    void load();
    // Auto-Sperre sichtbar machen.
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [vault, version]);

  const reload = () => setVersion((v) => v + 1);

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.vault.eyebrow')}
        title={t('pages.vault.title')}
        description={t('pwvault.intro')}
      />
      {vault === null ? (
        <p className="text-sm text-text-muted" data-testid="vault-preview">
          {t('pwvault.preview')}
        </p>
      ) : status === null ? (
        <p className="text-sm text-text-muted">{t('pwvault.loading')}</p>
      ) : !status.exists ? (
        <Setup vault={vault} onDone={reload} />
      ) : !status.unlocked ? (
        <Unlock vault={vault} status={status} onDone={reload} />
      ) : (
        <Unlocked vault={vault} status={status} onLocked={reload} />
      )}
    </PageBody>
  );
}
