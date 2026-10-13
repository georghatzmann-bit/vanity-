import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "@/lib/i18n";
import { genCoverSpec } from "@/lib/gencover";
import { useUI } from "@/store/ui";
import { GameCover } from "./GameCover";
import { Starfield, type StarfieldHandle } from "@shared/ui/Starfield";
import { sound } from "@shared/sound/engine";

/** Start-Ritual: Cover zoomt ins Zentrum, Lichtring breitet sich aus, Partikel - dann blendet Pulsar aus */
export function LaunchRitual() {
  const t = useT();
  const game = useUI((s) => s.ritual);
  const setRitual = useUI((s) => s.setRitual);
  const stars = useRef<StarfieldHandle>(null);

  useEffect(() => {
    if (!game) return;
    sound.play("launch");
    const b = window.setTimeout(() => stars.current?.burst(window.innerWidth / 2, window.innerHeight / 2, { count: 200, speed: 11, life: 1.8 }), 700);
    const id = window.setTimeout(() => setRitual(null), 2400);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(b);
    };
  }, [game, setRitual]);

  const palette = game ? game.palette ?? genCoverSpec(game.name).palette : null;

  return (
    <AnimatePresence>
      {game && palette && (
        <motion.div className="fixed inset-0 grid place-items-center overflow-hidden" style={{ zIndex: "var(--nv-z-intro)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.5 } }} onClick={() => setRitual(null)}>
          <motion.div className="absolute inset-0" style={{ background: `radial-gradient(circle at 50% 50%, ${palette.primary}55, ${palette.dark} 60%, #000 100%)` }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} />
          <Starfield ref={stars} className="absolute inset-0" density={0.8} drift={3} parallax={false} />
          {[0, 1, 2].map((i) => (
            <motion.div key={i} className="absolute rounded-full border-2" style={{ borderColor: palette.primary, width: 260, height: 260 }} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 4.5, opacity: [0, 0.8, 0] }} transition={{ duration: 1.6, delay: 0.55 + i * 0.22, ease: [0.22, 1, 0.36, 1] }} />
          ))}
          <motion.div
            className="relative h-[330px] w-[220px] overflow-hidden rounded-2xl"
            style={{ boxShadow: `0 0 80px -10px ${palette.primary}, 0 30px 80px -20px #000` }}
            initial={{ scale: 0.5, rotateY: -35, rotateX: 12, opacity: 0, y: 60 }}
            animate={{ scale: [0.5, 1.08, 1], rotateY: 0, rotateX: 0, opacity: 1, y: 0 }}
            transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
          >
            <GameCover game={game} />
            <motion.div className="absolute inset-0" style={{ background: "linear-gradient(115deg, transparent 35%, rgb(255 255 255 / 0.45) 50%, transparent 65%)" }} initial={{ x: "-130%" }} animate={{ x: "130%" }} transition={{ duration: 0.9, delay: 0.7 }} />
          </motion.div>
          <motion.div className="absolute bottom-[16%] text-center" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 0.6 }}>
            <div className="text-[12px] font-semibold tracking-[0.4em] text-white/60 uppercase">{t("common.start")}</div>
            <div className="mt-2 font-display text-3xl font-bold text-white">{game.name}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
