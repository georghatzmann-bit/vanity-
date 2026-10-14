/** WLAN-Scanner: Kanalbelegung je Band als Balken (eigenes Netz und Empfehlung markiert). */
import { useMemo, useState } from "react";
import { formatNumber } from "@/lib/format";
import { getLanguage, useT } from "@/lib/i18n";
import type { ChannelAdvice, WifiBand, WifiNetwork } from "@/lib/types";
import { bandNumber, channelBars, PSC_6, type OwnNetwork } from "@/lib/wifichan";
import { Segmented } from "@/components/ui/Segmented";
import { usageKey } from "./ChannelAdviceCard";
import { cn } from "@shared/lib/cn";

const ALL_BANDS: WifiBand[] = ["2.4", "5", "6"];
/** Beschriftete Kanäle (bei 5/6 GHz nur Blockanfänge bzw. PSC, sonst wird es zu eng) */
const LABELS_5 = [36, 52, 100, 116, 132, 149, 165];
const labelled = (band: WifiBand, ch: number, own: boolean) => band === "2.4" || own || (band === "5" ? LABELS_5.includes(ch) : PSC_6.includes(ch as (typeof PSC_6)[number]));

export function ChannelBars({ networks, own, advice }: { networks: WifiNetwork[]; own: OwnNetwork | null; advice: ChannelAdvice[] }) {
  const t = useT();
  const bands = ALL_BANDS.filter((b) => b === own?.band || networks.some((n) => n.band === b));
  const [picked, setPicked] = useState<WifiBand | null>(null);
  const band: WifiBand | null = picked && bands.includes(picked) ? picked : (own?.band ?? bands[0] ?? null);
  const adv = advice.find((a) => a.band === band) ?? null;
  const bars = useMemo(() => (band ? channelBars(networks, band, own, adv) : []), [networks, band, own, adv]);
  if (!band) return null;
  const peak = Math.max(0, ...bars.map((b) => b.load));
  const max = Math.max(2, peak);
  // Wenig los: niedrigere Fläche statt viel Leerraum über winzigen Balken
  const quiet = peak < 1;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[12px] text-muted">{t("wifiScan.occupancyHint")}</div>
        {bands.length > 1 && <Segmented size="sm" value={band} onChange={(b) => setPicked(b)} options={bands.map((b) => ({ value: b, label: t("wifiScan.band", { band: bandNumber(b, getLanguage()) }) }))} />}
      </div>
      {!own && <div className="mt-2 text-[11px] text-faint">{t("wifiScan.ifRouter")}</div>}
      {quiet && <div className="mt-2 text-[12px] text-fg-soft">{t("wifiScan.quietBand")}</div>}
      <div className={cn("mt-4 flex items-end gap-[3px]", quiet ? "h-[110px]" : "h-[150px]")} role="img" aria-label={t("wifiScan.occupancy")}>
        {bars.map((b) => (
          <div
            key={b.channel}
            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
            title={t("wifiScan.barTitle", { ch: b.channel, usage: t(`wifiScan.usage.${usageKey(b.load)}`), load: formatNumber(b.load, 2), n: b.count })}
          >
            {b.own && <span className="mb-1 h-1.5 w-1.5 rounded-full bg-accent" />}
            <div
              className={cn("w-full rounded-t-[3px] transition-[height] duration-500", b.recommended && "outline-2 outline-offset-1 outline-success", b.own && !b.recommended && "outline-2 outline-offset-1 outline-accent")}
              style={{
                height: `${Math.max(3, (b.load / max) * 100)}%`,
                background: b.load === 0 ? "var(--nv-surface-3)" : b.own ? "color-mix(in oklab, var(--nv-accent) 70%, transparent)" : b.dfs ? "color-mix(in oklab, var(--nv-warning) 55%, transparent)" : "color-mix(in oklab, var(--nv-fg-soft) 45%, transparent)",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px]">
        {bars.map((b) => (
          <span key={b.channel} className={cn("min-w-0 flex-1 overflow-visible text-center text-[9px] whitespace-nowrap tabular", b.own || b.recommended ? "font-semibold text-fg" : "text-faint")}>
            {labelled(band, b.channel, b.own) ? b.channel : ""}
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-accent/70" /> {t("wifiScan.legendOwn")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm outline-2 outline-success" /> {t("wifiScan.legendRec")}
        </span>
        {band === "5" && (
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "color-mix(in oklab, var(--nv-warning) 55%, transparent)" }} /> {t("wifiScan.legendDfs")}
          </span>
        )}
      </div>
    </div>
  );
}
