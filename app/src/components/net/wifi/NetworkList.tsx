/** WLAN-Scanner: Liste der Netze in der Nähe (nur Anzeige – fremde Namen/Adressen werden nie gespeichert). */
import { Lock, LockOpen } from "lucide-react";
import { getLanguage, useT } from "@/lib/i18n";
import type { WifiNetwork } from "@/lib/types";
import { bandNumber, ownership, type OwnNetwork } from "@/lib/wifichan";
import { cn } from "@shared/lib/cn";

/** Signalstufe 1–4 aus dBm */
export function signalLevel(rssi: number): 1 | 2 | 3 | 4 {
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

export const levelColor = (level: number) => (level >= 4 ? "var(--nv-success)" : level === 3 ? "var(--nv-accent)" : level === 2 ? "var(--nv-warning)" : "var(--nv-danger)");

/** Vier Signalbalken */
export function SignalBars({ rssi, className }: { rssi: number; className?: string }) {
  const level = signalLevel(rssi);
  return (
    <span className={cn("inline-flex h-3.5 items-end gap-[2px]", className)} aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className="w-[3px] rounded-[1px]" style={{ height: `${25 * i}%`, background: i <= level ? levelColor(level) : "var(--nv-surface-3)" }} />
      ))}
    </span>
  );
}

/** „Wi-Fi 6 (802.11ax)“ → „Wi-Fi 6“ */
const shortPhy = (phy: string) => phy.replace(/\s*\(.*\)\s*$/, "");

const GRID = "grid grid-cols-[minmax(0,1fr)_92px_56px_56px] gap-x-3 lg:grid-cols-[minmax(0,1fr)_92px_56px_56px_56px_76px_64px]";

export function NetworkList({ networks, own }: { networks: WifiNetwork[]; own: OwnNetwork | null }) {
  const t = useT();
  const age = (s: number | null) => (s === null ? "–" : s < 120 ? t("wifiScan.ageSec", { n: s }) : t("wifiScan.ageMin", { n: Math.round(s / 60) }));
  if (!networks.length) return <div className="px-4 py-8 text-center text-[13px] text-muted">{t("wifiScan.noNetworks")}</div>;
  return (
    <div className="text-[13px]" role="table" aria-label={t("wifiScan.networks")}>
      <div className={cn(GRID, "border-b border-line px-4 pb-2 text-[10px] font-semibold tracking-[0.1em] text-faint uppercase")} role="row">
        <span role="columnheader">{t("wifiScan.col.name")}</span>
        <span role="columnheader">{t("wifiScan.col.signal")}</span>
        <span role="columnheader">{t("wifiScan.col.channel")}</span>
        <span role="columnheader">{t("wifiScan.col.band")}</span>
        <span role="columnheader" className="hidden lg:block">{t("wifiScan.col.width")}</span>
        <span role="columnheader" className="hidden lg:block">{t("wifiScan.col.standard")}</span>
        <span role="columnheader" className="hidden lg:block">{t("wifiScan.col.age")}</span>
      </div>
      <div className="max-h-[360px] overflow-y-auto">
        {networks.map((n) => {
          const o = ownership(n, own);
          return (
            <div key={n.bssid} role="row" className={cn(GRID, "items-center border-b border-line/60 px-4 py-2 last:border-b-0", o !== "foreign" && "bg-accent/[0.06]")}>
              <div className="flex min-w-0 items-center gap-2" role="cell">
                {n.secured ? <Lock className="h-3.5 w-3.5 shrink-0 text-faint" aria-label={t("wifiScan.secured")} /> : <LockOpen className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={t("wifiScan.open")} />}
                <span className={cn("truncate", n.ssid ? "font-medium text-fg" : "text-muted italic")} title={n.ssid || t("wifiScan.hidden")}>
                  {n.ssid || t("wifiScan.hidden")}
                </span>
                {n.connected ? (
                  <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">{t("wifiScan.connected")}</span>
                ) : o === "own" ? (
                  <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">{t("wifiScan.yours")}</span>
                ) : o === "ownExtra" ? (
                  <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-semibold text-fg-soft">{t("wifiScan.yoursExtra")}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-2 tabular" role="cell">
                <SignalBars rssi={n.rssi} />
                <span className="text-fg-soft">{n.rssi} dBm</span>
              </div>
              <span className="text-fg tabular" role="cell">
                {n.channel}
              </span>
              <span className="text-fg-soft tabular" role="cell">
                {bandNumber(n.band, getLanguage())}
              </span>
              <span className="hidden text-fg-soft tabular lg:block" role="cell">
                {n.widthMhz ? `${n.widthMhz}` : "–"}
              </span>
              <span className="hidden truncate text-fg-soft lg:block" role="cell" title={n.phy}>
                {shortPhy(n.phy)}
              </span>
              <span className="hidden text-muted tabular lg:block" role="cell">
                {age(n.ageS)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
