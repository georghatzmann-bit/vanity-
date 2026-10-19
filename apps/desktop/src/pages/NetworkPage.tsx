/**
 * Netzwerk (P7): Verbindungen je Programm mit Land und Dienst, Verlauf neuer Ziele und
 * Firewall-Übersicht. Alles nur lesend; „Netz sperren …“ ist ein Vorschlag des Dienstes
 * (AEGIS-Regel in der Windows-Firewall) und passiert erst nach „Ja“ – mit Rückgängig.
 */
import { Button, IconRefresh, Panel, SafeText, SegmentedControl } from '@aegis/ui';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import { usePlatform } from '../platform/PlatformContext.tsx';
import type {
  FirewallRuleView,
  FirewallState,
  NetConnection,
  NetworkState,
  ServiceApi,
} from '../platform/service.ts';
import { HomeNetworkPanel } from './HomeNetworkPanel.tsx';
import { PageBody, PageHeader } from './PageHeader.tsx';
import { ServiceNotice } from './ServiceNotice.tsx';
import { useConsentFlow } from './useConsentFlow.tsx';

/** Aktualisierung der Verbindungen, solange die Seite offen ist. */
const REFRESH_MS = 10_000;

type Filter = 'internet' | 'new' | 'all';

function fileName(path: string | null): string {
  if (path === null) {
    return '?';
  }
  return path.split(/[\\/]/).pop() ?? path;
}

function useCountryName(): (code: string | null) => string {
  const { locale } = useT();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    return (code: string | null) => {
      if (code === null) {
        return '–';
      }
      try {
        return names?.of(code) ?? code;
      } catch {
        return code;
      }
    };
  }, [locale]);
}

