/** Netzwerk › Verbindung: Adapter und WLAN (aus pages/Network.tsx ausgelagert). */
import { useEffect } from "react";
import { Cable, Wifi } from "lucide-react";
import { signalLabel } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import { useNet } from "@/store/net";
import { LagCard } from "@/components/net/LagCard";
import { Ring } from "@/components/ui/Ring";
import { cn } from "@shared/lib/cn";

export function ConnectionPanel() {
  const t = useT();
  const { adapters, wifi, refreshConnection } = useNet();
  useEffect(() => {
    void refreshConnection();
  }, [refreshConnection]);
  const tips: string[] = [];
  if (wifi) {
    if (wifi.band === "2.4") tips.push(t("network.connection.tip24"));
    if (wifi.signal < 50) tips.push(t("network.connection.tipWeak"));
    tips.push(t("network.connection.tipCable"));
    if (!tips.length) tips.push(t("network.connection.tipGood"));
  }
  return (
    <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-5 xl:grid-cols-2">
      <div>
        <p className="text-[13px] text-muted">{t("network.connection.intro")}</p>
        <div className="mt-4 px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("network.connection.adapters")}</div>
        <div className="mt-2 flex flex-col gap-2">
          {adapters.length === 0 && <div className="glass rounded-xl p-5 text-sm text-muted">{t("network.connection.noAdapters")}</div>}
          {adapters.map((a) => (
            <div key={a.id} className={cn("glass rounded-xl p-4", a.primary && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-accent)_55%,transparent)]")}>
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-surface-2 text-accent">{a.kind === "wifi" ? <Wifi className="h-5 w-5" /> : <Cable className="h-5 w-5" />}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                    {a.name}
                    {a.primary && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">{t("network.connection.primary")}</span>}
                    {!a.up && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted">{t("common.off")}</span>}
                  </div>
                  <div className="truncate text-[11px] text-muted">{a.description}</div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  [t("network.connection.speed"), a.speedMbps ? (a.speedMbps >= 1000 ? `${a.speedMbps / 1000} Gbit/s` : `${a.speedMbps} Mbit/s`) : "–"],
                  [t("network.connection.ip"), a.ipv4.join(", ") || "–"],
                  [t("network.connection.gateway"), a.gateway ?? "–"],
                  [t("network.connection.dns"), a.dns.join(", ") || "–"],
                ].map(([l, v]) => (
                  <div key={l} className="min-w-0 rounded-lg bg-surface px-3 py-2" title={v}>
                    <div className="truncate text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{l}</div>
                    <div className="truncate text-[13px] font-medium text-fg tabular">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("network.connection.wifi")}</div>
        {wifi ? (
          <div className="glass mt-2 rounded-xl p-5">
            <div className="flex items-center gap-5">
              <Ring value={wifi.signal / 100} size={96} stroke={9} color={wifi.signal >= 60 ? "var(--nv-success)" : wifi.signal >= 40 ? "var(--nv-warning)" : "var(--nv-danger)"}>
                <div className="text-center">
                  <div className="font-display text-xl font-bold text-fg tabular">{wifi.signal}%</div>
                  <div className="text-[9px] text-muted uppercase">{t("network.connection.signal")}</div>
                </div>
              </Ring>
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-lg font-bold text-fg">{wifi.ssid}</div>
                <div className="text-[12px] text-muted">{t(`cockpit.signal.${signalLabel(wifi.signal)}`)}{wifi.rssi !== null ? ` · ${wifi.rssi} dBm` : ""}</div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[
                    [t("network.connection.band"), wifi.band ? `${wifi.band} GHz` : "–"],
                    [t("network.connection.channel"), wifi.channel ?? "–"],
                    [t("network.connection.standard"), wifi.phy],
                    [t("network.connection.rate"), wifi.rxMbps ? `${Math.round(wifi.rxMbps)} Mbit/s` : "–"],
                  ].map(([l, v]) => (
                    <div key={String(l)} className="min-w-0 rounded-lg bg-surface px-3 py-2">
                      <div className="truncate text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{l}</div>
                      <div className="truncate text-[13px] font-medium text-fg tabular">{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="glass mt-2 flex items-center gap-3 rounded-xl p-5 text-sm text-fg-soft">
            <Cable className="h-5 w-5 text-success" /> {t("network.connection.noWifi")}
          </div>
        )}
        {tips.length > 0 && (
          <div className="glass mt-4 rounded-xl p-4">
            <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("network.connection.tips")}</div>
            <ul className="mt-2 space-y-2 text-[13px] text-fg-soft">
              {tips.map((tip) => (
                <li key={tip} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {/* Steckplatz: Lag-Detektiv (F1) */}
      <div className="xl:col-span-2">
        <LagCard />
      </div>
    </div>
  );
}
