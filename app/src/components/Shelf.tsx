import { useRef, useState, useEffect } from "react";
import { motion } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Game } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { GameCard } from "./GameCard";
import { staggerContainer, staggerItem } from "@shared/design/motion";
import { cn } from "@shared/lib/cn";

/** Horizontale Reihe von Spielkarten mit Pfeilen */
export function Shelf({ title, games, action, cardWidth = 168 }: { title: string; games: Game[]; action?: React.ReactNode; cardWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const stats = useLibrary((s) => s.stats);
  const running = useLibrary((s) => s.running);
  const launching = useLibrary((s) => s.launching);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = () => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 8, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 });
  };
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [games.length]);

  if (!games.length) return null;
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * (ref.current.clientWidth * 0.8), behavior: "smooth" });

  return (
    <section className="group/shelf">
      <div className="mb-3 flex items-end justify-between px-1">
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        <div className="flex items-center gap-2">
          {action}
          <div className="flex gap-1 opacity-0 transition-opacity group-hover/shelf:opacity-100">
            <button type="button" disabled={!edges.left} onClick={() => scroll(-1)} className="grid h-8 w-8 place-items-center rounded-full border border-line bg-surface text-muted transition hover:text-fg disabled:opacity-30" aria-label="links">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" disabled={!edges.right} onClick={() => scroll(1)} className="grid h-8 w-8 place-items-center rounded-full border border-line bg-surface text-muted transition hover:text-fg disabled:opacity-30" aria-label="rechts">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      <motion.div
        ref={ref}
        onScroll={update}
        variants={staggerContainer(0.04, 0.05)}
        initial="initial"
        animate="enter"
        className={cn("scrollbar-none -mx-3 -mt-3 flex gap-5 overflow-x-auto px-4 pt-4 pb-3", "mask-fade-x")}
      >
        {games.map((g) => (
          <motion.div key={g.id} variants={staggerItem} className="shrink-0">
            <GameCard game={g} stats={stats.get(g.id)} running={running.has(g.id)} launching={launching.has(g.id)} width={cardWidth} />
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
