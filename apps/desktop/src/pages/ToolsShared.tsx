/**
 * Gemeinsame Bausteine der Werkzeug-Seiten: Eingabefelder, Ordnerwahl und der Ablauf
 * Vorschau → Auswahl → Ausführen (bei endgültigem Löschen mit zweitem Dialog) → Ergebnis →
 * Rückgängig.
 */
import { Button, CountUp, Dialog, SafeText } from '@aegis/ui';
import { useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import {
  finalChallenge,
  formatBytes,
  type Preview,
  type PreviewRequest,
  type ToolDefaults,
  type ToolRun,
  type ToolsApi,
} from '../platform/tools.ts';

export const inputClass =
  'mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-subtle';

/** Fehlertext aus einer abgelehnten Anfrage. */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NumberField({
  label,
  value,
  onChange,
  min,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min: number;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        className={inputClass}
        value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
      />
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm text-text-muted">
        {label}
      </label>
      <input
        id={id}
        className={inputClass}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Ordnerwahl über den Dialog der App (Pfad nur anzeigen, nie tippen lassen). */
export function FolderPicker({
  value,
  onChange,
  defaults,
  label,
}: {
  readonly value: string | null;
  readonly onChange: (path: string) => void;
  readonly defaults: ToolDefaults | null;
  readonly label?: string;
}) {
  const { t } = useT();
  const platform = usePlatform();
  const pick = platform.pickPaths;
  return (
    <div className="space-y-2">
      <p className="text-sm text-text-muted">{label ?? t('toolbox.folder')}</p>
      <p className="text-sm text-text" data-testid="tool-folder">
        {value === null ? (
          <span className="text-text-subtle">{t('toolbox.noFolder')}</span>
        ) : (
          <SafeText value={value} />
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {pick !== null && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void pick('folder').then((paths) => {
                const first = paths[0];
                if (first !== undefined) {
                  onChange(first);
                }
              })
            }
          >
            {t('toolbox.pickFolder')}
          </Button>
        )}
        {defaults?.downloads != null && value !== defaults.downloads && (
          <Button size="sm" variant="ghost" onClick={() => onChange(defaults.downloads ?? '')}>
            {t('toolbox.useDownloads')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Vorschau → Auswahl → Ausführen → Ergebnis → Rückgängig. */
/** Schritte je Seite der Vorschau. */
const PAGE = 300;

export function PreviewFlow({
  tools,
  request,
  onDone,
  extra,
}: {
  readonly tools: ToolsApi;
  readonly request: PreviewRequest | null;
  readonly onDone: () => void;
  readonly extra?: ReactNode;
}) {
  const { t, locale } = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [skip, setSkip] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<ToolRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoText, setUndoText] = useState<string | null>(null);
  // Nur angezeigte Schritte laufen: Was (noch) nicht zu sehen ist, wird nie ausgeführt.
  const [limit, setLimit] = useState(PAGE);
  const shown = preview?.items.slice(0, limit) ?? [];
  const hidden = (preview?.items.length ?? 0) - shown.length;
  const selected = shown.length - [...skip].filter((i) => i < shown.length).length;

  const make = () => {
    if (request === null) {
      return;
    }
    setBusy(true);
    setError(null);
    setRun(null);
    setUndoText(null);
    tools.preview(request).then(
      (p) => {
        setPreview(p);
        setSkip(new Set());
        setLimit(PAGE);
        setBusy(false);
      },
      (e: unknown) => {
        setError(message(e));
        setBusy(false);
      },
    );
  };

  const [challenge, setChallenge] = useState<string | null>(null);

  const execute = (confirm?: string) => {
    if (preview === null) {
      return;
    }
    setBusy(true);
    const notShown = preview.items.map((_, i) => i).filter((i) => i >= shown.length);
    tools.execute(preview.id, preview.digest, [...skip, ...notShown], confirm).then(
      (r) => {
        setRun(r);
        setPreview(null);
        setChallenge(null);
        setBusy(false);
        onDone();
      },
      (e: unknown) => {
        const next = confirm === undefined ? finalChallenge(e) : null;
        setBusy(false);
        if (next !== null) {
          // Endgültiges Löschen: zweite, getrennte Bestätigung im eigenen Dialog.
          setChallenge(next);
          return;
        }
        setError(message(e));
        setPreview(null);
        setChallenge(null);
      },
    );
  };

  const undo = () => {
    if (run === null) {
      return;
    }
    setBusy(true);
    tools.undo(run.id).then(
      (errors) => {
        setUndoText(
          errors.length === 0
            ? t('toolbox.undone')
            : `${t('toolbox.undoPartial')} ${errors.join(' · ')}`,
        );
        setRun({ ...run, undone: 1 });
        setBusy(false);
        onDone();
      },
      (e: unknown) => {
        setError(message(e));
        setBusy(false);
      },
    );
  };

  return (
    <div className="space-y-4" data-testid="preview-flow">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={request === null || busy} onClick={make}>
          {t('toolbox.makePreview')}
        </Button>
        {extra}
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          <SafeText value={error} />
        </p>
      )}
      {preview !== null && (
        <section
          aria-label={t('toolbox.previewTitle')}
          className="space-y-3 rounded-xl border border-border bg-surface-2 p-4"
          data-testid="tool-preview"
        >
          {preview.items.length === 0 ? (
            <p className="text-sm text-text-muted">{t('toolbox.previewEmpty')}</p>
          ) : (
            <>
              <p className="text-sm font-medium text-text">
                {t('toolbox.previewSummary', {
                  count: String(selected),
                  size: formatBytes(preview.totalSize, locale),
                })}
              </p>
              {preview.groups.length > 0 && (
                <ul className="space-y-2 text-sm">
                  {preview.groups.slice(0, Math.ceil(limit / 6)).map((g) => (
                    <li key={g.hash} className="rounded-lg border border-border p-2">
                      {g.files.map((f, i) => (
                        <div key={f.path} className="flex flex-wrap gap-x-2">
                          <SafeText value={f.path} />
                          {i === 0 && <span className="text-success">({t('toolbox.keep')})</span>}
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
              <ul className="max-h-80 space-y-1 overflow-auto text-sm">
                {shown.map((item, index) => (
                  <li key={`${index}-${item.label}`}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1 accent-accent"
                        checked={!skip.has(index)}
                        onChange={(e) => {
                          const nextSkip = new Set(skip);
                          if (e.target.checked) {
                            nextSkip.delete(index);
                          } else {
                            nextSkip.add(index);
                          }
                          setSkip(nextSkip);
                        }}
                      />
                      <span className="min-w-0 break-all">
                        <SafeText value={item.label} />
                        {item.size > 0 && (
                          <span className="ml-2 text-text-subtle">
                            {formatBytes(item.size, locale)}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {hidden > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs text-text-muted">
                    {t('toolbox.previewMore', { count: String(hidden) })}
                  </p>
                  <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE)}>
                    {t('toolbox.previewShowMore')}
                  </Button>
                </div>
              )}
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={busy}
              disabled={selected === 0}
              onClick={() => execute()}
            >
              {t('toolbox.execute')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
              {t('toolbox.discard')}
            </Button>
          </div>
        </section>
      )}
      {run !== null && (
        <section
          aria-label={t('toolbox.resultTitle')}
          className="space-y-2 rounded-xl border border-border bg-surface-2 p-4 text-sm"
          data-testid="tool-result"
          role="status"
        >
          <p className="text-2xl font-semibold text-text tabular-nums" aria-hidden="true">
            <CountUp value={run.done} duration={600} locale={locale} />
          </p>
          <p className="font-medium text-text">
            {t('toolbox.result', {
              done: String(run.done),
              skipped: String(run.skipped),
              failed: String(run.failed),
            })}
          </p>
          {undoText === null ? (
            run.done > 0 && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={undo}>
                {t('toolbox.undo')}
              </Button>
            )
          ) : (
            <p className="text-text-muted">
              <SafeText value={undoText} />
            </p>
          )}
        </section>
      )}
      <Dialog
        open={challenge !== null}
        role="alertdialog"
        tone="danger"
        title={t('toolbox.finalTitle')}
        description={t('toolbox.finalText', {
          count: String(selected),
        })}
        onClose={() => setChallenge(null)}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setChallenge(null)}>
              {t('toolbox.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                if (challenge !== null) {
                  execute(challenge);
                }
              }}
            >
              {t('toolbox.finalConfirm')}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-warn">{t('toolbox.ssdHint')}</p>
      </Dialog>
    </div>
  );
}
