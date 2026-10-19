/**
 * Heimnetz (P7.4): Geräte im eigenen privaten Subnetz, Hinweise zu Router und WLAN. Der Scan
 * läuft nur auf Knopfdruck in der App und verändert nichts; neue Geräte merkt sich die App
 * nur auf diesem PC (MAC bzw. Adresse).
 */
import { Button, IconRefresh, Panel, SafeText } from '@aegis/ui';
import { useState } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { TextKey } from '../i18n/translator.ts';
import {
  deviceKey,
  loadKnownDevices,
  saveKnownDevices,
  type LanReport,
  type LanSeverity,
} from '../platform/lan.ts';
import { usePlatform } from '../platform/PlatformContext.tsx';

const HINT_IDS = [
  'router_telnet',
  'router_ftp',
  'router_http_only',
  'router_upnp',
  'device_telnet',
  'device_rdp',
  'device_vnc',
  'device_smb',
  'wifi_open',
  'wifi_wep',
  'wifi_wpa',
  'wifi_tkip',
  'wifi_wpa2',
] as const;
type HintId = (typeof HINT_IDS)[number];
const isHintId = (id: string): id is HintId => (HINT_IDS as readonly string[]).includes(id);

const SECURITY = ['open', 'wep', 'wpa', 'wpa2', 'wpa3', 'owe', 'enterprise'] as const;
type Security = (typeof SECURITY)[number] | 'unknown';
const security = (s: string): Security =>
  (SECURITY as readonly string[]).includes(s) ? (s as Security) : 'unknown';

const REASONS = ['windows_only', 'no_private_network', 'error'] as const;
type Reason = (typeof REASONS)[number];
const reason = (r: string | null): Reason =>
  (REASONS as readonly string[]).includes(r ?? '') ? (r as Reason) : 'error';

const severityClass: Record<LanSeverity, string> = {
  danger: 'text-danger',
  warn: 'text-warn',
  info: 'text-text-muted',
};

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function HomeNetworkPanel() {
  const { t } = useT();
  const platform = usePlatform();
  const scan = platform.homeNetworkScan;
  const [report, setReport] = useState<LanReport | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const run = () => {
    if (scan === null) {
      return;
    }
    setBusy(true);
    scan().then(
      (r) => {
        const known = loadKnownDevices(storage());
        const keys = r.devices.map(deviceKey);
        // Beim ersten Scan gibt es keine Grundlinie – dann ist nichts „neu“.
        setFresh(new Set(known === null ? [] : keys.filter((k) => !known.has(k))));
        if (r.available) {
          saveKnownDevices(storage(), new Set([...(known ?? []), ...keys]));
        }
        setReport(r);
        setBusy(false);
      },
      () => {
        setReport({ ...emptyReport, reason: 'error' });
        setBusy(false);
      },
    );
  };

  const basics = [
    t('network.lan.basic1'),
    t('network.lan.basic2'),
    t('network.lan.basic3'),
    t('network.lan.basic4'),
    t('network.lan.basic5'),
  ];

  return (
    <Panel
      title={t('network.lan.title')}
      description={t('network.lan.intro')}
      actions={
        scan !== null ? (
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            iconStart={<IconRefresh />}
            onClick={run}
          >
            {report === null ? t('network.lan.scan') : t('network.lan.rescan')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4 text-sm" data-testid="home-network" aria-busy={busy}>
        {scan === null ? (
          <p className="text-text-muted">{t('network.lan.preview')}</p>
        ) : busy ? (
          <p className="text-text-muted" role="status">
            {t('network.lan.scanning')}
          </p>
        ) : report === null ? (
          <p className="text-text-muted">{t('network.lan.notYet')}</p>
        ) : !report.available ? (
          <p className="text-text-muted" role="status">
            {t(`network.lan.reason.${reason(report.reason)}` satisfies TextKey)}
          </p>
        ) : (
          <LanResult report={report} fresh={fresh} />
        )}
        <div>
          <h3 className="font-medium text-text">{t('network.lan.basicsTitle')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-text-muted">
            {basics.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-text-subtle">{t('network.lan.honest')}</p>
      </div>
    </Panel>
  );
}

const emptyReport: LanReport = {
  available: false,
  reason: null,
  network: null,
  address: null,
  gateway: null,
  scanned: 0,
  limited: false,
  devices: [],
  wifi: [],
  upnp: null,
  hints: [],
};

function LanResult({
  report,
  fresh,
}: {
  readonly report: LanReport;
  readonly fresh: ReadonlySet<string>;
}) {
  const { t } = useT();
  const hints = report.hints.filter((h) => isHintId(h.id));
  return (
    <>
      <p className="text-text" data-testid="lan-summary" role="status">
        {t('network.lan.summary', {
          network: report.network ?? '',
          count: String(report.devices.length),
          scanned: String(report.scanned),
        })}
      </p>
      {report.limited && <p className="text-text-muted">{t('network.lan.limited')}</p>}

      <div>
        <h3 className="font-medium text-text">{t('network.lan.hintsTitle')}</h3>
        {hints.length === 0 ? (
          <p className="text-text-muted">{t('network.lan.hintsNone')}</p>
        ) : (
          <ul className="space-y-2" data-testid="lan-hints">
            {hints.map((h) => (
              <li key={`${h.id}-${h.target ?? ''}`}>
                <span className={`font-medium ${severityClass[h.severity]}`}>
                  {t(`network.lan.severity.${h.severity}` satisfies TextKey)}
                </span>
                {h.target !== null && (
                  <>
                    {' · '}
                    <SafeText value={h.target} mono />
                  </>
                )}
                <p className="text-text-muted">
                  {t(`network.lan.hint.${h.id as HintId}` satisfies TextKey)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(report.wifi.length > 0 || report.upnp !== null) && (
        <div>
          <h3 className="font-medium text-text">{t('network.lan.wifiTitle')}</h3>
          <ul className="space-y-1 text-text-muted">
            {report.wifi.map((w) => (
              <li key={w.ssid}>
                <SafeText value={w.ssid} />
                {': '}
                {t(`network.lan.security.${security(w.security)}` satisfies TextKey)}
              </li>
            ))}
            {report.upnp !== null && (
              <li>{report.upnp ? t('network.lan.upnpOn') : t('network.lan.upnpOff')}</li>
            )}
          </ul>
        </div>
      )}

      <div>
        <h3 className="font-medium text-text">{t('network.lan.devicesTitle')}</h3>
        <ul className="space-y-1" data-testid="lan-devices">
          {report.devices.map((d) => (
            <li
              key={d.ip}
              className="flex flex-wrap items-baseline gap-x-2"
              data-testid="lan-device"
            >
              <span className="font-medium text-text tabular-nums">
                <SafeText value={d.ip} mono />
              </span>
              {d.gateway && <span className="text-accent">{t('network.lan.router')}</span>}
              {d.thisDevice && <span className="text-text-muted">{t('network.lan.thisPc')}</span>}
              {fresh.has(deviceKey(d)) && !d.thisDevice && (
                <span className="font-medium text-warn">{t('network.lan.newDevice')}</span>
              )}
              {d.mac !== null && (
                <span className="text-xs text-text-subtle">
                  <SafeText value={d.mac} mono />
                </span>
              )}
              {d.privateMac && (
                <span className="text-xs text-text-subtle">{t('network.lan.privateMac')}</span>
              )}
              {d.openPorts.length > 0 && (
                <span className="text-xs text-text-muted">
                  {t('network.lan.ports', { ports: d.openPorts.join(', ') })}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
