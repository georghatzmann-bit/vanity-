/**
 * Countdown (C.7): Zeile in Mono 15, darunter 5 Segmente à 88 × 6 px (Abstand 8) oder ein
 * Balken 472 × 6. Verbleibende Segmente `fg-2`, abgelaufene `rule-strong`, das laufende schrumpft
 * in 1 s linear. Reduzierte Bewegung: Segmente schalten pro Sekunde, ohne Breitenanimation. Ohne Ton.
 */
import type { ReactNode } from "react";
import { motion } from "motion/react";

export interface CountdownProps {
  label: ReactNode;
  /** verbleibende Sekunden (null = angehalten) */
  seconds: number | null;
  total: number;
  mode: "segments" | "bar";
  /** Laufzeit des Balkens (mode `bar`) */
  durationMs?: number;
  reduced?: boolean;
}

export function Countdown({ label, seconds, total, mode, durationMs = 2600, reduced }: CountdownProps) {
  return (
    <div className="w-[472px]" data-testid="countdown" data-value={seconds ?? ""}>
      <div className="obs-value obs-value-md text-obs-fg">{label}</div>
      <div aria-hidden className="mt-2 flex h-1.5 gap-2">
        {mode === "bar" ? (
          <div className="relative h-1.5 w-[472px] bg-obs-rule-strong">
            <motion.div className="absolute inset-y-0 left-0 bg-obs-fg-2" initial={{ width: "100%" }} animate={{ width: reduced ? "100%" : "0%" }} transition={{ duration: durationMs / 1000, ease: "linear" }} />
          </div>
        ) : (
          Array.from({ length: total }, (_, i) => {
            const c = seconds ?? 0;
            const remaining = i < c - 1;
            const running = i === c - 1;
            return (
              <div key={i} className="relative h-1.5 w-[88px] bg-obs-rule-strong">
                {remaining && <div className="absolute inset-0 bg-obs-fg-2" />}
                {running &&
                  (reduced ? (
                    <div className="absolute inset-0 bg-obs-fg-2" />
                  ) : (
                    <motion.div key={c} className="absolute inset-y-0 left-0 bg-obs-fg-2" initial={{ width: "100%" }} animate={{ width: "0%" }} transition={{ duration: 1, ease: "linear" }} />
                  ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
