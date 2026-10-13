import { useId } from "react";
import { motion } from "motion/react";
import { gradeColor, gradeValue } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { Grade } from "@/lib/types";

/**
 * Große Verbindungsnote als leuchtender Ring mit Puls.
 * Das Leuchten ist ein unscharfer SVG-Kreis (kein CSS-Filter) – ein CSS-Filter auf Glasflächen
 * zeichnet in Chromium sonst ein dunkles Viereck hinter den Ring.
 */
export function GradeRing({ grade, size = 168, live = false, label }: { grade: Grade | null; size?: number; live?: boolean; label?: string }) {
  const t = useT();
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const stroke = Math.max(8, size / 16);
  const pad = size * 0.12;
  const box = size + pad * 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = grade ? gradeValue(grade) : 0;
  const color = gradeColor(grade);
  const center = box / 2;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      {live && grade && (
        <motion.div className="absolute inset-0 rounded-full" style={{ boxShadow: `0 0 0 2px ${color}` }} initial={{ scale: 0.9, opacity: 0.5 }} animate={{ scale: [0.92, 1.25], opacity: [0.45, 0] }} transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }} />
      )}
      <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} className="pointer-events-none absolute -rotate-90" style={{ left: -pad, top: -pad }} overflow="visible">
        <defs>
          <filter id={`glow${id}`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation={size / 28} />
          </filter>
        </defs>
        <circle cx={center} cy={center} r={r} fill="none" stroke="var(--nv-surface-3)" strokeWidth={stroke} />
        {/* Leuchten */}
        <motion.circle cx={center} cy={center} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} filter={`url(#glow${id})`} opacity={0.75} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v) }} transition={{ type: "spring", stiffness: 50, damping: 16 }} />
        <motion.circle cx={center} cy={center} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v) }} transition={{ type: "spring", stiffness: 50, damping: 16 }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.div key={grade ?? "none"} className="font-display font-bold tabular" style={{ fontSize: size * 0.36, lineHeight: 1, color }} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }}>
          {grade ?? "–"}
        </motion.div>
        <div className="mt-1.5 max-w-[70%] truncate text-center font-semibold tracking-[0.18em] text-muted uppercase" style={{ fontSize: Math.max(9, size * 0.06) }}>
          {label ?? t("grade.short")}
        </div>
      </div>
    </div>
  );
}
