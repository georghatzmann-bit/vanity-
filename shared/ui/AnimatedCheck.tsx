import { motion } from "motion/react";
import { cn } from "../lib/cn";

/** Kreis + Häkchen, die sich nacheinander zeichnen (Erfolg) */
export function AnimatedCheck({ size = 64, className, delay = 0 }: { size?: number; className?: string; delay?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cn("overflow-visible", className)} fill="none">
      <defs>
        <linearGradient id="nv-check-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--nv-accent-2)" />
          <stop offset="0.5" stopColor="var(--nv-accent)" />
          <stop offset="1" stopColor="var(--nv-accent-3)" />
        </linearGradient>
      </defs>
      <motion.circle
        cx="32"
        cy="32"
        r="28"
        stroke="url(#nv-check-grad)"
        strokeWidth="4"
        strokeLinecap="round"
        initial={{ pathLength: 0, rotate: -90, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        style={{ transformOrigin: "center" }}
        transition={{ duration: 0.6, delay, ease: [0.65, 0, 0.35, 1] }}
      />
      <motion.path
        d="M20 33 L28.5 41 L45 24"
        stroke="url(#nv-check-grad)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.4, delay: delay + 0.5, ease: [0.22, 1, 0.36, 1] }}
      />
    </svg>
  );
}
