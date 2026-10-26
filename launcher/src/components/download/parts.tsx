import type { ReactNode } from "react";
import { motion } from "motion/react";
import { coverGradient } from "@/lib/builds";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Chapter-coloured tile with the version number (same look as the build picker in Profiles). */
export function VersionTile({ version, size = "md", className }: { version: string; size?: "sm" | "md" | "lg"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br font-semibold text-white tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] ring-1 ring-white/10",
        size === "sm" && "h-8 w-12 rounded-md text-[11px]",
        size === "md" && "h-11 w-16 rounded-lg text-sm",
        size === "lg" && "h-16 w-24 rounded-xl text-lg",
        coverGradient(version),
        className,
      )}
    >
      <span
        className="absolute inset-0 opacity-[0.14]"
        style={{ backgroundImage: "repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 12px)" }}
      />
      <span className="relative">{version}</span>
    </span>
  );
}

/** Round progress for tight spots (narrow sidebar). value 0 … 1. */
export function ProgressRing({
  value,
  size = 36,
  stroke = 3,
  tone = "brand",
  spin = false,
  children,
  className,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: "brand" | "success" | "warning" | "danger" | "muted";
  /** Turning arc while the value is unknown. */
  spin?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const color = {
    brand: "url(#nb-ring-gradient)",
    success: "var(--success)",
    warning: "var(--warning)",
    danger: "var(--destructive)",
    muted: "var(--nb-text-faint)",
  }[tone];
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("absolute inset-0 -rotate-90", spin && "nb-loop animate-spin-slow")} aria-hidden>
        <defs>
          <linearGradient id="nb-ring-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2b5bff" />
            <stop offset="60%" stopColor="#7a3cff" />
            <stop offset="100%" stopColor="#ffc857" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - (spin ? 0.25 : v)) }}
          transition={{ duration: 0.6, ease: EASE_OUT }}
        />
      </svg>
      <span className="relative flex items-center justify-center">{children}</span>
    </span>
  );
}
