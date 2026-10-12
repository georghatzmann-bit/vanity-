import { useMemo, useRef } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import type { Game } from "@/lib/types";
import { gameMenuItems } from "@/hooks/gameMenu";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { useContextMenu } from "./ui/ContextMenu";
import { GenIcon } from "./GenCover";
import { imgSrc } from "@/lib/api";
import { sound } from "@shared/sound/engine";

function DockItem({ game, mouseX, running }: { game: Game; mouseX: MotionValue<number>; running: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const dist = useTransform(mouseX, (x) => {
    const r = ref.current?.getBoundingClientRect();
    return r ? x - (r.left + r.width / 2) : Infinity;
  });
  const size = useSpring(useTransform(dist, [-140, 0, 140], [46, 74, 46]), { stiffness: 320, damping: 22, mass: 0.4 });
  const lift = useTransform(size, [46, 74], [0, -10]);
  return (
    <motion.button
      ref={ref}
      type="button"
      style={{ width: size, height: size, y: lift }}
      onMouseEnter={() => sound.play("hover")}
      onClick={() => void useLibrary.getState().launch(game)}
      onContextMenu={(e) => {
        e.preventDefault();
        useContextMenu.getState().open(e.clientX, e.clientY, gameMenuItems(game));
      }}
      whileTap={{ scale: 0.85 }}
      className="group relative shrink-0"
      aria-label={game.name}
    >
      <div className="h-full w-full overflow-hidden rounded-[28%] shadow-[0_6px_18px_-6px_rgb(0_0_0/0.6)] ring-1 ring-white/10">
        {game.images.icon ? <div className="grid h-full w-full place-items-center bg-surface-solid p-[14%]"><img src={imgSrc(game.images.icon)} alt="" className="h-full w-full object-contain" /></div> : game.images.cover ? <img src={imgSrc(game.images.cover)} alt="" className="h-full w-full object-cover object-[50%_25%]" /> : <GenIcon name={game.name} />}
      </div>
      {running && <span className="absolute -bottom-2 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-success shadow-[0_0_6px_var(--nv-success)]" />}
      <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 rounded-md bg-surface-solid px-2 py-1 text-[11px] font-medium whitespace-nowrap text-fg opacity-0 shadow-lg ring-1 ring-line transition group-hover:opacity-100">{game.name}</span>
    </motion.button>
  );
}

/** Schnellstart-Leiste mit Lupen-Effekt (wie macOS) */
export function Dock() {
  const show = useSettings((s) => s.settings.showDock);
  const games = useLibrary((s) => s.games);
  const running = useLibrary((s) => s.running);
  const bigPicture = useUI((s) => s.bigPicture);
  const page = useUI((s) => s.route.page);
  const mouseX = useMotionValue(Infinity);
  const items = useMemo(() => games.filter((g) => g.inDock && !g.hidden).slice(0, 14), [games]);
  const visible = show && !bigPicture && items.length > 0 && page !== "settings";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div className="pointer-events-none fixed inset-x-0 bottom-4 flex justify-center" style={{ zIndex: "var(--nv-z-dock)" }} initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }} transition={{ type: "spring", stiffness: 220, damping: 26, delay: 0.3 }}>
          <motion.div onMouseMove={(e) => mouseX.set(e.clientX)} onMouseLeave={() => mouseX.set(Infinity)} className="glass-strong pointer-events-auto flex h-[66px] items-end gap-3 rounded-2xl px-3 pb-[10px]">
            {items.map((g) => (
              <DockItem key={g.id} game={g} mouseX={mouseX} running={running.has(g.id)} />
            ))}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
