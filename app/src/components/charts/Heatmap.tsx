import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { dayKey, formatDate, formatDuration } from "@/lib/format";
import { getLanguage, useT } from "@/lib/i18n";

/** Kalender-Heatmap eines Jahres (wie bei GitHub): jedes Kästchen ist ein Tag */
export function Heatmap({ values, year }: { values: Map<string, number>; year: number }) {
  const t = useT();
  const [hover, setHover] = useState<{ key: string; x: number; y: number; v: number; ts: number } | null>(null);
  const { weeks, months, levels } = useMemo(() => {
    const start = new Date(year, 0, 1);
    const offset = (start.getDay() + 6) % 7; // Montag = 0
    const first = new Date(start);
    first.setDate(first.getDate() - offset);
    const weeks: { key: string; ts: number; inYear: boolean }[][] = [];
    const months: { label: string; col: number }[] = [];
    const d = new Date(first);
    let col = 0;
    let lastMonth = -1;
    while (d.getFullYear() <= year && !(d.getFullYear() === year + 1)) {
      const week: { key: string; ts: number; inYear: boolean }[] = [];
      for (let i = 0; i < 7; i++) {
        week.push({ key: dayKey(d.getTime()), ts: d.getTime(), inYear: d.getFullYear() === year });
        if (d.getFullYear() === year && d.getDate() <= 7 && d.getMonth() !== lastMonth && i === 0) {
          lastMonth = d.getMonth();
          months.push({ label: d.toLocaleDateString(getLanguage() === "de" ? "de-DE" : "en-US", { month: "short" }), col });
        }
        d.setDate(d.getDate() + 1);
      }
      weeks.push(week);
      col++;
      if (col > 54) break;
    }
    const vals = [...values.values()].filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] ?? 0;
    return { weeks, months, levels: [q(0.25), q(0.5), q(0.75)] };
  }, [values, year]);

  const level = (v: number) => (v <= 0 ? 0 : v <= levels[0] ? 1 : v <= levels[1] ? 2 : v <= levels[2] ? 3 : 4);
  const colors = ["var(--nv-surface-2)", "color-mix(in oklab, var(--nv-accent) 28%, transparent)", "color-mix(in oklab, var(--nv-accent) 50%, transparent)", "color-mix(in oklab, var(--nv-accent) 75%, transparent)", "var(--nv-accent)"];

  return (
    <div className="relative">
      <div className="relative ml-6 h-4 text-[10px] text-faint">
        {months.map((m) => (
          <span key={m.label + m.col} className="absolute" style={{ left: m.col * 15 }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="flex gap-[3px]">
        <div className="mr-1 flex w-5 flex-col gap-[3px] text-[9px] text-faint">
          {["M", "", "M", "", "F", "", ""].map((l, i) => (
            <div key={i} className="h-3 leading-3">
              {l}
            </div>
          ))}
        </div>
        {weeks.map((w, wi) => (
          <motion.div key={wi} className="flex flex-col gap-[3px]" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: wi * 0.008, duration: 0.3 }}>
            {w.map((d) => {
              const v = values.get(d.key) ?? 0;
              return (
                <div
                  key={d.key}
                  className="h-3 w-3 rounded-[3px] transition-transform hover:scale-125"
                  style={{ background: d.inYear ? colors[level(v)] : "transparent", boxShadow: level(v) === 4 ? "0 0 8px -1px var(--nv-accent)" : undefined }}
                  onMouseEnter={(e) => {
                    if (!d.inYear) return;
                    const r = (e.currentTarget.offsetParent as HTMLElement | null)?.getBoundingClientRect();
                    const c = e.currentTarget.getBoundingClientRect();
                    setHover({ key: d.key, ts: d.ts, v, x: c.left - (r?.left ?? 0), y: c.top - (r?.top ?? 0) });
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })}
          </motion.div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-faint">
        {t("stats.less")}
        {colors.map((c, i) => (
          <span key={i} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />
        ))}
        {t("stats.more")}
      </div>
      {hover && (
        <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-surface-solid px-2.5 py-1.5 text-[11px] whitespace-nowrap shadow-lg ring-1 ring-line" style={{ left: hover.x + 6, top: hover.y + 10 }}>
          <span className="font-semibold text-fg">{hover.v > 0 ? formatDuration(hover.v) : "–"}</span> <span className="text-muted">· {formatDate(hover.ts)}</span>
        </div>
      )}
    </div>
  );
}
