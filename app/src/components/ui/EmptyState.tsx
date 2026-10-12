import type { ReactNode } from "react";
import { motion } from "motion/react";
import { spring } from "@shared/design/motion";

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle} className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <div className="relative mb-5 grid h-16 w-16 place-items-center rounded-2xl border border-line bg-surface-2 text-accent">
        <div className="absolute inset-0 rounded-2xl opacity-60 blur-xl" style={{ background: "var(--nv-gradient-soft)" }} />
        <div className="relative" style={{ animation: "nv-float 4s ease-in-out infinite" }}>
          {icon}
        </div>
      </div>
      <h3 className="text-lg font-semibold text-fg">{title}</h3>
      {text && <p className="mt-2 text-sm leading-relaxed text-muted">{text}</p>}
      {action && <div className="mt-6">{action}</div>}
    </motion.div>
  );
}
