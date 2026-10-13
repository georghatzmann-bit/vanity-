import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

/** Aufklappliste im Pulsar-Stil */
export function Select<T extends string>({ value, options, onChange, className, placeholder, align = "left", disabled = false }: { value: T; options: SelectOption<T>[]; onChange: (v: T) => void; className?: string; placeholder?: string; align?: "left" | "right"; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  // Gesperrt: eine offene Liste schließen
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onMouseEnter={() => !disabled && sound.play("hover")}
        onClick={() => {
          sound.play(open ? "close" : "open");
          setOpen(!open);
        }}
        className="flex h-10 w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-3 text-left text-sm text-fg transition hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line"
      >
        {current?.icon}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? <span className="text-faint">{placeholder}</span>}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={spring.snappy}>
          <ChevronDown className="h-4 w-4 text-muted" />
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className={cn("glass-strong absolute top-[calc(100%+6px)] z-50 max-h-72 min-w-full overflow-y-auto rounded-lg p-1", align === "right" ? "right-0" : "left-0")}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={spring.snappy}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onMouseEnter={() => sound.play("hover")}
                onClick={() => {
                  sound.play("click");
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap transition", o.value === value ? "bg-accent/12 text-fg" : "text-fg-soft hover:bg-surface-2 hover:text-fg")}
              >
                {o.icon}
                <span className="flex-1">{o.label}</span>
                {o.value === value && <Check className="h-4 w-4 text-accent" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
