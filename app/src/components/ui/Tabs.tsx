import { useEffect, useId, useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; badge?: ReactNode }[]; className?: string }) {
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  // Aktiven Reiter sichtbar halten (schmale Fenster: Leiste scrollt waagerecht)
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>('[data-active="true"]');
    const box = bar.current;
    if (!el || !box) return;
    if (el.offsetLeft < box.scrollLeft || el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollTo({ left: el.offsetLeft - 16 });
  }, [value]);
  return (
    // Waagerecht scrollbar statt Umbruch (7 Reiter passen so auch bei 960 px). Der innere Rand
    // unten (pb-px/-mb-px) lässt die Markierung des aktiven Reiters wie bisher auf der Linie liegen.
    <div className={cn("border-b border-line", className)}>
      <div ref={bar} className="scrollbar-none relative -mb-px flex gap-1 overflow-x-auto overflow-y-hidden pb-px">
        {tabs.map((tb) => {
          const active = tb.value === value;
          return (
            <button
              key={tb.value}
              type="button"
              data-active={active}
              onMouseEnter={() => sound.play("hover")}
              onClick={() => {
                if (!active) {
                  sound.play("click");
                  onChange(tb.value);
                }
              }}
              className={cn("relative flex h-11 shrink-0 items-center gap-2 px-4 text-sm font-medium whitespace-nowrap transition-colors", active ? "text-fg" : "text-muted hover:text-fg-soft")}
            >
              {tb.label}
              {tb.badge}
              {active && <motion.span layoutId={`tab-${id}`} className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-gradient-accent shadow-[0_0_12px_var(--nv-accent)]" transition={spring.snappy} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