function ConnectionsPanel({
  service,
  start,
  version,
}: {
  readonly service: ServiceApi;
  readonly start: (load: () => ReturnType<ServiceApi['proposeFirewallBlock']>) => void;
  readonly version: number;
}) {
  const { t, locale } = useT();
  const country = useCountryName();
  const [state, setState] = useState<NetworkState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('internet');

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setState(await service.networkStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [service]);

  useEffect(() => {
    let active = true;
    const tick = () => {
      service.networkStatus().then(
        (s) => {
          if (active) {
            setState(s);
            setError(null);
          }
        },
        (e: unknown) => {
          if (active) {
            setError(e instanceof Error ? e.message : String(e));
          }
        },
      );
    };
    tick();
    const timer = window.setInterval(tick, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [service, version]);

  const shown = (state?.connections ?? []).filter((c: NetConnection) =>
    filter === 'all' ? true : filter === 'new' ? c.isNew : c.scope === 'public',
  );
  const when = (s: number) => new Date(s * 1000).toLocaleString(locale);

  return (
    <Panel
      title={t('network.connections.title')}
      description={t('network.connections.intro')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          iconStart={<IconRefresh />}
          onClick={() => void load()}
        >
          {t('network.refresh')}
        </Button>
      }
    >
      <div className="space-y-3" data-testid="network-connections">
        {error !== null && (
          <p className="text-sm text-danger">
            <SafeText value={error} />
          </p>
        )}
        {state !== null && !state.available && (
          <p className="text-sm text-text-muted">{t('network.windowsOnly')}</p>
        )}
        {state !== null && state.available && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl<Filter>
                label={t('network.filter')}
                size="sm"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: 'internet', label: t('network.filterInternet') },
                  {
                    value: 'new',
                    label: t('network.filterNew', {
                      count: String(state.connections.filter((c) => c.isNew).length),
                    }),
                  },
                  {
                    value: 'all',
                    label: t('network.filterAll', { count: String(state.connections.length) }),
                  },
                ]}
              />
              <span className="text-xs text-text-subtle">
                {state.admin ? t('network.allAccounts') : t('network.ownOnly')}
              </span>
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-text-muted">{t('network.none')}</p>
            ) : (
              <ul className="space-y-2">
                {shown.slice(0, 200).map((c) => (
                  <li
                    key={`${String(c.pid)}-${c.remote}-${String(c.port)}`}
                    className={`rounded-xl border bg-surface-2 p-3 ${c.isNew ? 'border-warn/60' : 'border-border'}`}
                    data-testid="network-connection"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-sm font-semibold text-text">
                        <SafeText value={fileName(c.program)} />
                        <span className="ml-2 text-xs font-normal text-text-subtle tabular-nums">
                          PID {c.pid}
                        </span>
                      </span>
                      {c.isNew && (
                        <span className="rounded-full border border-warn/60 px-2 py-0.5 text-xs font-semibold text-warn">
                          {t('network.newTarget')}
                        </span>
                      )}
                      <span className="text-xs text-text-muted">{country(c.country)}</span>
                    </div>
                    <p className="mt-1 text-xs text-text-muted tabular-nums">
                      <SafeText
                        value={`${c.remote}:${String(c.port)}${c.service === null ? '' : ` · ${c.service}`} · ${t(`network.scope.${c.scope}`)}`}
                        mono
                        breakAll
                      />
                    </p>
                    <p className="mt-1 text-xs text-text-subtle">
                      {t('network.firstSeen', { date: when(c.firstSeen) })}
                    </p>
                    {c.program !== null && c.scope === 'public' && (
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!state.admin}
                          onClick={() => {
                            const program = c.program;
                            if (program !== null) {
                              start(() => service.proposeFirewallBlock(program, true));
                            }
                          }}
                        >
                          {t('network.block')}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!state.admin && <p className="text-xs text-text-subtle">{t('hardening.adminOnly')}</p>}
          </>
        )}
      </div>
    </Panel>
  );
}

function HistoryPanel({ state }: { readonly state: NetworkState | null }) {
  const { t, locale } = useT();
  const country = useCountryName();
  if (state === null || !state.available) {
    return null;
  }
  const when = (s: number) => new Date(s * 1000).toLocaleString(locale);
  return (
    <Panel title={t('network.history.title')} description={t('network.history.intro')}>
      {state.history.length === 0 ? (
        <p className="text-sm text-text-muted">{t('network.history.empty')}</p>
      ) : (
        <ul className="space-y-1 text-sm" data-testid="network-history">
          {state.history.slice(0, 100).map((h) => (
            <li key={`${h.program}-${h.remote}`} className="flex flex-wrap gap-2">
              <span className="font-medium text-text">
                <SafeText value={h.program} />
              </span>
              <span className="text-text-muted tabular-nums">
                <SafeText value={h.remote} mono />
              </span>
              <span className="text-text-subtle">{country(h.country)}</span>
              <span className="text-xs text-text-subtle tabular-nums">
                {t('network.history.seen', {
                  first: when(h.first),
                  last: when(h.last),
                  count: String(h.count),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RuleItem({
  rule,
  action,
}: {
  readonly rule: FirewallRuleView;
  readonly action?: ReactNode;
}) {
  const { t, language } = useT();
  return (
    <li className="rounded-xl border border-border bg-surface-2 p-3" data-testid="firewall-rule">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-semibold text-text">
          <SafeText value={rule.name} />
        </span>
        <span className="text-xs text-text-subtle">
          {t(rule.action === 'block' ? 'network.firewall.block' : 'network.firewall.allow')}
          {' · '}
          {t(rule.direction === 'in' ? 'network.firewall.in' : 'network.firewall.out')}
          {rule.active ? '' : ` · ${t('network.firewall.inactive')}`}
          {rule.policy ? ` · ${t('network.firewall.policy')}` : ''}
        </span>
      </div>
      {rule.program !== null && (
        <p className="mt-1 text-xs text-text-muted">
          <SafeText value={rule.program} mono breakAll />
        </p>
      )}
      {rule.note !== null && (
        <p className="mt-1 text-xs text-warn">
          <SafeText value={language === 'en' ? rule.note.en : rule.note.de} />
        </p>
      )}
      {action}
    </li>
  );
}

function FirewallPanel({
  service,
  start,
  version,
}: {
  readonly service: ServiceApi;
  readonly start: (load: () => ReturnType<ServiceApi['proposeFirewallBlock']>) => void;
  readonly version: number;
}) {
  const { t } = useT();
  const [state, setState] = useState<FirewallState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setState(await service.firewallStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [service]);

  // Nach einer Ausführung (Version ändert sich) die Regeln neu lesen.
  useEffect(() => {
    if (version === 0) {
      return undefined;
    }
    let active = true;
    service.firewallStatus().then(
      (s) => {
        if (active) {
          setState(s);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [service, version]);

  return (
    <Panel
      title={t('network.firewall.title')}
      description={t('network.firewall.intro')}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          iconStart={<IconRefresh />}
          onClick={() => void load()}
        >
          {state === null ? t('network.firewall.check') : t('network.refresh')}
        </Button>
      }
    >
      <div className="space-y-3" data-testid="firewall-panel">
        {error !== null && (
          <p className="text-sm text-danger">
            <SafeText value={error} />
          </p>
        )}
        {state === null && !busy && (
          <p className="text-sm text-text-muted">{t('network.firewall.notYet')}</p>
        )}
        {state !== null && !state.available && (
          <p className="text-sm text-text-muted">{t('network.windowsOnly')}</p>
        )}
        {state !== null && state.available && (
          <>
            <p className="text-sm text-text-muted tabular-nums" data-testid="firewall-summary">
              {t('network.firewall.summary', {
                total: String(state.summary.total),
                active: String(state.summary.active),
                inbound: String(state.summary.inboundAllow),
                block: String(state.summary.block),
                policy: String(state.summary.policy),
              })}
            </p>
            <h3 className="text-sm font-semibold text-text">{t('network.firewall.notable')}</h3>
            {state.notable.length === 0 ? (
              <p className="text-sm text-text-muted">{t('network.firewall.notableNone')}</p>
            ) : (
              <ul className="space-y-2">
                {state.notable.map((r) => (
                  <RuleItem key={`n-${r.name}-${r.program ?? ''}`} rule={r} />
                ))}
              </ul>
            )}
            <h3 className="text-sm font-semibold text-text">{t('network.firewall.aegis')}</h3>
            {state.aegis.length === 0 ? (
              <p className="text-sm text-text-muted">{t('network.firewall.aegisNone')}</p>
            ) : (
              <ul className="space-y-2" data-testid="firewall-aegis">
                {state.aegis.map((r) => (
                  <RuleItem
                    key={`a-${r.name}`}
                    rule={r}
                    action={
                      r.program !== null && (
                        <div className="mt-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!state.admin}
                            onClick={() => {
                              const program = r.program;
                              if (program !== null) {
                                start(() => service.proposeFirewallBlock(program, false));
                              }
                            }}
                          >
                            {t('network.firewall.remove')}
                          </Button>
                        </div>
                      )
                    }
                  />
                ))}
              </ul>
            )}
            <p className="text-xs text-text-subtle">{t('network.firewall.honest')}</p>
          </>
        )}
      </div>
    </Panel>
  );
}

/** Web-Schutz: Hinweise zur Browser-Erweiterung und zu verschlüsseltem DNS (nur Text). */
function WebShieldPanel() {
  const { t } = useT();
  const features = [
    t('network.web.feature1'),
    t('network.web.feature2'),
    t('network.web.feature3'),
    t('network.web.feature4'),
  ];
  return (
    <Panel title={t('network.web.title')} description={t('network.web.intro')}>
      <div className="space-y-4 text-sm" data-testid="web-shield">
        <ul className="list-disc space-y-1 pl-5 text-text">
          {features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div>
          <h3 className="font-medium text-text">{t('network.web.installTitle')}</h3>
          <p className="text-text-muted">{t('network.web.install')}</p>
        </div>
        <div>
          <h3 className="font-medium text-text">{t('network.web.dohTitle')}</h3>
          <p className="text-text-muted">{t('network.web.doh')}</p>
        </div>
        <p className="text-xs text-text-subtle">{t('network.web.honest')}</p>
      </div>
    </Panel>
  );
}

export function NetworkPage() {
  const { t } = useT();
  const platform = usePlatform();
  const service = platform.service;
  const [version, setVersion] = useState(0);
  const [network, setNetwork] = useState<NetworkState | null>(null);
  const flow = useConsentFlow(service, () => setVersion((v) => v + 1));

  useEffect(() => {
    if (service === null) {
      return undefined;
    }
    let active = true;
    service.networkStatus().then(
      (s) => {
        if (active) {
          setNetwork(s);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [service, version]);

  return (
    <PageBody>
      <PageHeader
        eyebrow={t('pages.network.eyebrow')}
        title={t('pages.network.title')}
        description={t('network.intro')}
      />
      {service === null ? (
        <ServiceNotice kind="preview" />
      ) : (
        <>
          <ConnectionsPanel
            service={service}
            start={(load) => void flow.start(load)}
            version={version}
          />
          <HistoryPanel state={network} />
          <FirewallPanel
            service={service}
            start={(load) => void flow.start(load)}
            version={version}
          />
        </>
      )}
      <HomeNetworkPanel />
      <WebShieldPanel />
      {flow.dialogs}
    </PageBody>
  );
}
