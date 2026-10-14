/**
 * Netzwerk › „Warum laggt es?“: geführte Prüfung (Verbindung, Router, Server, Route, Datenverkehr,
 * Speedtest) mit regelbasierter Einschätzung und konkreten Schritten. Vertrag: docs/API.md,
 * „„Warum laggt es?““. Pulsar ändert dabei nichts an Windows oder am Router.
 */
import { useEffect, useMemo } from "react";
import { Gauge, Play, RotateCcw, Stethoscope, X } from "lucide-react";
import { primaryAdapter, speedtestBudgetMb } from "@/lib/diagnose";
import { useT } from "@/lib/i18n";
import type { DiagnoseStepId } from "@/lib/types";
import { useDiagnose, type LiveStep } from "@/store/diagnose";
import { useNet } from "@/store/net";
import { useSettings } from "@/store/settings";
import { FindingList, fmt } from "@/components/net/diagnose/FindingList";
import { StepList } from "@/components/net/diagnose/StepList";
import { VerdictCard } from "@/components/net/diagnose/VerdictCard";
import { Button } from "@shared/ui/Button";
import { Toggle } from "@shared/ui/Toggle";
import { cn } from "@shared/lib/cn";

export function DiagnosePanel() {
  const t = useT();
  const { phase, steps, speedProgress, traceHops, input, serverLive, result, last, withSpeedtest, metered, cancelled, init, start, cancel, setWithSpeedtest } = useDiagnose();
  const adapters = useNet((s) => s.adapters);
  const ispLog = useSettings((s) => s.settings.ispLog);

  useEffect(() => {
    void init();
    // Verbindungsgeschwindigkeit des Adapters für die Verbrauchsangabe
    if (!useNet.getState().adapters.length) void useNet.getState().refreshConnection();
  }, [init]);

  const busy = phase !== "idle";
  const shown = result ?? last;
  const fromLast = !result && !!last;
  const ran = busy || !!input;
  // Schritte der letzten gespeicherten Prüfung (nur Zustand und Fehler, keine Messwerte)
  const lastSteps = useMemo(
    () => (last ? (Object.fromEntries(last.steps.map((st) => [st.id, { status: st.status, ...(st.error ? { error: st.error } : {}) }])) as Record<DiagnoseStepId, LiveStep>) : null),
    [last],
  );
  // Während einer neuen Prüfung kein altes Ergebnis zeigen
  const showVerdict = !!shown && !(busy && fromLast);
  const others = useMemo(() => (shown ? shown.findings.filter((f) => f.id !== shown.verdict) : []), [shown]);
  const budget = speedtestBudgetMb({ down: ispLog?.contractDownMbps ?? null, up: ispLog?.contractUpMbps ?? null }, primaryAdapter(adapters)?.speedMbps ?? null);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
      <div className="glass rounded-xl p-5">
        <div className="flex items-start gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
            <Stethoscope className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-fg">{t("diagnose.title")}</div>
            <p className="mt-1 max-w-[760px] text-[13px] leading-relaxed text-muted">{t("diagnose.intro")}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
            <label className="flex items-center gap-2.5">
              <Toggle checked={withSpeedtest} onChange={setWithSpeedtest} disabled={busy} size="sm" label={t("diagnose.withSpeedtest")} />
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                <Gauge className="h-4 w-4 text-accent" /> {t("diagnose.withSpeedtest")}
              </span>
            </label>
            <span className="text-[12px] text-muted">{t("diagnose.speedtestUsage", { mb: fmt(budget, 0) })}</span>
            {metered === true && <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-[11px] font-medium text-warning">{t("diagnose.metered")}</span>}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-faint">{t("diagnose.duration")}</span>
            {busy ? (
              <Button variant="secondary" icon={<X className="h-4 w-4" />} loading={phase === "cancelling"} onClick={() => void cancel()} data-testid="diagnose-cancel">
                {phase === "cancelling" ? t("diagnose.cancelling") : t("diagnose.cancel")}
              </Button>
            ) : (
              <Button variant="primary" icon={shown ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4" />} onClick={() => void start()} data-testid="diagnose-start">
                {shown ? t("diagnose.again") : t("diagnose.start")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {cancelled && !busy && <div className="rounded-xl bg-surface-2 px-4 py-3 text-[13px] text-fg-soft">{t("diagnose.cancelled")}</div>}

      <div className={cn("grid grid-cols-1 items-start gap-5", showVerdict && "xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]")}>
        {ran ? (
          <StepList steps={steps} input={input} speed={speedProgress} hops={traceHops} serverLive={serverLive} showProgress={busy} />
        ) : lastSteps ? (
          <StepList steps={lastSteps} input={null} speed={null} hops={[]} serverLive={false} showProgress={false} />
        ) : (
          <div className="glass rounded-xl p-5">
            <div className="text-[15px] font-semibold text-fg">{t("diagnose.emptyTitle")}</div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{t("diagnose.emptyText")}</p>
          </div>
        )}
        {showVerdict && shown && <VerdictCard result={shown} fromLast={fromLast} />}
      </div>

      {showVerdict && shown && <FindingList findings={others} />}

      <p className="text-[11px] leading-relaxed text-faint">{t("diagnose.honest")}</p>
    </div>
  );
}
