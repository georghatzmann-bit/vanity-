/**
 * Steckplatz im Cockpit (Live-Ping-Karte): letzter Ausreißer der letzten 60 s mit eingeschätzter
 * Ursache („182 ms · vermutlich WLAN“, Zusatz „Einschätzung“). Mit `cpuHigh` zusätzlich der
 * Hinweis, dass der PC ausgelastet ist. Klick → Netzwerk › Verbindung (Karte „Lag-Detektiv“).
 */
import { useEffect } from "react";
import { Cpu } from "lucide-react";
import { CAUSE_ICONS, CAUSE_TONE, causeLine, latestRecent } from "@/lib/lag";
import { useT } from "@/lib/i18n";
import { useNow } from "@/hooks/useNow";
import { useLag } from "@/store/lag";
import { useUI } from "@/store/ui";

export function LagBadge() {
  const t = useT();
  const events = useLag((s) => s.events);
  const now = useNow(1000);
  useEffect(() => {
    void useLag.getState().init();
  }, []);
  const ev = latestRecent(events, now);
  if (!ev) return null;
  const Icon = CAUSE_ICONS[ev.cause];
  const cause = causeLine(ev.cause, ev.targetKind, t);
  const title = [t("lag.badge.title"), ev.cpuHigh ? t("lag.cpuHigh") : null].filter(Boolean).join("\n");
  return (
    <button
      type="button"
      onClick={() => useUI.getState().navigate({ page: "network", section: "connection" })}
      title={`${t("lag.badge.text", { ms: Math.round(ev.rtt), cause })} (${t("lag.estimate")})\n${title}`}
      aria-label={`${t("lag.badge.text", { ms: Math.round(ev.rtt), cause })} – ${t("lag.estimate")}`}
      data-testid="lag-badge"
      className="flex max-w-[260px] min-w-0 items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <Icon className="h-4 w-4 shrink-0" style={{ color: CAUSE_TONE[ev.cause] }} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-fg tabular">
          {Math.round(ev.rtt)} ms
          <span className="rounded-full bg-surface-3 px-1.5 py-px text-[9px] font-semibold tracking-[0.08em] text-muted uppercase">{t("lag.estimate")}</span>
        </span>
        <span className="line-clamp-2 text-[11px] text-fg-soft">{cause}</span>
        {ev.cpuHigh && (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <Cpu className="h-3 w-3 shrink-0" />
            <span className="truncate">{t("lag.cpuHighShort")}</span>
          </span>
        )}
      </span>
    </button>
  );
}
