import { motion } from "motion/react";
import type { ReactNode } from "react";

/** Fortschrittsring (füllt sich animiert) */
export function Ring({ value, size = 64, stroke = 6, color, track = "var(--nv-surface-3)", children }: { value: number; size?: number; stroke?: number; color?: string; track?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const gid = `ring-${Math.round(size)}-${Math.round(stroke)}`;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--nv-accent-2)" />
            <stop offset="0.5" stopColor="var(--nv-accent)" />
            <stop offset="1" stopColor="var(--nv-accent-3)" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color ?? `url(#${gid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - v) }}
          transition={{ type: "spring", stiffness: 60, damping: 18 }}
          style={{ filter: "drop-shadow(0 0 6px color-mix(in oklab, var(--nv-accent) 45%, transparent))" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}
