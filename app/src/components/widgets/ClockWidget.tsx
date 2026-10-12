import { Clock } from "lucide-react";
import { motion } from "motion/react";
import { useNow } from "@/hooks/useNow";
import { getLanguage, useT } from "@/lib/i18n";
import { Widget } from "./Widget";

export function ClockWidget() {
  const t = useT();
  const now = useNow(1000);
  const d = new Date(now);
  const loc = getLanguage() === "de" ? "de-DE" : "en-US";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sec = d.getSeconds();
  return (
    <Widget title={t("widgets.clock")} icon={<Clock className="h-3.5 w-3.5" />}>
      <div className="flex flex-1 flex-col justify-center">
        <div className="flex items-baseline gap-1 font-display font-bold text-fg tabular">
          <span className="text-[52px] leading-none tracking-tight">{hh}</span>
          <motion.span className="text-[44px] leading-none text-accent" animate={{ opacity: [1, 0.25, 1] }} transition={{ duration: 1, repeat: Infinity }}>
            :
          </motion.span>
          <span className="text-[52px] leading-none tracking-tight">{mm}</span>
        </div>
        <div className="mt-2 text-sm text-muted capitalize">{d.toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" })}</div>
      </div>
      <div className="mt-3 flex gap-[3px]">
        {Array.from({ length: 60 }, (_, i) => (
          <span key={i} className="h-1 flex-1 rounded-full transition-colors duration-300" style={{ background: i <= sec ? "var(--nv-accent)" : "var(--nv-surface-3)", opacity: i <= sec ? 0.35 + (i / 60) * 0.65 : 1 }} />
        ))}
      </div>
    </Widget>
  );
}
