import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import type { Game } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { GameCard } from "./GameCard";
import { GameRow } from "./GameRow";

const GAP = 22;

/** Virtualisierte Kachel- oder Listenansicht - bleibt auch bei tausenden Einträgen flüssig */
export function GameGrid({ games, cardWidth, view, scrollRef }: { games: Game[]; cardWidth: number; view: "grid" | "list"; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const stats = useLibrary((s) => s.stats);
  const running = useLibrary((s) => s.running);
  const launching = useLibrary((s) => s.launching);
  const innerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = view === "list" ? 1 : Math.max(1, Math.floor((width + GAP) / (cardWidth + GAP)));
  // Kartenbreite so strecken, dass die Reihe bündig gefüllt ist
  const w = view === "list" ? width : Math.floor((width - GAP * (cols - 1)) / cols);
  const rowHeight = view === "list" ? 64 : Math.round(w * 1.5 + 52 + GAP);
  const rows = Math.ceil(games.length / cols);

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    scrollMargin: innerRef.current?.offsetTop ?? 0,
  });

  useEffect(() => {
    virt.measure();
  }, [rowHeight, cols, virt]);

  return (
    <div ref={innerRef} className="relative w-full" style={{ height: virt.getTotalSize() }}>
      {virt.getVirtualItems().map((row) => {
        const items = games.slice(row.index * cols, row.index * cols + cols);
        return (
          <div key={row.key} className="absolute top-0 left-0 flex w-full" style={{ transform: `translateY(${row.start - virt.options.scrollMargin}px)`, gap: view === "list" ? 0 : GAP, height: rowHeight }}>
            {items.map((g, i) =>
              view === "list" ? (
                <motion.div key={g.id} className="w-full" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, delay: Math.min(row.index, 12) * 0.02 }}>
                  <GameRow game={g} stats={stats.get(g.id)} running={running.has(g.id)} />
                </motion.div>
              ) : (
                <motion.div key={g.id} initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 200, damping: 24, delay: Math.min(row.index * cols + i, 24) * 0.025 }}>
                  <GameCard game={g} stats={stats.get(g.id)} running={running.has(g.id)} launching={launching.has(g.id)} width={w} />
                </motion.div>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}
