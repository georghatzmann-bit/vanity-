import { useId, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

/** Umschalter mit gleitender Markierung */
export function Segmented<T extends string>({ value, options, onChange, className, size = "md" }: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; className?: string; size?: "sm" | "md" }) {
  const id = useId();
  return (
    <div className={cn("inline-flex rounded-md border border-line bg-surface p-1", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onMouseEnter={() => sound.play("hover")}
            onClick={() => {
              if (!active) {
                sound.play("click");
                onChange(o.value);
              }
            }}
            className={cn(
              "relative flex items-center gap-1.5 rounded-sm font-medium transition-colors duration-200",
              size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
              active ? "text-fg" : "text-muted hover:text-fg-soft",
            )}
          >
            {active && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-sm bg-surface-3 shadow-sm" transition={spring.snappy} />}
            <span className="relative flex items-center gap-1.5">
              {o.icon}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
