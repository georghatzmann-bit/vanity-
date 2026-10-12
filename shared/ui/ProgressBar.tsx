import { motion } from "motion/react";
import { cn } from "../lib/cn";

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  className?: string;
  height?: number;
  shimmer?: boolean;
  color?: string;
}

/** Sich füllender Balken mit Verlauf und Schimmer */
export function ProgressBar({ value, className, height = 6, shimmer = true, color }: ProgressBarProps) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <div className={cn("relative w-full overflow-hidden rounded-full bg-surface-2", className)} style={{ height }}>
      <motion.div
        className="relative h-full rounded-full"
        style={{ background: color ?? "var(--nv-gradient)", boxShadow: "0 0 12px -2px color-mix(in oklab, var(--nv-accent) 60%, transparent)" }}
        initial={{ width: 0 }}
        animate={{ width: `${v * 100}%` }}
        transition={{ type: "spring", stiffness: 120, damping: 24 }}
      >
        {shimmer && (
          <span
            className="absolute inset-0"
            style={{
              background: "linear-gradient(90deg, transparent, rgb(255 255 255 / 0.35), transparent)",
              backgroundSize: "200% 100%",
              animation: "nv-gradient-pan 1.8s linear infinite",
            }}
          />
        )}
      </motion.div>
    </div>
  );
}
