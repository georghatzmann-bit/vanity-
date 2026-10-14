/** WLAN-Scanner: Karte „Empfehlung für deinen Router“ mit allen Hinweisen. Pulsar stellt nichts um. */
import { ArrowRight, Info, Router } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { getLanguage, useT } from "@/lib/i18n";
import { bandNumber } from "@/lib/wifichan";
import type { ChannelAdvice } from "@/lib/types";
import { cn } from "@shared/lib/cn";

/** Kanal bzw. 80-MHz-Block als Text */
export function channelText(a: Pick<ChannelAdvice, "band">, ch: number, t: (k: string, v?: Record<string, string | number>) => string) {
  return a.band === "5" && [36, 52, 100, 116].includes(ch) ? t("wifiScan.advice.block", { from: ch, to: ch + 12 }) : t("wifiScan.advice.channel", { n: ch });
}

/** Belegung in Worten (die Zahl steht nur im Tooltip) */
export function usageKey(load: number): "barely" | "some" | "busy" | "crowded" {
  return load < 0.5 ? "barely" : load < 1.5 ? "some" : load < 3 ? "busy" : "crowded";
}

/** Liegt der aktuelle Kanal schon im empfohlenen Kanal bzw. 80-MHz-Block? */
export function currentFits(a: Pick<ChannelAdvice, "band" | "current" | "recommended" | "improvement">): boolean {
  if (a.current === null) return false;
  if (a.improvement === "none") return true;
  const block = a.band === "5" && [36, 52, 100, 116].includes(a.recommended);
  return block ? a.current >= a.recommended && a.current <= a.recommended + 12 : a.current === a.recommended;
}

function Usage({ load }: { load: number }) {
  const t = useT();
  return (
    <span title={formatNumber(load, 2)}>
      {t("wifiScan.advice.load", { usage: t(`wifiScan.usage.${usageKey(load)}`) })}
    </span>
  );
}

function AdviceBlock({ a }: { a: ChannelAdvice }) {
  const t = useT();
  const connected = a.current !== null;
  const fits = currentFits(a);
  const tone = a.improvement === "clear" ? "text-success" : a.improvement === "small" ? "text-accent" : "text-fg-soft";
  return (
    <div>
      {!connected && <div className="text-[13px] font-semibold text-fg">{t("wifiScan.advice.titleNoConnection", { band: bandNumber(a.band, getLanguage()) })}</div>}
      {connected && fits ? (
        // Kanal passt schon: eine Kachel, kein Pfeil
        <div className="mt-1 rounded-lg bg-success/10 px-3 py-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-success)_45%,transparent)]" data-testid="advice-fits">
          <div className="text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{t("wifiScan.advice.current")}</div>
          <div className="text-[15px] font-semibold text-fg tabular">{t("wifiScan.advice.fits", { channel: t("wifiScan.advice.channel", { n: a.current ?? 0 }) })}</div>
          {a.loadCurrent !== null && (
            <div className="text-[11px] text-muted">
              <Usage load={a.loadCurrent} />
            </div>
          )}
        </div>
      ) : connected ? (
        <div className="mt-1 flex flex-wrap items-stretch gap-3">
          <div className="min-w-[130px] flex-1 rounded-lg bg-surface px-3 py-2">
            <div className="text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{t("wifiScan.advice.current")}</div>
            <div className="text-[15px] font-semibold text-fg tabular">{t("wifiScan.advice.channel", { n: a.current ?? 0 })}</div>
            {a.loadCurrent !== null && (
              <div className="text-[11px] text-muted">
                <Usage load={a.loadCurrent} />
              </div>
            )}
          </div>
          <ArrowRight className="h-4 w-4 self-center text-faint" aria-hidden />
          <div className="min-w-[130px] flex-1 rounded-lg bg-success/10 px-3 py-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-success)_40%,transparent)]">
            <div className="text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{t("wifiScan.advice.recommended")}</div>
            <div className="text-[15px] font-semibold text-fg tabular">{channelText(a, a.recommended, t)}</div>
            <div className="text-[11px] text-muted">
              <Usage load={a.loadRecommended} /> · {t("wifiScan.advice.width", { n: a.widthMhz })}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-1 text-[13px] text-fg-soft">{t("wifiScan.advice.noConnection", { channel: channelText(a, a.recommended, t) })}</div>
      )}
      {connected && <p className={cn("mt-3 text-[13px] font-medium", fits ? "text-fg-soft" : tone)}>{t(`wifiScan.advice.${fits ? "none" : a.improvement}`)}</p>}
      {a.alternatives.length > 0 && !fits && <p className="mt-1 text-[12px] text-muted">{t("wifiScan.advice.alternatives", { list: a.alternatives.map((c) => channelText(a, c, t)).join(", ") })}</p>}
    </div>
  );
}

export function ChannelAdviceCard({ advice }: { advice: ChannelAdvice[] }) {
  const t = useT();
  if (!advice.length) return null;
  // Hinweise einmal sammeln (gleiche Hinweise mehrerer Bänder nur einmal)
  const notes = [...new Set(advice.flatMap((a) => a.notes))];
  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
        <Router className="h-4 w-4 text-accent" /> {t("wifiScan.advice.title")}
      </div>
      <div className="mt-3 flex flex-col gap-4">
        {advice.map((a) => (
          <AdviceBlock key={a.band} a={a} />
        ))}
      </div>
      {notes.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-line pt-3 text-[12px] leading-relaxed text-fg-soft">
          {notes.map((n) => (
            <li key={n} className="flex gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
              {t(`wifiScan.note.${n}`)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-[12px] leading-relaxed text-muted">{t("wifiScan.advice.howTo")}</p>
    </div>
  );
}
