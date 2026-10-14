/**
 * Berichte › Ausreißer (`section: "lag"`): Ursachen aller untersuchten Ausreißer der letzten 30 Tage
 * aus `net_events_summary` (Summe von `countSum` je `cause`), mit der Gesamtzahl und je Ursache einem
 * Balken. Alles als Einschätzung gekennzeichnet; die Seite funktioniert auch ohne Berichte.
 */
import { useEffect, useMemo, useState } from "react";
import { Info, RefreshCw, Siren } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { CAUSE_ICONS, CAUSE_TONE, capitalizeFirst, causeLabel, causeNote, countsFromSummary } from "@/lib/lag";
import { backendText } from "@/lib/netauto";
import { LAG_CAUSES, type LagCause } from "@/lib/types";
import { Button } from "@shared/ui/Button";

const DAY_MS = 24 * 3_600_000;
/** Zeitraum des Abschnitts */
export const LAG_SECTION_DAYS = 30;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; counts: Partial<Record<LagCause, number>> };

export function LagSection() {
  const t = useT();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const to = Date.now();
    setLoad({ state: "loading" });
    api
      .eventsSummary(to - LAG_SECTION_DAYS * DAY_MS, to)
      .then((rows) => alive && setLoad({ state: "ok", counts: countsFromSummary(rows) }))
      .catch((e: unknown) => alive && setLoad({ state: "error", message: backendText(errorText(e), t) }));
    return () => {
      alive = false;
    };
  }, [nonce, t]);

  // Summe aller untersuchten Ausreißer
  const total = load.state === "ok" ? LAG_CAUSES.reduce((a, c) => a + (load.counts[c] ?? 0), 0) : 0;
  const bars = useMemo(() => {
    if (load.state !== "ok") return [];
    return LAG_CAUSES.map((c, i) => ({ cause: c, n: load.counts[c] ?? 0, i }))
      .filter((x) => x.n > 0)
      // „unklar“ immer zuletzt, sonst nach Anzahl
      .sort((a, b) => Number(a.cause === "unknown") - Number(b.cause === "unknown") || b.n - a.n || a.i - b.i)
      .map((x) => ({ ...x, share: total > 0 ? x.n / total : 0 }));
  }, [load, total]);

  return (
    <section className="glass rounded-xl p-5" data-testid="lag-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-accent">
            <Siren className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-fg">{t("lag.section.title")}</h2>
            <p className="text-[12px] text-muted">{t("lag.section.intro")}</p>
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setNonce((n) => n + 1)} disabled={load.state === "loading"}>
          {t("common.refresh")}
        </Button>
      </div>

      {load.state === "loading" && <div className="mt-5 h-24 animate-pulse rounded-lg bg-surface" />}
      {load.state === "error" && <div className="mt-5 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{t("lag.section.error", { error: load.message })}</div>}
      {load.state === "ok" && bars.length === 0 && <div className="mt-5 rounded-lg bg-surface px-4 py-5 text-[13px] text-muted">{t("lag.section.empty")}</div>}
      {load.state === "ok" && bars.length > 0 && (
        <>
          {/* nur die Summe – die Ursachen stehen darunter als Balken */}
          <div className="mt-5 text-[13px] font-medium text-fg-soft tabular">{total === 1 ? t("lag.summary.headOne") : t("lag.summary.head", { n: total })}</div>
          <div className="mt-4 flex flex-col gap-3">
            {bars.map((b) => {
              const Icon = CAUSE_ICONS[b.cause];
              const note = causeNote(b.cause, t);
              return (
                <div key={b.cause} className="flex items-center gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-3" style={{ color: CAUSE_TONE[b.cause] }}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[13px] font-medium text-fg">{b.cause === "unknown" ? t("lag.unclearCause") : capitalizeFirst(t("lag.likely", { cause: causeLabel(b.cause, null, t) }))}</span>
                      <span className="shrink-0 text-[13px] font-semibold text-fg tabular">
                        {t("lag.section.share", { n: b.n })} <span className="font-normal text-muted">· {Math.round(b.share * 100)} %</span>
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(2, b.share * 100)}%`, background: CAUSE_TONE[b.cause] }} />
                    </div>
                    {note && <div className="mt-1 text-[11px] text-muted">{note}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <p className="mt-5 flex gap-2 text-[11px] leading-relaxed text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("lag.section.honest")}
      </p>
    </section>
  );
}
