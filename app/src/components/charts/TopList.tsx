import { motion } from "motion/react";
import { formatDuration } from "@/lib/format";
import type { Game } from "@/lib/types";
import { useUI } from "@/store/ui";
import { GameCover } from "../GameCover";

/** Rangliste mit Cover, Balken und Zeit */
export function TopList({ items }: { items: { game: Game; seconds: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.seconds));
  return (
    <div className="flex flex-col gap-2.5">
      {items.map(({ game, seconds }, i) => (
        <button key={game.id} type="button" onClick={() => useUI.getState().navigate({ page: "game", id: game.id })} className="group flex items-center gap-3 rounded-lg p-1 text-left transition hover:bg-surface-2">
          <span className="w-5 text-center font-display text-sm font-bold text-faint">{i + 1}</span>
          <div className="h-12 w-8 shrink-0 overflow-hidden rounded-md shadow">
            <GameCover game={game} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[13px] font-medium text-fg">{game.name}</span>
              <span className="shrink-0 text-[12px] text-muted tabular">{formatDuration(seconds, { short: true })}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <motion.div className="h-full rounded-full bg-gradient-accent" initial={{ width: 0 }} animate={{ width: `${(seconds / max) * 100}%` }} transition={{ type: "spring", stiffness: 70, damping: 18, delay: 0.1 + i * 0.06 }} />
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
