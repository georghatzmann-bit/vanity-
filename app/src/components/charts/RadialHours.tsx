import { useState } from "react";
import { motion } from "motion/react";
import { formatDuration } from "@/lib/format";

/** "Wann spielst du?" - 24 Stunden als leuchtende Uhr */
export function RadialHours({ hours, size = 260 }: { hours: number[]; size?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...hours);
  const cx = size / 2;
  const inner = size * 0.24;
  const outer = size * 0.47;
  const peak = hours.indexOf(Math.max(...hours));
  const seg = (Math.PI * 2) / 24;

  const arc = (i: number, r1: number, r2: number) => {
    const a0 = i * seg - Math.PI / 2 + 0.03;
    const a1 = (i + 1) * seg - Math.PI / 2 - 0.03;
    const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cx + r * Math.sin(a)}`;
    return `M ${p(r1, a0)} L ${p(r2, a0)} A ${r2} ${r2} 0 0 1 ${p(r2, a1)} L ${p(r1, a1)} A ${r1} ${r1} 0 0 0 ${p(r1, a0)} Z`;
  };

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <defs>
          <radialGradient id="rh-grad" cx="50%" cy="50%" r="50%">
            <stop offset="40%" stopColor="var(--nv-accent-3)" />
            <stop offset="75%" stopColor="var(--nv-accent)" />
            <stop offset="100%" stopColor="var(--nv-accent-2)" />
          </radialGradient>
        </defs>
        {hours.map((_, i) => (
          <path key={`bg${i}`} d={arc(i, inner, outer)} fill="var(--nv-surface-2)" />
        ))}
        {hours.map((v, i) => {
          const r = inner + (outer - inner) * (v / max);
          return (
            <motion.path
              key={i}
              d={arc(i, inner, Math.max(inner + 1, r))}
              fill="url(#rh-grad)"
              opacity={hover === null || hover === i ? 1 : 0.45}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: hover === null || hover === i ? 1 : 0.45 }}
              style={{ transformOrigin: `${cx}px ${cx}px`, filter: i === peak ? "drop-shadow(0 0 8px var(--nv-accent))" : undefined }}
              transition={{ type: "spring", stiffness: 120, damping: 16, delay: i * 0.025 }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        {[0, 6, 12, 18].map((h) => {
          const a = h * seg - Math.PI / 2;
          return (
            <text key={h} x={cx + (inner - 14) * Math.cos(a)} y={cx + (inner - 14) * Math.sin(a) + 4} textAnchor="middle" className="fill-[var(--nv-faint)] text-[10px]">
              {h}
            </text>
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="font-display text-2xl font-bold text-fg tabular">{String(hover ?? peak).padStart(2, "0")}:00</div>
          <div className="text-[11px] text-muted">{formatDuration(hours[hover ?? peak] ?? 0, { short: true })}</div>
        </div>
      </div>
    </div>
  );
}
