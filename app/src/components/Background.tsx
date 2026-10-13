import { memo, useEffect } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { imgSrc } from "@/lib/api";
import { gradeColor } from "@/lib/grade";
import { genCoverSpec } from "@/lib/gencover";
import { useLibrary } from "@/store/library";
import { useNet } from "@/store/net";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { Starfield } from "@shared/ui/Starfield";

/**
 * Lebendiger Hintergrund: Farbglühen in der Farbe der aktuellen Verbindungsnote,
 * unscharfes Cover des gewählten Spiels, Sternenhimmel und leichter Parallax-Effekt zur Maus.
 */
export const Background = memo(function Background() {
  const focusId = useUI((s) => s.focusGameId);
  const game = useLibrary((s) => (focusId ? s.games.find((g) => g.id === focusId) : undefined));
  const { motion: motionLevel, theme } = useSettings((s) => s.settings);
  const grade = useNet((s) => s.grade);

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 40, damping: 18 });
  const sy = useSpring(my, { stiffness: 40, damping: 18 });
  const imgX = useTransform(sx, (v) => v * -18);
  const imgY = useTransform(sy, (v) => v * -12);
  const glowX = useTransform(sx, (v) => v * 36);
  const glowY = useTransform(sy, (v) => v * 24);

  const parallaxOn = motionLevel === "full";

  useEffect(() => {
    if (!parallaxOn) {
      mx.set(0);
      my.set(0);
      return;
    }
    const onMove = (e: PointerEvent) => {
      mx.set((e.clientX / window.innerWidth - 0.5) * 2);
      my.set((e.clientY / window.innerHeight - 0.5) * 2);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [parallaxOn, mx, my]);

  const image = game ? game.images.hero ?? game.images.cover : undefined;
  const palette = game ? game.palette ?? genCoverSpec(game.name).palette : undefined;
  const light = theme === "frost";

  // Ohne Spiel färbt die Verbindungsnote das Glühen leicht mit (grün = gut, rot = schlecht)
  const gradeTint = grade ? gradeColor(grade) : null;
  const glowA = palette ? `color-mix(in oklab, ${palette.primary} ${light ? 22 : 34}%, transparent)` : gradeTint ? `color-mix(in oklab, ${gradeTint} ${light ? 14 : 20}%, transparent)` : "var(--nv-glow-a)";
  const glowB = palette ? `color-mix(in oklab, ${palette.secondary} ${light ? 18 : 28}%, transparent)` : "var(--nv-glow-b)";
  const glowC = palette ? `color-mix(in oklab, ${palette.primary} 14%, transparent)` : "var(--nv-glow-c)";

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" style={{ zIndex: "var(--nv-z-bg)", background: "var(--nv-bg)" }} aria-hidden>
      {/* Unscharfes Cover */}
      <AnimatePresence>
        {image && (
          <motion.div key={image} className="absolute -inset-[8%]" initial={{ opacity: 0 }} animate={{ opacity: light ? 0.35 : 0.55 }} exit={{ opacity: 0 }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }} style={{ x: imgX, y: imgY }}>
            <img src={imgSrc(image)} alt="" className="h-full w-full scale-110 object-cover" style={{ filter: "blur(70px) saturate(1.35)" }} draggable={false} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Farbglühen (Aurora) */}
      <motion.div className="absolute inset-0" style={{ x: glowX, y: glowY }}>
        <div className="absolute -top-[25%] -left-[10%] h-[80%] w-[60%] rounded-full blur-[90px] transition-[background] duration-1000" style={{ background: `radial-gradient(circle, ${glowA}, transparent 70%)`, animation: "nv-aurora 22s ease-in-out infinite" }} />
        <div className="absolute -right-[12%] -bottom-[30%] h-[85%] w-[65%] rounded-full blur-[100px] transition-[background] duration-1000" style={{ background: `radial-gradient(circle, ${glowB}, transparent 70%)`, animation: "nv-aurora 28s ease-in-out infinite reverse" }} />
        <div className="absolute top-[30%] left-[35%] h-[50%] w-[40%] rounded-full blur-[110px] transition-[background] duration-1000" style={{ background: `radial-gradient(circle, ${glowC}, transparent 70%)`, animation: "nv-aurora 34s ease-in-out infinite" }} />
      </motion.div>

      {/* Feines Raster – wirkt wie ein Radar-Schirm */}
      <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "linear-gradient(var(--nv-fg) 1px, transparent 1px), linear-gradient(90deg, var(--nv-fg) 1px, transparent 1px)", backgroundSize: "48px 48px", maskImage: "radial-gradient(70% 60% at 50% 40%, black 30%, transparent 100%)" }} />

      {/* Lesbarkeit: dunkler (bzw. heller) Schleier */}
      <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, color-mix(in oklab, var(--nv-bg) calc(var(--nv-backdrop-dim) * 70%), transparent) 0%, color-mix(in oklab, var(--nv-bg) calc(var(--nv-backdrop-dim) * 100%), transparent) 75%)` }} />

      {motionLevel !== "off" && <Starfield className="absolute inset-0 opacity-80" density={light ? 0.5 : 1.1} parallax={parallaxOn} drift={motionLevel === "full" ? 1 : 0} />}

      {/* Vignette + Filmkorn */}
      <div className="absolute inset-0" style={{ background: "radial-gradient(120% 90% at 50% 40%, transparent 55%, color-mix(in oklab, var(--nv-bg) 70%, transparent) 100%)" }} />
      <div className="noise absolute inset-0" />
    </div>
  );
});
