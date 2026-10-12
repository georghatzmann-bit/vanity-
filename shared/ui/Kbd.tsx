import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Tastenkürzel-Anzeige */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-strong bg-surface-2 px-1.5 font-sans text-[11px] font-medium text-muted shadow-[inset_0_-1px_0_var(--nv-border)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
