import { motion } from "motion/react";
import { Trash2, Zap } from "lucide-react";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format";
import { gradeColor, pingColor } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { SessionReport } from "@/lib/types";
import { useBoost } from "@/store/boost";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { GameCover } from "./GameCover";
import { PingChart } from "./net/PingChart";
import { cn } from "@shared/lib/cn";

/** Bericht einer Spielsitzung: Note, Kennzahlen, Ping-Verlauf */
export function ReportCard({ report, compact = false, onDelete }: { report: SessionReport; compact?: boolean; onDelete?: () => void }) {
  const t = useT();
  const game = useLibrary((s) => (report.gameId ? s.games.find((g) => g.id === report.gameId) : undefined));
  const color = gradeColor(report.grade);
  const points = report.timeline.map(([tt, rtt]) => ({ t: tt, rtt }));
  /** Klick auf die Karte öffnet die Match-Zeitleiste */
  const open = () => useUI.getState().navigate({ page: "reports", id: report.id });
  return (
    <motion.div
      layout
      role="link"
      tabIndex={0}
      title={t("timeline.open")}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={cn("glass group relative cursor-pointer overflow-hidden rounded-xl transition-shadow outline-none hover:shadow-[0_0_0_1px_var(--nv-border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--nv-accent)]", compact ? "p-3" : "p-4")}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="flex items-center gap-3">
        {game && !compact && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              useUI.getState().navigate({ page: "game", id: game.id });
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="h-14 w-10 shrink-0 overflow-hidden rounded-md"
          >
            <GameCover game={game} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {!compact && <span className="truncate text-sm font-semibold text-fg">{report.gameName}</span>}
            {report.boosted && (
              <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
                <Zap className="h-3 w-3" fill="currentColor" /> {t("reports.boosted")}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted">
            {formatDateTime(report.start)} · {formatDuration(Math.round((report.end - report.start) / 1000), { short: true })} · {t("reports.target", { target: report.targetLabel })}
          </div>
        </div>
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full font-display text-lg font-bold" style={{ color, boxShadow: `inset 0 0 0 3px ${color}`, background: `color-mix(in oklab, ${color} 12%, transparent)` }}>
          {report.grade}
        </div>
      </div>
      <PingChart points={points} height={compact ? 70 : 90} compact className="mt-3" />
      <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
        {[
          [t("reports.avgPing"), report.avgPing === null ? "–" : `${Math.round(report.avgPing)} ms`, pingColor(report.avgPing)],
          [t("cockpit.max"), report.maxPing === null ? "–" : `${Math.round(report.maxPing)} ms`, undefined],
          [t("reports.spikes"), String(report.spikes), report.spikes > 10 ? "var(--nv-warning)" : undefined],
          [t("reports.loss"), `${formatNumber(report.loss * 100, 1)} %`, report.loss > 0.01 ? "var(--nv-danger)" : undefined],
        ].map(([l, v, c]) => (
          <div key={l} className="rounded-md bg-surface px-2 py-1.5">
            <div className="text-[9px] font-semibold tracking-[0.12em] text-faint uppercase">{l}</div>
            <div className="font-display text-[13px] font-bold text-fg tabular" style={c ? { color: c } : undefined}>
              {v}
            </div>
          </div>
        ))}
      </div>
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
            void useBoost.getState().deleteReport(report.id);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="absolute top-3 right-3 grid h-7 w-7 place-items-center rounded-md bg-surface-2 text-faint opacity-0 transition group-hover:opacity-100 hover:text-danger" title={t("reports.delete")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </motion.div>
  );
}
