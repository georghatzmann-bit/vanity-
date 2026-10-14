import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowLeft, ChartSpline, Info, Layers } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { backendText } from "@/lib/netauto";
import { headerModel, reportFromTimeline } from "@/lib/timeline";
import type { SessionReport, SessionTimeline } from "@/lib/types";
import { useBoost } from "@/store/boost";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { Timeline } from "@/components/reports/Timeline";
import { TimelineHeader } from "@/components/reports/TimelineHeader";
import { MatchCardPreview } from "@/components/reports/MatchCardPreview";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@shared/ui/Button";
import { staggerContainer, staggerItem } from "@shared/design/motion";

/** Fester Backend-Satz „keine Messwerte“ – dann gibt es nur die verdichtete Kurve des Berichts */
const NO_SAMPLES = "Für diese Sitzung gibt es keine Messwerte.";

type Load = { state: "idle" } | { state: "loading" } | { state: "ok"; timeline: SessionTimeline } | { state: "none" } | { state: "error"; message: string };

/**
 * Detail eines Berichts bzw. einer Sitzung: Match-Zeitleiste und Bildkarte. Aufruf über
 * `{ page: "reports", id: report.id }` oder `{ page: "reports", section: "session", id: <sessionId> }`
 * (auch Sitzungen ohne Bericht – dann kommt der Kopf aus den Messwerten). Vertrag: docs/API.md,
 * „Match-Zeitleiste“.
 */
export function ReportDetail({ id, section }: { id: string; section?: string }) {
  const t = useT();
  const reports = useBoost((s) => s.reports);
  const games = useLibrary((s) => s.games);
  const bySession = section === "session";
  const sessionId = bySession ? Number(id) : undefined;
  const report = useMemo<SessionReport | null>(
    () => (bySession ? (reports.find((r) => r.sessionId === sessionId) ?? null) : (reports.find((r) => r.id === id) ?? null)),
    [bySession, reports, sessionId, id],
  );
  const sid = bySession ? (Number.isFinite(sessionId) ? sessionId : undefined) : report?.sessionId;
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (sid === undefined) {
      setLoad({ state: "none" });
      return;
    }
    let alive = true;
    setLoad({ state: "loading" });
    api
      .sessionTimeline(sid)
      .then((timeline) => alive && setLoad({ state: "ok", timeline }))
      .catch((e) => {
        if (!alive) return;
        const msg = errorText(e);
        setLoad(msg === NO_SAMPLES ? { state: "none" } : { state: "error", message: msg });
      });
    return () => {
      alive = false;
    };
  }, [sid]);

  const timeline = load.state === "ok" ? load.timeline : null;
  const gameId = report?.gameId ?? timeline?.gameId ?? null;
  const game = useMemo(() => (gameId ? (games.find((g) => g.id === gameId) ?? null) : null), [games, gameId]);
  // Sitzung ohne Bericht: Kopf aus den Messwerten
  const shown = useMemo(() => report ?? (timeline ? reportFromTimeline(timeline, game?.name ?? timeline.gameId) : null), [report, timeline, game]);
  const header = useMemo(() => (shown ? headerModel(shown, timeline) : null), [shown, timeline]);
  const back = () => useUI.getState().navigate(bySession && gameId ? { page: "game", id: gameId, section: "reports" } : { page: "reports" });

  const loading = load.state === "loading" || load.state === "idle";

  return (
    <motion.div className="mx-auto max-w-[1400px] px-8 pt-3 pb-24" data-report-id={id} data-section={section ?? "report"} variants={staggerContainer(0.05)} initial="initial" animate="enter">
      <motion.div variants={staggerItem}>
        <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={back}>
          {t("common.back")}
        </Button>
      </motion.div>

      {!shown && !loading && (
        <motion.div variants={staggerItem} className="mt-4">
          <EmptyState
            icon={<ChartSpline className="h-7 w-7" />}
            title={bySession ? backendText(load.state === "error" ? load.message : NO_SAMPLES, t) : t("timeline.notFound")}
            text={t("timeline.onlyCompressedWhy")}
          />
        </motion.div>
      )}

      {!shown && loading && (
        <motion.div variants={staggerItem} className="glass mt-4 grid h-64 place-items-center rounded-xl text-sm text-muted">
          {t("timeline.loading")}
        </motion.div>
      )}

      {shown && header && (
        <>
          <motion.div variants={staggerItem} className="mt-3">
            <TimelineHeader header={header} game={game ?? undefined} onSaveImage={() => setPreview(true)} sessionOnly={!report} />
          </motion.div>

          <motion.div variants={staggerItem} className="mt-4 flex flex-col gap-2">
            <div className="flex items-start gap-2 text-[12px] text-muted">
              <Info className="mt-px h-3.5 w-3.5 shrink-0" /> <span>{t("timeline.honest")}</span>
            </div>
            {timeline && timeline.merged > 1 && (
              <div className="flex items-center gap-2 text-[12px] text-muted">
                <Layers className="h-3.5 w-3.5 shrink-0" /> {t("timeline.merged", { n: timeline.merged })}
              </div>
            )}
            {load.state === "error" && <div className="rounded-lg border border-[color-mix(in_oklab,var(--nv-danger)_40%,transparent)] px-3 py-2 text-[12px] text-danger">{backendText(load.message, t)}</div>}
          </motion.div>

          <motion.div variants={staggerItem} className="mt-3">
            {loading ? (
              <div className="glass grid h-72 place-items-center rounded-xl text-sm text-muted">{t("timeline.loading")}</div>
            ) : timeline ? (
              <Timeline timeline={timeline} start={timeline.start} end={timeline.end} />
            ) : (
              <>
                <div className="mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] text-fg-soft">
                  <span className="font-semibold text-fg">{t("timeline.onlyCompressed")}</span> <span className="text-muted">{t("timeline.onlyCompressedWhy")}</span>
                </div>
                <Timeline timeline={null} fallback={shown.timeline} start={shown.start} end={shown.end} />
              </>
            )}
          </motion.div>

          <MatchCardPreview open={preview} onClose={() => setPreview(false)} report={shown} timeline={timeline} game={game} />
        </>
      )}
    </motion.div>
  );
}
