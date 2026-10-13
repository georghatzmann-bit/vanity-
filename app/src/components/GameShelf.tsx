import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { Game } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { GameCard } from "./GameCard";
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";

/** Waagerechte Reihe mit Spiel-Covern (wie „Kürzlich gespielt“ bei NOVA), mit Pfeilen zum Blättern */
export function GameShelf({ title, games, onShowAll, icon, cardWidth = 168 }: { title: string; games: Game[]; onShowAll?: () => void; icon?: ReactNode; cardWidth?: number }) {
  const t = useT();
  const stats = useLibrary((s) => s.stats);
  const running = useLibrary((s) => s.running);
  const launching = useLibrary((s) => s.launching);
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = () => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 8, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 });
  };
  useEffect(() => {
    updateEdges();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [games.length]);

  const scroll = (dir: number) => {
    const el = ref.current;
    if (!el) return;
    sound.play("whoosh", { gain: 0.4 });
    el.scrollBy({ left: dir * Math.max(cardWidth * 2, el.clientWidth * 0.8), behavior: "smooth" });
  };

  if (!games.length) return null;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-fg">
          {icon && <span className="text-accent">{icon}</span>}
          {title}
        </h2>
        <div className="flex items-center gap-1">
          {onShowAll && (
            <button type="button" onClick={onShowAll} className="mr-2 flex items-center gap-1 text-[13px] text-muted transition hover:text-fg">
              {t("cockpit.showAll")} <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
          {[-1, 1].map((d) => (
            <button
              key={d}
              type="button"
              disabled={d < 0 ? !edges.left : !edges.right}
              onClick={() => scroll(d)}
              className="grid h-8 w-8 place-items-center rounded-full border border-line bg-surface text-muted transition hover:border-line-strong hover:text-fg disabled:opacity-30"
              aria-label={d < 0 ? "←" : "→"}
            >
              {d < 0 ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <div ref={ref} onScroll={updateEdges} className="no-scrollbar -mx-2 -my-3 flex snap-x gap-4 overflow-x-auto scroll-smooth px-2 py-3">
          {games.map((g, i) => (
            <motion.div key={g.id} className="shrink-0 snap-start" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.035, type: "spring", stiffness: 220, damping: 24 }}>
              <GameCard game={g} stats={stats.get(g.id)} running={running.has(g.id)} launching={launching.has(g.id)} width={cardWidth} />
            </motion.div>
          ))}
        </div>
        {/* weiche Kanten links/rechts, wenn es weitergeht */}
        <div className={cn("pointer-events-none absolute inset-y-0 -left-2 w-10 bg-gradient-to-r from-[var(--nv-bg)] to-transparent transition-opacity", edges.left ? "opacity-100" : "opacity-0")} />
        <div className={cn("pointer-events-none absolute inset-y-0 -right-2 w-10 bg-gradient-to-l from-[var(--nv-bg)] to-transparent transition-opacity", edges.right ? "opacity-100" : "opacity-0")} />
      </div>
    </section>
  );
}
