import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "@/lib/i18n";
import { NovaLogo } from "@shared/ui/NovaLogo";
import { Starfield, type StarfieldHandle } from "@shared/ui/Starfield";
import { sound } from "@shared/sound/engine";

/**
 * Startanimation: Sternenhimmel, das Logo zeichnet sich mit Glühen auf, Partikel explodieren,
 * dann gleitet das Logo in die Titelleiste (gemeinsame layoutId) und die App blendet ein.
 */
export function Intro({ onDone, onLeave, ready }: { onDone: () => void; onLeave: () => void; ready: boolean }) {
  const t = useT();
  const stars = useRef<StarfieldHandle>(null);
  const [phase, setPhase] = useState<"logo" | "leaving">("logo");
  const [minTimePassed, setMinTimePassed] = useState(false);

  useEffect(() => {
    sound.play("startup");
    const burst = window.setTimeout(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      stars.current?.burst(w / 2, h / 2 - 20, { count: 160, speed: 9, life: 2 });
    }, 650);
    const min = window.setTimeout(() => setMinTimePassed(true), 2100);
    return () => {
      window.clearTimeout(burst);
      window.clearTimeout(min);
    };
  }, []);

  useEffect(() => {
    if (minTimePassed && ready && phase === "logo") {
      setPhase("leaving");
      onLeave();
    }
  }, [minTimePassed, ready, phase, onLeave]);

  // Eigener Effekt für das Ausblenden - sonst würde der Timer beim Phasenwechsel gelöscht
  useEffect(() => {
    if (phase !== "leaving") return;
    const id = window.setTimeout(onDone, 750);
    return () => window.clearTimeout(id);
  }, [phase, onDone]);

  return (
    <motion.div className="fixed inset-0 grid place-items-center overflow-hidden" style={{ zIndex: "var(--nv-z-intro)", background: "var(--nv-bg)", pointerEvents: phase === "leaving" ? "none" : "auto" }} animate={{ opacity: phase === "leaving" ? 0 : 1 }} transition={{ duration: 0.6, delay: 0.1 }}>
      <div className="absolute inset-0" style={{ background: "radial-gradient(60% 50% at 50% 45%, var(--nv-glow-a), transparent 70%)" }} />
      <Starfield ref={stars} className="absolute inset-0" density={1.4} drift={0.4} parallax={false} />
      <div className="relative flex flex-col items-center">
        <motion.div className="absolute top-1/2 left-1/2 h-72 w-72 -translate-x-1/2 -translate-y-[60%] rounded-full blur-3xl" style={{ background: "radial-gradient(circle, color-mix(in oklab, var(--nv-accent) 45%, transparent), transparent 70%)" }} initial={{ scale: 0, opacity: 0 }} animate={{ scale: [0, 1.4, 1], opacity: [0, 1, 0.7] }} transition={{ duration: 1.6, delay: 0.3 }} />
        {phase === "logo" ? (
          <motion.div layoutId="nova-logo" transition={{ type: "spring", stiffness: 120, damping: 20 }}>
            <NovaLogo size={150} mode="intro" />
          </motion.div>
        ) : (
          <div style={{ width: 150, height: 150 }} />
        )}
        <AnimatePresence>
          {phase === "logo" && (
            <motion.div className="mt-8 flex flex-col items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -8 }}>
              <motion.div className="font-display text-[44px] font-bold tracking-[0.42em] text-fg" initial={{ opacity: 0, letterSpacing: "0.9em", filter: "blur(12px)" }} animate={{ opacity: 1, letterSpacing: "0.42em", filter: "blur(0px)" }} transition={{ duration: 1.4, delay: 0.9, ease: [0.22, 1, 0.36, 1] }}>
                NOVA
              </motion.div>
              <motion.div className="mt-3 text-sm tracking-[0.3em] text-muted uppercase" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.5, duration: 0.6 }}>
                {t("app.tagline")}
              </motion.div>
              <motion.div className="mt-10 h-[2px] w-40 overflow-hidden rounded-full bg-surface-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }}>
                <motion.div className="h-full w-1/2 rounded-full bg-gradient-accent" animate={{ x: ["-100%", "200%"] }} transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
