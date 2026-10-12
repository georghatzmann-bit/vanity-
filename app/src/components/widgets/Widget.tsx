import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@shared/lib/cn";
import { staggerItem } from "@shared/design/motion";

/** Glas-Kachel für Startseiten-Widgets */
export function Widget({ title, icon, children, className, action }: { title: string; icon?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <motion.div variants={staggerItem} className={cn("glass group relative flex min-h-[176px] flex-col overflow-hidden rounded-xl p-4", className)}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
          <span className="text-accent transition-transform duration-500 group-hover:[animation:nv-wiggle_0.6s_ease]">{icon}</span>
          {title}
        </div>
        {action}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </motion.div>
  );
}
