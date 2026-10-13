import { motion } from "motion/react";
import { Check } from "lucide-react";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";

/** Senkrechte Schritt-Anzeige mit sich füllender Linie und animierten Häkchen */
export function StepRail({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="relative flex flex-col gap-5">
      <div className="absolute top-3 bottom-3 left-[13px] w-[2px] rounded-full bg-surface-3" />
      <motion.div className="absolute top-3 left-[13px] w-[2px] rounded-full bg-gradient-accent shadow-[0_0_10px_var(--nv-accent)]" animate={{ height: `calc(${(Math.min(current, steps.length - 1) / (steps.length - 1)) * 100}% - 12px)` }} transition={spring.smooth} />
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="relative flex items-center gap-3">
            <motion.span
              className={cn("relative z-10 grid h-7 w-7 place-items-center rounded-full border-2 text-[11px] font-bold", done ? "border-transparent bg-gradient-accent text-accent-fg" : active ? "border-accent bg-bg text-fg" : "border-line-strong bg-bg text-faint")}
              animate={{ scale: active ? 1.12 : 1 }}
              transition={spring.bouncy}
            >
              {done ? (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none">
                  <motion.path d="M5 12.5 L10 17 L19 7.5" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35 }} />
                </svg>
              ) : (
                i + 1
              )}
              {active && <motion.span className="absolute inset-0 rounded-full border-2 border-accent" animate={{ scale: [1, 1.6], opacity: [0.7, 0] }} transition={{ duration: 1.6, repeat: Infinity }} />}
            </motion.span>
            <span className={cn("text-[13px] font-medium transition-colors", active ? "text-fg" : done ? "text-fg-soft" : "text-faint")}>{s}</span>
            {done && <Check className="hidden" />}
          </li>
        );
      })}
    </ol>
  );
}
