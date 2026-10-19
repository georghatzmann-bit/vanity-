/**
 * Panic-Button (Notfall-Scan): prüft sofort die typischen Verstecke und die laufenden
 * Programme – nur lesend. Danach: gewählte Funde in einem Plan isolieren (vorausgewählt nur
 * „Gefährlich“), Zusammenfassung und „Alles rückgängig machen“ – jeweils nur nach „Ja“.
 */
import { Button, IconPanic, IconUndo, Panel, RiskBadge, SafeText, useToast } from '@aegis/ui';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { EmergencyResult, ScanFinding, ServiceApi } from '../platform/service.ts';
import { hasEmergencyRequest, takeEmergencyRequest } from './emergencyRequest.ts';
import { useConsentFlow } from './useConsentFlow.tsx';

const RISK_ORDER: Readonly<Record<ScanFinding['risk'], number>> = {
  dangerous: 0,
  suspicious: 1,
  risky: 2,
  game: 3,
  info: 4,
  clean: 5,
};

export function EmergencyPanel({ service }: { readonly service: ServiceApi }) {
  const { t, language } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EmergencyResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [isolated, setIsolated] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<'isolate' | 'undo' | null>(null);

  const flow = useConsentFlow(service, (done) => {
    if (pending === 'isolate' && done.entryIds.length > 0) {
      setIsolated(done.entryIds);
    } else if (pending === 'undo') {
      setIsolated([]);
      toast.show({ tone: 'success', title: t('emergency.undone') });
    }
    setPending(null);
  });

  const run = async () => {
    setBusy(true);
    setIsolated([]);
    try {
      const r = await service.emergencyScan();
      setResult(r);
      setSelected(
        new Set(
          r.areas
            .filter((a) => a.id !== 'memory')
            .flatMap((a) => a.findings)
            .filter((f) => f.risk === 'dangerous')
            .map((f) => f.path),
        ),
      );
    } catch (error) {
      toast.show({
        tone: 'danger',
        title: t('consentFlow.error'),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  // Vom Dashboard bzw. der Befehlspalette angefordert: gleich starten (nur lesend).
  useEffect(() => {
    if (!hasEmergencyRequest()) {
      return;
    }
    const id = setTimeout(() => {
      if (takeEmergencyRequest()) {
        void run();
      }
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Öffnen der Seite
  }, []);

  // Dateifunde aller Bereiche (ohne Speicher), je Pfad einmal, nach Stufe sortiert.
  const files: ScanFinding[] = [];
  for (const area of result?.areas ?? []) {
    if (area.id === 'memory') {
      continue;
    }
    for (const f of area.findings) {
      if (f.risk !== 'clean' && !files.some((x) => x.path === f.path)) {
        files.push(f);
      }
    }
  }
  files.sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]);
  const memory = result?.areas.find((a) => a.id === 'memory')?.findings ?? [];
  const chosen = files.filter((f) => selected.has(f.path)).map((f) => f.path);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });

  return (
    <Panel
      title={t('emergency.title')}
      description={t('emergency.honest')}
      actions={
        <Button
          variant="danger"
          iconStart={<IconPanic />}
          loading={busy}
          onClick={() => void run()}
        >
          {t('emergency.run')}
        </Button>
      }
    >
      <div aria-live="polite" data-testid="emergency-panel">
        {busy && <p className="text-sm text-text-muted">{t('emergency.running')}</p>}
        {result !== null && !busy && (
          <div className="space-y-4" data-testid="emergency-result">
            <p className="text-xs text-text-subtle">
              {t('emergency.update', { note: result.update })}
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {result.areas.map((a) => (
                <li
                  key={a.id}
                  className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
                >
                  <span className="text-text">{t(`emergency.areas.${a.id}`)}</span>
                  <span className="ml-2 text-text-muted tabular-nums">
                    {t('emergency.area', {
                      checked: String(a.checked),
                      found: String(a.findings.filter((f) => f.risk !== 'clean').length),
                    })}
                  </span>
                  {a.note !== null && (
                    <span className="block text-xs text-text-subtle">
                      <SafeText value={a.note} />
                    </span>
                  )}
                </li>
              ))}
            </ul>

            {isolated.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-2 p-4"
                data-testid="emergency-summary"
              >
                <p className="text-sm text-text">
                  {t('emergency.isolated', { count: String(isolated.length) })}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  iconStart={<IconUndo />}
                  onClick={() => {
                    setPending('undo');
                    void flow.start(() => service.proposeRestoreMany(isolated));
                  }}
                >
                  {t('emergency.undo')}
                </Button>
              </div>
            )}

            {files.length === 0 && memory.length === 0 ? (
              <p className="text-sm text-success">{t('emergency.clean')}</p>
            ) : (
              <>
                {files.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="danger"
                        disabled={chosen.length === 0}
                        onClick={() => {
                          setPending('isolate');
                          void flow.start(() => service.proposeQuarantine(chosen));
                        }}
                      >
                        {t('emergency.isolate', { count: String(chosen.length) })}
                      </Button>
                      <p className="text-xs text-text-subtle">{t('emergency.preselected')}</p>
                    </div>
                    <ul className="space-y-2">
                      {files.map((f) => (
                        <li
                          key={f.path}
                          className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 p-3"
                          data-testid="emergency-finding"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            checked={selected.has(f.path)}
                            aria-label={t('emergency.select', { path: f.path })}
                            onChange={() => toggle(f.path)}
                          />
                          <div className="min-w-0 flex-1">
                            <RiskBadge level={f.risk} />
                            <p className="mt-1 text-sm text-text">
                              <SafeText value={f.path} mono breakAll />
                            </p>
                            <p className="mt-1 text-sm text-text-muted">
                              {language === 'en' ? f.summaryEn : f.summaryDe}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {memory.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-text">{t('emergency.memoryTitle')}</h3>
                    <p className="text-xs text-text-subtle">{t('emergency.memoryHint')}</p>
                    <ul className="space-y-2">
                      {memory.map((f, i) => {
                        const program = result.memory[i]?.program ?? null;
                        return (
                          <li
                            key={f.path}
                            className="rounded-xl border border-border bg-surface-2 p-3"
                            data-testid="emergency-memory"
                          >
                            <RiskBadge level={f.risk} />
                            <p className="mt-1 text-sm text-text">
                              <SafeText value={f.path} mono breakAll />
                            </p>
                            {program !== null && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="mt-2"
                                onClick={() =>
                                  void flow.start(() =>
                                    service.proposeProcessAction(program, 'terminate'),
                                  )
                                }
                              >
                                {t('emergency.terminate')}
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {flow.dialogs}
    </Panel>
  );
}
