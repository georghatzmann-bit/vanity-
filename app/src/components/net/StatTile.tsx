import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@shared/lib/cn";

/** Kennzahl-Kachel: Beschriftung oben, großer Wert, optional Einheit und Farbe */
export function StatTile({ label, value, unit, icon, color, sub, className, size = "md" }: { label: ReactNode; value: ReactNode; unit?: string; icon?: ReactNode; color?: string; sub?: ReactNode; className?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <motion.div className={cn("glass flex flex-col rounded-xl", size === "sm" ? "px-3.5 py-3" : "px-4 py-3.5", className)} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 220, damping: 24 }}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
        {icon && <span className="text-accent">{icon}</span>}
        {label}
      </div>
      <div className={cn("mt-1.5 flex items-baseline gap-1 font-display font-bold text-fg tabular", size === "lg" ? "text-4xl" : size === "sm" ? "text-xl" : "text-2xl")} style={color ? { color } : undefined}>
        {value}
        {unit && <span className="text-[12px] font-medium text-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[12px] text-muted">{sub}</div>}
    </motion.div>
  );
}
