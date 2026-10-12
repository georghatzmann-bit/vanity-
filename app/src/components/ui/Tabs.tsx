import { useId, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; badge?: ReactNode }[]; className?: string }) {
  const id = useId();
  return (
    <div className={cn("flex gap-1 border-b border-line", className)}>
      {tabs.map((tb) => {
        const active = tb.value === value;
        return (
          <button
            key={tb.value}
            type="button"
            onMouseEnter={() => sound.play("hover")}
            onClick={() => {
              if (!active) {
                sound.play("click");
                onChange(tb.value);
              }
            }}
            className={cn("relative flex h-11 items-center gap-2 px-4 text-sm font-medium transition-colors", active ? "text-fg" : "text-muted hover:text-fg-soft")}
          >
            {tb.label}
            {tb.badge}
            {active && <motion.span layoutId={`tab-${id}`} className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-gradient-accent shadow-[0_0_12px_var(--nv-accent)]" transition={spring.snappy} />}
          </button>
        );
      })}
    </div>
  );
}
