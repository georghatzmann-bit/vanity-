import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";

/** Ein Fach der Heatmap */
export interface HeatCell {
  /** CSS-Farbe (z. B. `gradeColor(..)`); `null` = keine Messung */
  color: string | null;
  /** `full` = bewertet, `thin` = wenig Daten (blass, schraffiert), `empty` = keine Messung */
  state: "full" | "thin" | "empty";
  /** Vorgelesener Text (Bildschirmleser) */
  label: string;
  /** Hervorheben (z. B. ruhigster Block) */
  highlight?: boolean;
}

/** Schraffur für „wenig Daten“ (auch in der Legende benutzt) */
export function thinBackground(color: string): string {
  return `repeating-linear-gradient(135deg, color-mix(in oklab, ${color} 34%, transparent) 0 3px, color-mix(in oklab, ${color} 10%, transparent) 3px 6px)`;
}

/**
 * Heatmap Zeilen × Spalten (Pulsar-Kalender: 7 Wochentage × 24 Stunden). Fächer mindestens 18 px,
 * passt bei 960 px Fensterbreite. Tooltip beim Überfahren und bei Tastatur-Fokus.
 */
export function Heatmap({ cells, rowLabels, colLabels, tooltip, label, className }: { cells: HeatCell[]; rowLabels: string[]; colLabels: (string | null)[]; tooltip: (index: number) => ReactNode; label: string; className?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const cols = colLabels.length;
  return (
    <div className={cn("w-full select-none", className)} role="group" aria-label={label} onMouseLeave={() => setHover(null)}>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `2.25rem repeat(${cols}, minmax(18px, 1fr))` }}>
        <div />
        {colLabels.map((l, c) => (
          <div key={c} className="pb-1 text-center text-[10px] leading-none text-faint tabular">
            {l ?? ""}
          </div>
        ))}
        {rowLabels.map((rl, r) => (
          <Row key={rl + r} label={rl}>
            {colLabels.map((_, c) => {
              const i = r * cols + c;
              const cell = cells[i];
              if (!cell) return <div key={c} />;
              const active = hover === i;
              // Tooltip an den Rändern nach innen klappen
              const side = r < 2 ? "below" : "above";
              const align = c < 4 ? "left" : c > cols - 5 ? "right" : "center";
              return (
                <div
                  key={c}
                  tabIndex={0}
                  aria-label={cell.label}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((h) => (h === i ? null : h))}
                  className={cn(
                    "relative h-[22px] min-w-[18px] rounded-[4px] outline-none transition-[transform,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-accent",
                    cell.state === "empty" && "border border-dashed border-line",
                    active && "z-10 scale-[1.18] shadow-lg",
                    cell.highlight && "ring-2 ring-fg/70",
                  )}
                  style={
                    cell.state === "full" && cell.color
                      ? { background: `color-mix(in oklab, ${cell.color} 82%, transparent)` }
                      : cell.state === "thin" && cell.color
                        ? { background: thinBackground(cell.color) }
                        : undefined
                  }
                >
                  <AnimatePresence>
                    {active && (
                      <motion.div
                        className={cn(
                          "pointer-events-none absolute z-50 w-max max-w-[240px] rounded-lg bg-surface-solid px-3 py-2 text-left text-[12px] text-fg shadow-xl ring-1 ring-line",
                          side === "above" ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]",
                          align === "left" ? "left-0" : align === "right" ? "right-0" : "left-1/2 -translate-x-1/2",
                        )}
                        initial={{ opacity: 0, y: side === "above" ? 4 : -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={spring.snappy}
                      >
                        {tooltip(i)}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </Row>
        ))}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="flex items-center pr-1 text-[11px] font-semibold text-muted">
        {label}
      </div>
      {children}
    </>
  );
}
