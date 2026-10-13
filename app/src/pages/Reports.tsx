import { useMemo } from "react";
import { motion } from "motion/react";
import { FileBarChart2, Trash2 } from "lucide-react";
import { gradeColor, pingColor } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import { useBoost } from "@/store/boost";
import { confirmDialog } from "@/store/ui";
import { ReportCard } from "@/components/ReportCard";
import { BarChart } from "@/components/charts/BarChart";
import { StatTile } from "@/components/net/StatTile";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@shared/ui/Button";
import { staggerContainer, staggerItem } from "@shared/design/motion";

/** Berichte aller Spielsitzungen */
export function Reports() {
  const t = useT();
  const reports = useBoost((s) => s.reports);
  const summary = useMemo(() => {
    const withPing = reports.filter((r) => r.avgPing !== null);
    const avg = withPing.length ? withPing.reduce((a, r) => a + (r.avgPing ?? 0), 0) / withPing.length : null;
    const best = [...withPing].sort((a, b) => (a.avgPing ?? 0) - (b.avgPing ?? 0))[0];
    const worst = [...withPing].sort((a, b) => (b.avgPing ?? 0) - (a.avgPing ?? 0))[0];
    const trend = [...reports]
      .slice(0, 20)
      .reverse()
      .map((r) => ({ key: r.id, label: "", value: Math.round(r.avgPing ?? 0), tooltip: r.gameName }));
    return { avg, best, worst, trend };
  }, [reports]);

  if (!reports.length) return <EmptyState icon={<FileBarChart2 className="h-7 w-7" />} title={t("reports.empty")} text={t("reports.emptyText")} />;

  return (
    <motion.div className="mx-auto max-w-[1400px] px-8 pt-3 pb-24" variants={staggerContainer(0.04)} initial="initial" animate="enter">
      <motion.div variants={staggerItem} className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">{t("reports.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("reports.subtitle")}</p>
        </div>
        <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={async () => (await confirmDialog({ title: t("reports.deleteAll"), text: t("reports.deleteAllConfirm"), danger: true, confirmLabel: t("reports.deleteAll") })) && void useBoost.getState().deleteAllReports()}>
          {t("reports.deleteAll")}
        </Button>
      </motion.div>
      <motion.div variants={staggerItem} className="mt-5 grid grid-cols-[1fr_1fr_1fr_2fr] gap-4">
        <StatTile label={t("reports.totalSessions", { n: reports.length })} value={reports.length} sub={t("reports.overview")} />
        <StatTile label={t("reports.best")} value={summary.best ? `${Math.round(summary.best.avgPing ?? 0)} ms` : "–"} color={summary.best ? gradeColor(summary.best.grade) : undefined} sub={summary.best?.gameName} />
        <StatTile label={t("reports.worst")} value={summary.worst ? `${Math.round(summary.worst.avgPing ?? 0)} ms` : "–"} color={summary.worst ? gradeColor(summary.worst.grade) : undefined} sub={summary.worst?.gameName} />
        <div className="glass rounded-xl px-4 py-3">
          <div className="flex items-center justify-between text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
            {t("reports.trend")}
            <span className="font-display text-base font-bold tabular" style={{ color: pingColor(summary.avg) }}>
              Ø {summary.avg === null ? "–" : Math.round(summary.avg)} ms
            </span>
          </div>
          <div className="mt-2">
            <BarChart data={summary.trend} height={54} compact format={(v) => `${v} ms`} />
          </div>
        </div>
      </motion.div>
      <motion.div variants={staggerItem} className="mt-6 grid grid-cols-2 gap-4 2xl:grid-cols-3">
        {reports.map((r) => (
          <ReportCard key={r.id} report={r} onDelete={() => undefined} />
        ))}
      </motion.div>
    </motion.div>
  );
}
