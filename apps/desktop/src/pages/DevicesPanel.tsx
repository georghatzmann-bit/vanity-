/**
 * Geräte & Privatsphäre (P6.6, nur lesend): Wer hat Kamera und Mikrofon benutzt (laut
 * Windows), welche Tastaturen und USB-Laufwerke sind angeschlossen. Neue Tastaturen und
 * beginnende Kamera-/Mikrofon-Nutzung meldet der Wächter des Dienstes von selbst. Dazu der
 * Schalter für den Zwischenablage-Wächter (opt-in).
 */
import { Button, IconRefresh, Panel, RiskBadge, SafeText, Toggle } from '@aegis/ui';
import { useId, useState } from 'react';
import { useServices, useSettingsSnapshot } from '../app/services.tsx';
import { useUpdateSettings } from '../app/useUpdateSettings.ts';
import { useT } from '../i18n/I18nProvider.tsx';
import type { DevicesState, ServiceApi } from '../platform/service.ts';

export function DevicesPanel({ service }: { readonly service: ServiceApi }) {
  const { t, language, locale } = useT();
  const { platform } = useServices();
  const { settings } = useSettingsSnapshot();
  const update = useUpdateSettings();
  const [state, setState] = useState<DevicesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const descriptionId = useId();

  const load = async () => {
    setBusy(true);
    try {
      setState(await service.devicesStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const when = (seconds: number | null) =>
    seconds === null ? '–' : new Date(seconds * 1000).toLocaleString(locale);

  return (
    <Panel
      title={t('devices.title')}
      description={t('devices.intro')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          iconStart={<IconRefresh />}
          onClick={() => void load()}
        >
          {state === null ? t('devices.check') : t('devices.recheck')}
        </Button>
      }
    >
      <div className="space-y-4" data-testid="devices-panel">
        {platform.clipboardGuard !== null && (
          <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 p-3">
            <div className="min-w-0 flex-1">
              <p id={labelId} className="text-sm font-semibold text-text">
                {t('devices.clipboard.label')}
              </p>
              <p id={descriptionId} className="mt-1 text-xs text-text-muted">
                {t('devices.clipboard.description')}
              </p>
            </div>
            <Toggle
              checked={settings.clipboardGuard}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              onCheckedChange={(clipboardGuard) => update({ clipboardGuard })}
              data-testid="setting-clipboard-guard"
            />
          </div>
        )}
        {error !== null && (
          <p className="text-sm text-danger">
            <SafeText value={error} />
          </p>
        )}
        {state === null && !busy && (
          <p className="text-sm text-text-muted">{t('devices.notYet')}</p>
        )}
        {state !== null && !state.available && (
          <p className="text-sm text-text-muted">{t('devices.windowsOnly')}</p>
        )}
        {state !== null && state.available && (
          <>
            <section aria-label={t('devices.usesTitle')}>
              <h3 className="text-sm font-semibold text-text">{t('devices.usesTitle')}</h3>
              {state.uses.length === 0 ? (
                <p className="mt-1 text-sm text-text-muted">{t('devices.usesNone')}</p>
              ) : (
                <ul className="mt-2 space-y-2" data-testid="devices-uses">
                  {state.uses.slice(0, 100).map((u) => (
                    <li
                      key={`${u.capability}:${u.app}`}
                      className="rounded-xl border border-border bg-surface-2 p-3"
                      data-testid="device-use"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-text">
                          {t(`devices.capability.${u.capability}`)}
                          {u.active ? ` · ${t('devices.active')}` : ''}
                        </span>
                        <span className="min-w-0 flex-1 text-xs text-text-muted">
                          <SafeText value={u.app} mono breakAll />
                        </span>
                        <RiskBadge level={u.risk} size="sm" />
                      </div>
                      <p className="mt-1 text-xs text-text-subtle tabular-nums">
                        {t('devices.lastUsed', {
                          start: when(u.lastStart),
                          stop: when(u.lastStop),
                        })}
                      </p>
                      {u.reasons.length > 0 && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-muted">
                          {u.reasons.map((r) => (
                            <li key={r.de}>
                              <SafeText value={language === 'en' ? r.en : r.de} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label={t('devices.devicesTitle')}>
              <h3 className="text-sm font-semibold text-text">{t('devices.devicesTitle')}</h3>
              {state.devices.length === 0 ? (
                <p className="mt-1 text-sm text-text-muted">{t('devices.devicesNone')}</p>
              ) : (
                <ul className="mt-2 space-y-1" data-testid="devices-list">
                  {state.devices.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm text-text">
                      <span className="text-xs text-text-subtle">
                        {t(`devices.kind.${d.kind}`)}
                        {d.external ? '' : ` · ${t('devices.builtIn')}`}
                      </span>
                      <SafeText value={d.name || d.id} />
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-text-subtle">{t('devices.badUsbHint')}</p>
            </section>
          </>
        )}
      </div>
    </Panel>
  );
}
