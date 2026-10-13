import { motion } from "motion/react";
import { gradeColor, gradeValue } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { Grade } from "@/lib/types";

/** Große Verbindungsnote als leuchtender Ring mit Puls */
export function GradeRing({ grade, size = 168, live = false, label }: { grade: Grade | null; size?: number; live?: boolean; label?: string }) {
  const t = useT();
  const stroke = Math.max(8, size / 16);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = grade ? gradeValue(grade) : 0;
  const color = gradeColor(grade);
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      {live && grade && (
        <motion.div className="absolute inset-0 rounded-full" style={{ boxShadow: `0 0 0 2px ${color}` }} initial={{ scale: 0.9, opacity: 0.5 }} animate={{ scale: [0.92, 1.25], opacity: [0.45, 0] }} transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }} />
      )}
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--nv-surface-3)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - v) }}
          transition={{ type: "spring", stiffness: 50, damping: 16 }}
          style={{ filter: `drop-shadow(0 0 ${size / 14}px ${color})` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.div key={grade ?? "none"} className="font-display font-bold tabular" style={{ fontSize: size * 0.36, lineHeight: 1, color }} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }}>
          {grade ?? "–"}
        </motion.div>
        <div className="mt-1 text-center text-[11px] font-semibold tracking-[0.16em] text-muted uppercase" style={{ fontSize: Math.max(9, size * 0.065) }}>
          {label ?? t("grade.label")}
        </div>
      </div>
    </div>
  );
}
