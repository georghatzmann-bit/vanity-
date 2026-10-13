import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@shared/lib/cn";
import { Toggle } from "@shared/ui/Toggle";
import { sound } from "@shared/sound/engine";

export function OptionCard({ icon, title, desc, checked, onChange }: { icon: ReactNode; title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <motion.div
      role="button"
      tabIndex={0}
      onMouseEnter={() => sound.play("hover")}
      onClick={() => {
        sound.play(checked ? "toggleOff" : "toggleOn");
        onChange(!checked);
      }}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), onChange(!checked))}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.985 }}
      className={cn("glow-edge flex cursor-pointer items-center gap-4 rounded-xl border p-4 transition-colors", checked ? "border-transparent bg-accent/10 [--glow-opacity:1]" : "border-line bg-surface hover:border-line-strong")}
    >
      <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-colors", checked ? "bg-gradient-accent text-white shadow-glow" : "bg-surface-2 text-muted")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-fg">{title}</div>
        <div className="text-[12px] text-muted">{desc}</div>
      </div>
      <div onClick={(e) => e.stopPropagation()}>
        <Toggle checked={checked} onChange={onChange} />
      </div>
    </motion.div>
  );
}
