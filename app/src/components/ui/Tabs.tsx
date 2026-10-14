import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

/** Verlauf am Rand, nur auf der Seite mit verstecktem Inhalt */
function edgeMask(left: boolean, right: boolean): string | undefined {
  if (!left && !right) return undefined;
  return `linear-gradient(90deg, ${left ? "transparent" : "#000"}, #000 24px, #000 calc(100% - 24px), ${right ? "transparent" : "#000"})`;
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; badge?: ReactNode }[]; className?: string }) {
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ left: false, right: false });
  // Aktiven Reiter sichtbar halten (schmale Fenster: Leiste scrollt waagerecht)
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [value]);
  // Überlauf erkennen (Fenstergröße, Schriftwechsel, Scrollen) → Verlauf an der Seite mit verstecktem Inhalt
  useEffect(() => {
    const box = bar.current;
    if (!box) return;
    const update = () => {
      const over = box.scrollWidth > box.clientWidth + 1;
      const left = over && box.scrollLeft > 1;
      const right = over && box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
      setHidden((h) => (h.left === left && h.right === right ? h : { left, right }));
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(box);
    // Reiterbreiten ändern sich z. B. beim Sprachwechsel
    for (const child of Array.from(box.children)) ro?.observe(child);
    return () => {
      box.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [tabs.length]);
  const mask = edgeMask(hidden.left, hidden.right);
  return (
    // Waagerecht scrollbar statt Umbruch; unter 1100 px enger, damit 7 Reiter bei 960 px möglichst ganz
    // passen. Der innere Rand unten (pb-px/-mb-px) lässt die Markierung des aktiven Reiters auf der Linie liegen.
    <div className={cn("border-b border-line", className)}>
      <div ref={bar} className="scrollbar-none relative -mb-px flex gap-1 overflow-x-auto overflow-y-hidden pb-px max-[1100px]:gap-0" style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined} data-overflow-left={hidden.left} data-overflow-right={hidden.right}>
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
              className={cn("relative flex h-11 shrink-0 items-center gap-2 px-4 text-sm font-medium whitespace-nowrap transition-colors max-[1100px]:px-2.5", active ? "text-fg" : "text-muted hover:text-fg-soft")}
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
