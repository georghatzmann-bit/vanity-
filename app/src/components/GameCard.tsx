import { memo, useRef } from "react";
import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from "motion/react";
import { Heart, Loader2, Play, Square } from "lucide-react";
import { formatDuration, formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Game, PlayStats } from "@/lib/types";
import { gameMenuItems } from "@/hooks/gameMenu";
import { useContextMenu } from "./ui/ContextMenu";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { GameCover } from "./GameCover";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";
import { spawnRipple } from "@shared/ui/ripple";

let focusTimer: number | undefined;

export interface GameCardProps {
  game: Game;
  stats?: PlayStats;
  running?: boolean;
  launching?: boolean;
  width?: number;
  /** Breite vom Raster bestimmen lassen */
  fluid?: boolean;
  className?: string;
}

/**
 * Spielkarte: hebt sich beim Überfahren, neigt sich zur Maus (3D), leuchtende Kante,
 * Cover zoomt, Vorschau-Infos blenden ein.
 */
export const GameCard = memo(function GameCard({ game, stats, running, launching, width = 188, fluid, className }: GameCardProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const hover = useMotionValue(0);
  const rx = useSpring(useTransform(my, [0, 1], [7, -7]), { stiffness: 220, damping: 20 });
  const ry = useSpring(useTransform(mx, [0, 1], [-9, 9]), { stiffness: 220, damping: 20 });
  const glowX = useTransform(mx, (v) => `${v * 100}%`);
  const glowY = useTransform(my, (v) => `${v * 100}%`);
  const shine = useMotionTemplate`radial-gradient(circle at ${glowX} ${glowY}, rgb(255 255 255 / 0.22), transparent 55%)`;
  const hoverSpring = useSpring(hover, { stiffness: 300, damping: 26 });
  const shineOpacity = useTransform(hoverSpring, [0, 1], [0, 1]);

  const motionOff = typeof document !== "undefined" && document.documentElement.dataset.motion !== "full";

  const onMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || motionOff) return;
    const r = el.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width);
    my.set((e.clientY - r.top) / r.height);
  };

  const onEnter = () => {
    hover.set(1);
    sound.play("hover");
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => useUI.getState().setFocusGame(game.id), 140);
  };
  const onLeave = () => {
    hover.set(0);
    mx.set(0.5);
    my.set(0.5);
  };

  const open = () => useUI.getState().navigate({ page: "game", id: game.id });
  const play = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (running) void useLibrary.getState().stop(game.id);
    else void useLibrary.getState().launch(game);
  };

  return (
    <motion.div
      className={cn("group relative", fluid && "w-full", className)}
      style={{ width: fluid ? undefined : width, perspective: 900 }}
      whileHover={motionOff ? undefined : { y: -8, scale: 1.035, zIndex: 5 }}
      whileTap={{ scale: 0.98 }}
      transition={spring.gentle}
    >
      <motion.div
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label={game.name}
        onPointerMove={onMove}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onPointerDown={(e) => spawnRipple(e, "rgb(255 255 255 / 0.5)")}
        onClick={() => {
          sound.play("click");
          open();
        }}
        onDoubleClick={play}
        onKeyDown={(e) => {
          if (e.key === "Enter") open();
          if (e.key === " ") {
            e.preventDefault();
            void useLibrary.getState().launch(game);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          useContextMenu.getState().open(e.clientX, e.clientY, gameMenuItems(game));
        }}
        className="glow-edge card-shadow relative aspect-[2/3] cursor-pointer overflow-hidden rounded-xl bg-surface-2 outline-none [--glow-opacity:0] group-hover:[--glow-opacity:1] focus-visible:[--glow-opacity:1]"
        style={{ rotateX: motionOff ? 0 : rx, rotateY: motionOff ? 0 : ry, transformStyle: "preserve-3d" }}
      >
        <div className="absolute inset-0 transition-transform duration-[600ms] ease-nova group-hover:scale-[1.07]">
          <GameCover game={game} />
        </div>

        {/* Lichtreflex, der der Maus folgt */}
        <motion.div className="pointer-events-none absolute inset-0 mix-blend-soft-light" style={{ background: shine, opacity: shineOpacity }} />

        {/* Status oben */}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2.5">
          {running ? (
            <span className="flex items-center gap-1.5 rounded-full bg-success/90 px-2 py-0.5 text-[11px] font-semibold text-black shadow-[0_0_16px_var(--nv-success)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black/70" />
              {t("common.running")}
            </span>
          ) : launching ? (
            <span className="flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("common.start")}
            </span>
          ) : (
            <span />
          )}
          {game.favorite && (
            <span className="grid h-7 w-7 place-items-center rounded-full bg-black/40 backdrop-blur-md">
              <Heart className="h-3.5 w-3.5 text-accent" fill="currentColor" />
            </span>
          )}
        </div>

        {/* Vorschau-Infos */}
        <div className="absolute inset-x-0 bottom-0 translate-y-3 bg-gradient-to-t from-black/90 via-black/55 to-transparent p-3 pt-12 opacity-0 transition-all duration-300 ease-nova group-hover:translate-y-0 group-hover:opacity-100">
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0 text-white">
              <div className="truncate text-[13px] font-semibold">{game.name}</div>
              <div className="mt-0.5 truncate text-[11px] text-white/70">
                {stats?.totalSeconds ? `${formatDuration(stats.totalSeconds, { short: true })} · ${formatRelative(stats.lastPlayedAt)}` : t("library.neverPlayed")}
              </div>
            </div>
            <motion.button
              type="button"
              aria-label={running ? t("common.stop") : t("common.play")}
              whileHover={{ scale: 1.12 }}
              whileTap={{ scale: 0.9 }}
              onClick={play}
              onPointerDown={(e) => e.stopPropagation()}
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-full text-white shadow-[0_6px_20px_-4px_var(--nv-accent)]",
                running ? "bg-danger" : "bg-gradient-accent",
              )}
            >
              {running ? <Square className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
            </motion.button>
          </div>
        </div>
      </motion.div>
      <div className="mt-2.5 px-0.5">
        <div className="truncate text-[13px] font-medium text-fg">{game.name}</div>
        <div className="truncate text-[12px] text-muted">{stats?.totalSeconds ? formatDuration(stats.totalSeconds, { short: true }) : game.kind === "app" ? t("common.app") : t(`source.${game.source}`)}</div>
      </div>
    </motion.div>
  );
});
