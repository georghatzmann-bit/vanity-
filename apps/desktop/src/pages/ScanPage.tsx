/**
 * Scan: Dateien/Ordner vom Dienst prüfen lassen und Funde erklären. Isolieren wird nur
 * vorgeschlagen – ausgeführt wird erst nach „Ja, ausführen“ im Freigabe-Dialog.
 */
import { Button, IconFile, IconTree, Panel, RiskBadge, SafeText, useToast } from '@aegis/ui';
import { useCallback, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import { ServiceError, type ScanFinding, type ScanResult } from '../platform/service.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

function FindingRow({
  finding,
  onIsolate,
}: {
  readonly finding: ScanFinding;
  readonly onIsolate: () => void;
}) {
  const { t, language } = useT();
  const [open, setOpen] = useState(false);
  const summary = language === 'en' ? finding.summaryEn : finding.summaryDe;
  return (
    <li className="rounded-xl border border-border bg-surface-2 p-4" data-testid="finding">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <RiskBadge level={finding.risk} />
            <span className="text-xs text-text-subtle tabular-nums">
              {t('scanner.confidence', { value: String(finding.confidence) })}
            </span>
            {finding.trusted !== null && (
              <span
                className="rounded-full border border-border px-2 py-0.5 text-xs text-text-muted"
                data-testid="trusted"
              >
                {t('scanner.trusted', { date: finding.trusted.since.slice(0, 10) })}
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-text">
            <SafeText value={finding.path} mono breakAll />
          </p>
          <p className="mt-1 text-sm text-text-muted">{summary}</p>
          {finding.notScannable !== null && (
            <p className="mt-1 text-xs text-warn">
              {t('scanner.partial')}: <SafeText value={finding.notScannable} />
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {(finding.reasons.length > 0 || finding.contained.length > 0) && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {t('scanner.why')}
            </Button>
          )}
          {finding.recommendation !== 'none' && (
            <Button
              size="sm"
              variant={finding.risk === 'dangerous' ? 'danger' : 'secondary'}
              onClick={onIsolate}
            >
              {t('scanner.isolate')}
            </Button>
          )}
        </div>
      </div>
      {open && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-text-muted">
          {finding.reasons.map((r, i) => (
            <li key={`${r.code}-${String(i)}`}>
              <SafeText value={language === 'en' ? r.en : r.de} />
            </li>
          ))}
        </ul>
      )}
      {open && finding.contained.length > 0 && (
        <div className="mt-3" data-testid="contained">
          <p className="text-xs font-medium text-text-subtle">{t('scanner.contained')}</p>
          <ul className="mt-1 space-y-2">
            {finding.contained.map((c, i) => (
              <li
                key={`${c.name}-${String(i)}`}
                className="flex flex-wrap items-start gap-2 text-sm"
              >
                <RiskBadge level={c.risk} />
                <span className="min-w-0 flex-1">
                  <SafeText value={c.name} mono breakAll />
                  <span className="block text-text-muted">
                    {language === 'en' ? c.summaryEn : c.summaryDe}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function ScanPage() {
  const { t } = useT();
  const platform = usePlatform();
  const toast = useToast();
  const service = platform.service;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [lastPaths, setLastPaths] = useState<readonly string[]>([]);
  const [down, setDown] = useState<string | null>(null);

  const scan = useCallback(
    async (paths: readonly string[]) => {
      if (service === null || paths.length === 0) {
        return;
      }
      setBusy(true);
      setLastPaths(paths);
      try {
        setResult(await service.scan(paths));
        setDown(null);
      } catch (error) {
        if (error instanceof ServiceError) {
          toast.show({ tone: 'danger', title: t('consentFlow.error'), description: error.message });
        } else {
          setDown(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setBusy(false);
      }
    },
    [service, t, toast],
  );

  const flow = useConsentFlow(service, () => void scan(lastPaths));

  const pick = async (kind: 'files' | 'folder') => {
    if (platform.pickPaths === null) {
      return;
    }
    await scan(await platform.pickPaths(kind));
  };

  const notable = result?.findings.filter((f) => f.risk !== 'clean') ?? [];

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.scan.eyebrow')}
        title={t('pages.scan.title')}
        description={t('scanner.intro')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : (
        <>
          <Panel
            title={t('pages.scan.tagline')}
            actions={
              <div className="flex gap-2">
                <Button iconStart={<IconFile />} loading={busy} onClick={() => void pick('files')}>
                  {t('scanner.pickFiles')}
                </Button>
                <Button
                  iconStart={<IconTree />}
                  variant="primary"
                  loading={busy}
                  onClick={() => void pick('folder')}
                >
                  {t('scanner.pickFolder')}
                </Button>
              </div>
            }
          >
            {down !== null && <ServiceNotice kind="down" detail={down} />}
            {result === null && down === null && (
              <p className="text-sm text-text-muted">
                {busy ? t('scanner.scanning') : t('scanner.intro')}
              </p>
            )}
            {result !== null && (
              <div aria-live="polite">
                <p className="text-sm text-text-muted tabular-nums" data-testid="scan-summary">
                  {t('scanner.checked', {
                    count: String(result.findings.length),
                    notable: String(notable.length),
                  })}
                </p>
                {notable.length === 0 ? (
                  <p className="mt-3 text-sm text-success">{t('scanner.clean')}</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {notable.map((f) => (
                      <FindingRow
                        key={f.path}
                        finding={f}
                        onIsolate={() => void flow.start(() => service.proposeQuarantine([f.path]))}
                      />
                    ))}
                  </ul>
                )}
                {result.skipped.length > 0 && (
                  <p className="mt-3 text-xs text-text-subtle">
                    {t('scanner.skipped', { count: String(result.skipped.length) })}
                  </p>
                )}
                {result.truncated && (
                  <p className="mt-1 text-xs text-warn">{t('scanner.truncated')}</p>
                )}
              </div>
            )}
          </Panel>
          {flow.dialogs}
        </>
      )}
    </PageBody>
  );
}
