/**
 * Defender-Schalter (P8): zeigt den echten Stand von Microsoft Defender und schlägt Änderungen
 * nur als Plan vor (Echtzeitschutz aus/an, Funde nur melden). Ausgeführt wird erst nach „Ja“
 * im Dienst; danach liest die Seite den Stand neu und sagt ehrlich, ob Windows ihn übernommen
 * hat. Ist der Manipulationsschutz an, gibt es nur die Anleitung – AEGIS umgeht ihn nie.
 */
import { Button, IconRefresh, Panel, SafeText } from '@aegis/ui';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { TextKey } from '../i18n/translator.ts';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type { DefenderChange, DefenderState, DefenderStatus } from '../platform/service.ts';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

/** Hat Windows die Änderung übernommen? (`null` = nicht prüfbar) */
function applied(change: DefenderChange, s: DefenderStatus): boolean | null {
  switch (change) {
    case 'realtime_off':
      return s.realtime === null ? null : !s.realtime;
    case 'realtime_on':
      return s.realtime;
    case 'report_only_on':
      return s.reportOnly;
    case 'report_only_off':
      return !s.reportOnly;
  }
}

function Flag({ value }: { readonly value: boolean | null }) {
  const { t } = useT();
  if (value === null) {
    return <span className="text-text-subtle">{t('defender.unknown')}</span>;
  }
  return value ? (
    <span className="font-medium text-success">{t('defender.on')}</span>
  ) : (
    <span className="font-medium text-warn">{t('defender.off')}</span>
  );
}

