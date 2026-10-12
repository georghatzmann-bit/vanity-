import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@shared/lib/cn";

/** Kleiner Hinweis beim Überfahren */
export function Tooltip({ label, children, side = "top", className }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "right"; className?: string }) {
  const [show, setShow] = useState(false);
  const pos = side === "top" ? "bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2" : side === "bottom" ? "top-[calc(100%+8px)] left-1/2 -translate-x-1/2" : "left-[calc(100%+10px)] top-1/2 -translate-y-1/2";
  return (
    <span className={cn("relative inline-flex", className)} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onFocus={() => setShow(true)} onBlur={() => setShow(false)}>
      {children}
      <AnimatePresence>
        {show && (
          <motion.span
            className={cn("pointer-events-none absolute z-50 rounded-md bg-surface-solid px-2.5 py-1.5 text-[12px] font-medium whitespace-nowrap text-fg shadow-lg ring-1 ring-line", pos)}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.12, delay: 0.25 }}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
