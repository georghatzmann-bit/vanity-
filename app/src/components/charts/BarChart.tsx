import { useState } from "react";
import { motion } from "motion/react";
import { cn } from "@shared/lib/cn";

export interface Bar {
  key: string;
  label: string;
  value: number;
  tooltip?: string;
}

/** Animiertes Säulendiagramm (selbst gezeichnet, ohne Bibliothek) */
export function BarChart({ data, height = 200, format = (v) => String(v), labelEvery = 1, compact, highlight }: { data: Bar[]; height?: number; format?: (v: number) => string; labelEvery?: number; compact?: boolean; highlight?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = niceMax(max);
  const grid = compact ? [] : [0.25, 0.5, 0.75, 1];

  return (
    <div className="relative w-full select-none" style={{ height: height + (compact ? 0 : 26) }}>
      {!compact && (
        <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height }}>
          {grid.map((g) => (
            <div key={g} className="absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `${g * 100}%` }}>
              <span className="absolute -top-2.5 right-0 bg-transparent pl-2 text-[10px] text-faint tabular">{format(nice * g)}</span>
            </div>
          ))}
        </div>
      )}
      <div className={cn("absolute inset-x-0 top-0 flex items-end", compact ? "gap-[3px]" : "gap-[6px] pr-12")} style={{ height }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => {
          const h = (d.value / nice) * 100;
          const active = hover === i || d.key === highlight;
          return (
            <div key={d.key} className="relative flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
              <motion.div
                className="w-full rounded-t-[5px]"
                style={{
                  background: active ? "var(--nv-gradient)" : "linear-gradient(to top, color-mix(in oklab, var(--nv-accent) 35%, transparent), color-mix(in oklab, var(--nv-accent) 75%, transparent))",
                  boxShadow: active ? "0 0 18px -2px color-mix(in oklab, var(--nv-accent) 70%, transparent)" : undefined,
                  minHeight: d.value > 0 ? 3 : 0,
                }}
                initial={{ height: 0 }}
                animate={{ height: `${h}%` }}
                transition={{ type: "spring", stiffness: 90, damping: 16, delay: i * (compact ? 0.008 : 0.02) }}
              />
              {hover === i && (
                <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-10 -translate-x-1/2 rounded-md bg-surface-solid px-2.5 py-1.5 text-center text-[11px] whitespace-nowrap shadow-lg ring-1 ring-line" style={{ bottom: `calc(${h}% + 8px)` }}>
                  <div className="font-semibold text-fg">{format(d.value)}</div>
                  <div className="text-muted">{d.tooltip ?? d.label}</div>
                </motion.div>
              )}
            </div>
          );
        })}
      </div>
      {!compact && (
        <div className="absolute inset-x-0 bottom-0 flex gap-[6px] pr-12">
          {data.map((d, i) => (
            <div key={d.key} className="flex flex-1 justify-center overflow-visible text-[10px] whitespace-nowrap text-faint">
              {i % labelEvery === 0 ? d.label : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return n * exp;
}
