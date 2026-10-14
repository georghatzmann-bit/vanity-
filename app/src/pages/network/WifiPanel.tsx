/**
 * Netzwerk › WLAN: WLAN-Scanner (Netzliste, Kanalbelegung, Empfehlung für den Router) und Raum-Scan.
 * Vertrag: docs/API.md, „WLAN-Scanner und Raum-Scan“. Aktiver Scan nur beim Öffnen und per Knopf –
 * nie während eines Spiels; solange der Tab sichtbar ist, alle 30 s die Liste aus dem Zwischenspeicher.
 */
import { useEffect, useMemo } from "react";
import { Gamepad2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { backendText } from "@/lib/netauto";
import { formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { channelAdvice, connectedNetwork, type OwnNetwork } from "@/lib/wifichan";
import { isLockedError, useWifiScan } from "@/store/wifiscan";
import { ChannelAdviceCard } from "@/components/net/wifi/ChannelAdviceCard";
import { ChannelBars } from "@/components/net/wifi/ChannelBars";
import { LocationLock } from "@/components/net/wifi/LocationLock";
import { NetworkList } from "@/components/net/wifi/NetworkList";
import { RoomScan } from "@/components/net/wifi/RoomScan";
import { Button } from "@shared/ui/Button";

/** Zwischenspeicher-Abruf, solange der Tab sichtbar ist */
const CACHE_POLL_MS = 30_000;
/** So lange gilt eine Liste nach einem aktiven Scan noch als frisch */
const FRESH_FOR_MS = 120_000;

export function WifiPanel() {
  const t = useT();
  const { scan, freshAt, wifiState, primary, scanning, loading, error, gameRunning, open, refresh } = useWifiScan();

  useEffect(() => {
    void open();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void useWifiScan.getState().refresh(false);
    }, CACHE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open]);

  const networks = useMemo(() => scan?.networks ?? [], [scan]);
  const own: OwnNetwork | null = useMemo(() => {
    const hit = connectedNetwork(networks);
    if (hit) return hit;
    const w = wifiState?.state === "connected" ? wifiState.wifi : null;
    return w && w.band && w.channel ? { ssid: w.ssid, bssid: "", channel: w.channel, band: w.band, widthMhz: null } : null;
  }, [networks, wifiState]);
  const fresh = !!scan && (scan.fresh || (freshAt !== null && scan.at - freshAt < FRESH_FOR_MS));
  const advice = useMemo(() => (networks.length || own ? channelAdvice(networks, own, { wiredPrimary: primary?.kind === "ethernet", fresh }) : []), [networks, own, primary, fresh]);

  const locked = wifiState?.state === "locked" || isLockedError(error);
  const noService = !locked && (wifiState?.state === "noService" || (scan !== null && scan.interfaces === 0));
  const first = scan === null && loading;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[640px] text-[13px] text-muted">{t("wifiScan.intro")}</p>
        <div className="flex items-center gap-3">
          {scan && !locked && !noService && (
            <span className="text-[11px] text-faint tabular">
              {t("wifiScan.updated", { time: formatTime(scan.at) })} · {fresh ? t("wifiScan.fresh") : t("wifiScan.cache")}
            </span>
          )}
          <Button variant="secondary" size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={scanning} disabled={loading && !scanning} onClick={() => void refresh(true)}>
            {scanning ? t("wifiScan.scanning") : t("wifiScan.refresh")}
          </Button>
        </div>
      </div>

      {gameRunning && !locked && (
        <div className="glass flex items-start gap-3 rounded-xl px-4 py-3 text-[13px] text-fg-soft">
          <Gamepad2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            <div className="font-semibold text-fg">{t("wifiScan.gameRunning")}</div>
            <div className="text-[12px] text-muted">{t("wifiScan.gameRunningHint")}</div>
          </div>
        </div>
      )}

      {locked ? (
        <LocationLock busy={loading} onRetry={() => void refresh(true)} />
      ) : noService ? (
        <div className="glass flex items-start gap-4 rounded-xl p-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
            <WifiOff className="h-5 w-5" />
          </span>
          <div>
            <div className="text-[15px] font-semibold text-fg">{t("wifiScan.noInterface")}</div>
            <p className="mt-1 text-[13px] text-fg-soft">{t("wifiScan.noInterfaceHint")}</p>
          </div>
        </div>
      ) : (
        <>
          {error && (
            <div className="rounded-xl bg-danger/10 px-4 py-3 text-[13px] text-danger">
              {t("wifiScan.error")} {backendText(error, t)}
            </div>
          )}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {networks.length > 0 && (
              <div className="glass min-w-0 rounded-xl p-5">
                <div className="mb-3 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("wifiScan.occupancy")}</div>
                <ChannelBars networks={networks} own={own} advice={advice} />
              </div>
            )}
            <div className="min-w-0">
              <ChannelAdviceCard advice={advice} />
            </div>
          </div>
          <div className="glass min-w-0 rounded-xl py-4">
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
                <Wifi className="h-4 w-4 text-accent" /> {t("wifiScan.networks")}
              </div>
              {scan && <span className="text-[11px] text-faint tabular">{t("wifiScan.networksCount", { n: networks.length })}</span>}
            </div>
            {first ? <div className="px-4 py-10 text-center text-[13px] text-muted">{t("wifiScan.scanning")}</div> : <NetworkList networks={networks} own={own} />}
          </div>
        </>
      )}

      <RoomScan noService={noService} />

      <p className="text-[11px] leading-relaxed text-faint">{t("wifiScan.honest")}</p>
    </div>
  );
}