function StatusList({ status }: { readonly status: DefenderStatus }) {
  const { t } = useT();
  const rows: readonly [TextKey, React.ReactNode][] = [
    ['defender.item.realtime', <Flag key="r" value={status.realtime} />],
    ['defender.item.service', <Flag key="s" value={status.service} />],
    ['defender.item.cloud', <Flag key="c" value={status.cloud} />],
    ['defender.item.tamper', <Flag key="t" value={status.tamper} />],
    ['defender.item.reportOnly', <Flag key="o" value={status.reportOnly} />],
    [
      'defender.item.signatures',
      status.signatureAgeDays === null ? (
        <span className="text-text-subtle">{t('defender.unknown')}</span>
      ) : (
        <span className={status.signatureAgeDays > 7 ? 'text-warn' : 'text-text'}>
          {t('defender.signatureAge', { days: String(status.signatureAgeDays) })}
        </span>
      ),
    ],
    [
      'defender.item.mode',
      status.runningMode === null ? (
        <span className="text-text-subtle">{t('defender.unknown')}</span>
      ) : (
        <SafeText value={status.runningMode} />
      ),
    ],
  ];
  return (
    <dl
      className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2"
      data-testid="defender-status"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4">
          <dt className="text-text-muted">{t(label)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DefenderPage() {
  const { t, locale } = useT();
  const platform = usePlatform();
  const service = platform.service;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<DefenderState | null>(null);
  const [failed, setFailed] = useState(false);
  const [expected, setExpected] = useState<DefenderChange | null>(null);
  const [executed, setExecuted] = useState(false);
  const flow = useConsentFlow(service, () => {
    setExecuted(true);
    setVersion((v) => v + 1);
  });

  useEffect(() => {
    if (service === null) {
      return undefined;
    }
    let active = true;
    service.defenderStatus().then(
      (s) => {
        if (active) {
          setState(s);
          setFailed(false);
        }
      },
      () => {
        if (active) {
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [service, version]);

  const propose = (change: DefenderChange) => {
    if (service === null) {
      return;
    }
    setExpected(change);
    setExecuted(false);
    void flow.start(() => service.proposeDefender(change));
  };

  const refresh = (
    <Button
      size="sm"
      variant="secondary"
      iconStart={<IconRefresh />}
      onClick={() => {
        setExecuted(false);
        setVersion((v) => v + 1);
      }}
    >
      {t('defender.refresh')}
    </Button>
  );

  const blockedText = (change: DefenderChange) => {
    const b = state?.options[change];
    return b === null || b === undefined || b === 'already_there'
      ? null
      : t(`defender.blocked.${b}` satisfies TextKey);
  };

  const status = state?.status;
  const result =
    executed && expected !== null && status !== undefined ? applied(expected, status) : null;

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.defender.eyebrow')}
        title={t('pages.defender.title')}
        description={t('defender.intro')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : state === null || status === undefined ? (
        <Panel title={t('defender.statusTitle')} actions={refresh}>
          <p className="text-sm text-text-muted" role="status">
            {failed ? t('defender.unavailable') : t('defender.loading')}
          </p>
        </Panel>
      ) : !status.available ? (
        <Panel title={t('defender.statusTitle')} actions={refresh}>
          <p className="text-sm text-text-muted" role="status">
            {t('defender.unavailable')}
          </p>
        </Panel>
      ) : (
        <>
          <Panel title={t('defender.statusTitle')} actions={refresh}>
            <StatusList status={status} />
            {result !== null && (
              <p
                role="status"
                data-testid="defender-result"
                className={`mt-4 text-sm font-medium ${result ? 'text-success' : 'text-warn'}`}
              >
                {result ? t('defender.afterOk') : t('defender.afterNotApplied')}
              </p>
            )}
          </Panel>

          <Panel title={t('defender.switchTitle')}>
            <div className="space-y-4 text-sm" data-testid="defender-switch">
              {!state.admin && <p className="text-warn">{t('defender.adminOnly')}</p>}
              {status.realtime === false ? (
                <div className="space-y-2">
                  <Button
                    variant="primary"
                    size="lg"
                    disabled={!state.admin || state.options.realtime_on !== null}
                    onClick={() => propose('realtime_on')}
                  >
                    {t('defender.turnOn')}
                  </Button>
                  {blockedText('realtime_on') !== null && (
                    <p className="text-text-muted">{blockedText('realtime_on')}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <Button
                    variant="danger"
                    size="lg"
                    disabled={!state.admin || state.options.realtime_off !== null}
                    onClick={() => propose('realtime_off')}
                  >
                    {t('defender.turnOff')}
                  </Button>
                  {blockedText('realtime_off') !== null && (
                    <p className="text-text-muted">{blockedText('realtime_off')}</p>
                  )}
                  <p className="text-text-muted">{t('defender.offWarning')}</p>
                </div>
              )}
              <div className="space-y-2 border-t border-border pt-4">
                {status.reportOnly ? (
                  <Button
                    variant="secondary"
                    disabled={!state.admin || state.options.report_only_off !== null}
                    onClick={() => propose('report_only_off')}
                  >
                    {t('defender.reportOnlyOff')}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={!state.admin || state.options.report_only_on !== null}
                    onClick={() => propose('report_only_on')}
                  >
                    {t('defender.reportOnlyOn')}
                  </Button>
                )}
                {blockedText(status.reportOnly ? 'report_only_off' : 'report_only_on') !== null && (
                  <p className="text-text-muted">
                    {blockedText(status.reportOnly ? 'report_only_off' : 'report_only_on')}
                  </p>
                )}
                <p className="text-text-muted">{t('defender.reportOnlyHint')}</p>
              </div>
              <p className="text-xs text-text-subtle">{t('defender.elevation')}</p>
              <p className="text-xs text-text-subtle">{t('defender.scope')}</p>
            </div>
          </Panel>

          {status.tamper === true && (
            <Panel title={t('defender.tamperTitle')}>
              <div className="space-y-3 text-sm" data-testid="defender-tamper">
                <ol className="list-decimal space-y-1 pl-5 text-text">
                  <li>{t('defender.tamperSteps1')}</li>
                  <li>{t('defender.tamperSteps2')}</li>
                  <li>{t('defender.tamperSteps3')}</li>
                  <li>{t('defender.tamperSteps4')}</li>
                </ol>
                <p className="font-medium text-warn">{t('defender.tamperSteps5')}</p>
                {platform.openWindowsSettings !== null && (
                  <Button
                    variant="secondary"
                    onClick={() => void platform.openWindowsSettings?.('defender_settings')}
                  >
                    {t('defender.openSecurity')}
                  </Button>
                )}
              </div>
            </Panel>
          )}

          <Panel title={t('defender.logTitle')}>
            {state.log.length === 0 ? (
              <p className="text-sm text-text-muted">{t('defender.logEmpty')}</p>
            ) : (
              <ul className="space-y-1 text-sm" data-testid="defender-log">
                {state.log.map((e) => (
                  <li key={`${e.at}-${e.title}`} className="flex flex-wrap gap-x-3">
                    <span className="text-text-subtle tabular-nums">
                      {Number.isNaN(Date.parse(e.at))
                        ? e.at
                        : new Date(e.at).toLocaleString(locale)}
                    </span>
                    <SafeText value={e.title} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
      {flow.dialogs}
    </PageBody>
  );
}
