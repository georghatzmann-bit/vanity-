import { useMemo } from "react";
import { motion } from "motion/react";
import { CalendarDays, FileBarChart2, ListOrdered, ScrollText, Siren, Trash2 } from "lucide-react";
import { gradeColor, pingColor } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { ReportsSection } from "@/lib/types";
import { useBoost } from "@/store/boost";
import { confirmDialog, useUI } from "@/store/ui";
import { ReportDetail } from "@/pages/ReportDetail";
import { ReportCard } from "@/components/ReportCard";
import { CalendarSection } from "@/components/reports/CalendarSection";
import { IspLogSection } from "@/components/reports/IspLogSection";
import { LagSection } from "@/components/reports/LagSection";
import { Tabs } from "@/components/ui/Tabs";
import { BarChart } from "@/components/charts/BarChart";
import { StatTile } from "@/components/net/StatTile";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@shared/ui/Button";
import { staggerContainer, staggerItem } from "@shared/design/motion";

type ListSection = Exclude<ReportsSection, "session">;
const SECTIONS: { value: ListSection; icon: React.ReactNode }[] = [
  { value: "rounds", icon: <ListOrdered className="h-4 w-4" /> },
  { value: "calendar", icon: <CalendarDays className="h-4 w-4" /> },
  { value: "isp", icon: <ScrollText className="h-4 w-4" /> },
  { value: "lag", icon: <Siren className="h-4 w-4" /> },
];

/**
 * Berichte: Runden (Standard), Kalender, Anbieter-Protokoll und Ausreißer (`route.section`); Detail eines
 * Berichts über `route.id` bzw. einer Sitzung über `section: "session"`. Kalender, Protokoll und Ausreißer
 * gibt es auch ohne Berichte.
 */
export function Reports({ id, section }: { id?: string; section?: string }) {
  if (id || section === "session") return <ReportDetail id={id ?? ""} section={section} />;
  const current: ListSection = SECTIONS.some((x) => x.value === section) ? (section as ListSection) : "rounds";
  return <ReportsList section={current} />;
}

function ReportsList({ section }: { section: ListSection }) {
  const t = useT();
  const setSection = (v: ListSection) => useUI.getState().navigate({ page: "reports", section: v });
  return (
    <motion.div className="mx-auto max-w-[1400px] px-8 pt-3 pb-24" variants={staggerContainer(0.04)} initial="initial" animate="enter">
      <motion.div variants={staggerItem} className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">{t("reports.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("reports.subtitle")}</p>
        </div>
        {section === "rounds" && <DeleteAllButton />}
      </motion.div>
      <motion.div variants={staggerItem}>
        <Tabs value={section} onChange={setSection} className="mt-4" tabs={SECTIONS.map((x) => ({ value: x.value, label: <span className="flex items-center gap-2">{x.icon}{t(`reports.section.${x.value}`)}</span> }))} />
      </motion.div>
      <motion.div variants={staggerItem} className="mt-5">
        {section === "rounds" && <Rounds />}
        {section === "calendar" && <CalendarSection />}
        {section === "isp" && <IspLogSection />}
        {section === "lag" && <LagSection />}
      </motion.div>
    </motion.div>
  );
}

function DeleteAllButton() {
  const t = useT();
  const has = useBoost((s) => s.reports.length > 0);
  if (!has) return null;
  return (
    <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={async () => (await confirmDialog({ title: t("reports.deleteAll"), text: t("reports.deleteAllConfirm"), danger: true, confirmLabel: t("reports.deleteAll") })) && void useBoost.getState().deleteAllReports()}>
      {t("reports.deleteAll")}
    </Button>
  );
}

/** Bisherige Ansicht: Übersicht und alle Runden */
function Rounds() {
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
    <motion.div variants={staggerContainer(0.04)} initial="initial" animate="enter">
      <motion.div variants={staggerItem} className="grid grid-cols-3 gap-4 xl:grid-cols-[1fr_1fr_1fr_2fr]">
        <StatTile label={t("reports.totalSessions", { n: reports.length })} value={reports.length} sub={t("reports.overview")} />
        <StatTile label={t("reports.best")} value={summary.best ? `${Math.round(summary.best.avgPing ?? 0)} ms` : "–"} color={summary.best ? gradeColor(summary.best.grade) : undefined} sub={summary.best?.gameName} />
        <StatTile label={t("reports.worst")} value={summary.worst ? `${Math.round(summary.worst.avgPing ?? 0)} ms` : "–"} color={summary.worst ? gradeColor(summary.worst.grade) : undefined} sub={summary.worst?.gameName} />
        <div className="glass col-span-3 rounded-xl px-4 py-3 xl:col-span-1">
          <div className="flex items-center justify-between gap-3 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
            {t("reports.trend")}
            <span className="shrink-0 font-display text-base font-bold tracking-normal whitespace-nowrap normal-case tabular" style={{ color: pingColor(summary.avg) }}>
              Ø {summary.avg === null ? "–" : Math.round(summary.avg)} ms
            </span>
          </div>
          <div className="mt-2">
            <BarChart data={summary.trend} height={54} compact format={(v) => `${v} ms`} />
          </div>
        </div>
      </motion.div>
      <motion.div variants={staggerItem} className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {reports.map((r) => (
          <ReportCard key={r.id} report={r} onDelete={() => undefined} />
        ))}
      </motion.div>
    </motion.div>
  );
}
