import { motion } from "motion/react";
import { Check, Pause, X } from "lucide-react";
import { EASE_OUT, SPRING_PLAYFUL } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface ProgressBeamProps {
  /** 0 … 1 */
  value: number;
  /** A light travels along the filled part (while something is in progress). */
  active?: boolean;
  /** Gold dot at the end of the fill (default true). */
  tip?: boolean;
  className?: string;
}

/** Thin progress line: brand gradient fill, travelling light, gold tip. Height via className (default 4 px). */
export function ProgressBeam({ value, active = false, tip = true, className }: ProgressBeamProps) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={cn("relative h-1 w-full rounded-full bg-white/[0.06]", className)}
    >
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full bg-brand shadow-[0_0_12px_rgb(122_60_255/0.6)]"
        initial={false}
        animate={{ width: `${v * 100}%` }}
        transition={{ duration: 0.6, ease: EASE_OUT }}
      >
        {active && v > 0 && (
          <span className="absolute inset-0 overflow-hidden rounded-full">
            <span className="nb-loop absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-white/70 to-transparent [animation:nb-beam_1.6s_ease-in-out_infinite]" />
          </span>
        )}
        {tip && v > 0 && (
          <span className="absolute top-1/2 right-0 size-2 translate-x-1/2 -translate-y-1/2 rounded-full bg-gold shadow-[0_0_10px_2px_rgb(255_200_87/0.55)]" />
        )}
      </motion.div>
    </div>
  );
}

export interface TimelineStep {
  label: string;
  hint?: string;
}

export interface StepTimelineProps {
  steps: readonly TimelineStep[];
  /** -1 = not started, 0 … n-1 = this step is running, n = all done. */
  current: number;
  /** The running step failed (shows a red cross). */
  failed?: boolean;
  /** The running step waits (e.g. a paused download): no moving light, amber instead of brand. */
  paused?: boolean;
  className?: string;
}

/**
 * Horizontal step list with a progress beam behind it (e.g. the "Host & Play" launch:
 * <StepTimeline steps={launchSteps} current={launchStep} />).
 */
export function StepTimeline({ steps, current, failed = false, paused = false, className }: StepTimelineProps) {
  const n = steps.length;
  const progress = current < 0 ? 0 : Math.min(current / Math.max(n - 1, 1), 1);
  const running = current >= 0 && current < n;
  const inset = `${50 / n}%`;
  return (
    <div className={cn("relative", className)}>
      <div className="absolute top-[15px]" style={{ left: inset, right: inset }}>
        <ProgressBeam value={progress} active={running && !failed && !paused} tip={running} className="h-[3px]" />
      </div>
      <ol className="relative grid gap-2" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {steps.map((s, i) => {
          const state = current > i ? "done" : current === i ? (failed ? "failed" : paused ? "paused" : "active") : "pending";
          return (
            <li key={s.label} className="flex min-w-0 flex-col items-center text-center">
              <div className="relative flex size-8 items-center justify-center">
                {state === "active" && (
                  <span
                    aria-hidden
                    className="nb-loop absolute -inset-[3px] rounded-full bg-[conic-gradient(from_0deg,transparent_0%,#b49bff_30%,#8fa8ff_45%,transparent_60%)] [animation:nb-orbit_1.4s_linear_infinite]"
                  />
                )}
                <motion.div
                  initial={false}
                  animate={{ scale: state === "active" ? 1.08 : 1 }}
                  transition={SPRING_PLAYFUL}
                  className={cn(
                    "relative flex size-8 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors duration-300",
                    state === "done" && "bg-success/15 text-success ring-1 ring-success/35",
                    state === "active" && "bg-brand text-white glow-primary",
                    state === "failed" && "bg-[color-mix(in_oklab,var(--destructive)_20%,var(--nb-surface))] text-destructive ring-1 ring-destructive/50",
                    state === "paused" && "bg-[color-mix(in_oklab,var(--warning)_15%,var(--nb-surface))] text-warning ring-1 ring-warning/45",
                    state === "pending" && "bg-surface text-muted-foreground ring-1 ring-white/[0.08]",
                  )}
                >
                  {state === "done" ? (
                    <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING_PLAYFUL}>
                      <Check className="size-4" strokeWidth={2.5} />
                    </motion.span>
                  ) : state === "failed" ? (
                    <X className="size-4" strokeWidth={2.5} />
                  ) : state === "paused" ? (
                    <Pause className="size-3.5" strokeWidth={2.5} />
                  ) : (
                    i + 1
                  )}
                </motion.div>
              </div>
              <p
                className={cn(
                  "mt-3 w-full truncate text-xs font-medium transition-colors duration-300",
                  state === "pending" ? "text-muted-foreground" : state === "active" ? "text-violet-text" : state === "paused" ? "text-warning" : "text-foreground",
                )}
              >
                {s.label}
              </p>
              {s.hint && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-faint">{s.hint}</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
