import { motion } from "motion/react";
import { Loader2, Zap } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useBoost } from "@/store/boost";
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";
import { spawnRipple } from "@shared/ui/ripple";

/** Der große BOOST-Knopf: pulsierender Kern mit Druckwellen, wenn aktiv */
export function BoostButton({ size = 150, className }: { size?: number; className?: string }) {
  const t = useT();
  const active = useBoost((s) => s.state.active);
  const busy = useBoost((s) => s.busy);
  const toggle = useBoost((s) => s.toggle);
  return (
    <div className={cn("relative grid place-items-center", className)} style={{ width: size * 1.35, height: size * 1.35 }}>
      {active &&
        [0, 1, 2].map((i) => (
          <motion.span key={i} className="absolute rounded-full border-2 border-accent" style={{ width: size, height: size }} initial={{ scale: 0.9, opacity: 0.6 }} animate={{ scale: 1.5, opacity: 0 }} transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: "easeOut" }} />
        ))}
      <motion.button
        type="button"
        aria-pressed={active}
        disabled={busy}
        onMouseEnter={() => sound.play("hover")}
        onPointerDown={(e) => spawnRipple(e, "rgb(255 255 255 / 0.4)")}
        onClick={() => void toggle()}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.95 }}
        animate={active ? { boxShadow: ["0 0 40px -6px var(--nv-accent)", "0 0 80px -4px var(--nv-accent)", "0 0 40px -6px var(--nv-accent)"] } : { boxShadow: "0 18px 50px -18px var(--nv-accent)" }}
        transition={active ? { duration: 2, repeat: Infinity, ease: "easeInOut" } : { type: "spring", stiffness: 300, damping: 24 }}
        className={cn("relative grid place-items-center rounded-full font-display font-bold tracking-[0.2em] text-accent-fg uppercase outline-none focus-visible:ring-4 focus-visible:ring-accent/40", active ? "bg-gradient-accent" : "bg-gradient-accent")}
        style={{ width: size, height: size, fontSize: size * 0.16 }}
      >
        <span className="absolute inset-[3px] rounded-full ring-1 ring-white/40" />
        <span className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle at 35% 30%, rgb(255 255 255 / 0.45), transparent 55%)" }} />
        <span className="relative flex flex-col items-center gap-1">
          {busy ? <Loader2 className="animate-spin" style={{ width: size * 0.26, height: size * 0.26 }} /> : <Zap style={{ width: size * 0.26, height: size * 0.26 }} fill={active ? "currentColor" : "none"} />}
          <span>{active ? t("common.stop") : t("cockpit.boost")}</span>
        </span>
      </motion.button>
    </div>
  );
}
