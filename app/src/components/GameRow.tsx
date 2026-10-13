import { memo } from "react";
import { Heart, Play, Square } from "lucide-react";
import { formatDuration, formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Game, PlayStats } from "@/lib/types";
import { gameMenuItems } from "@/hooks/gameMenu";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { useContextMenu } from "./ui/ContextMenu";
import { GameCover } from "./GameCover";
import { sound } from "@shared/sound/engine";
import { cn } from "@shared/lib/cn";

/** Zeile in der Listenansicht */
export const GameRow = memo(function GameRow({ game, stats, running }: { game: Game; stats?: PlayStats; running?: boolean }) {
  const t = useT();
  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={() => {
        sound.play("hover");
        useUI.getState().setFocusGame(game.id);
      }}
      onClick={() => useUI.getState().navigate({ page: "game", id: game.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        useContextMenu.getState().open(e.clientX, e.clientY, gameMenuItems(game));
      }}
      className="group flex h-14 cursor-pointer items-center gap-4 rounded-lg px-3 transition hover:bg-surface-2"
    >
      <div className="h-11 w-[30px] shrink-0 overflow-hidden rounded-md shadow-sm">
        <GameCover game={game} />
      </div>
      <div className="min-w-0 flex-[2]">
        <div className="flex items-center gap-2 truncate text-sm font-medium text-fg">
          {game.name}
          {game.favorite && <Heart className="h-3 w-3 shrink-0 text-accent" fill="currentColor" />}
          {running && <span className="rounded-full bg-success/15 px-2 text-[11px] text-success">{t("common.running")}</span>}
        </div>
        <div className="truncate text-[12px] text-muted">
          {game.kind === "app" ? t("common.app") : t(`source.${game.source}`)}
        </div>
      </div>
      <div className="hidden flex-1 text-[13px] text-fg-soft tabular md:block">{stats?.totalSeconds ? formatDuration(stats.totalSeconds, { short: true }) : "–"}</div>
      <div className="hidden flex-1 text-[13px] text-muted lg:block">{formatRelative(stats?.lastPlayedAt)}</div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (running) void useLibrary.getState().stop(game.id);
          else void useLibrary.getState().launch(game);
        }}
        className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full text-white opacity-0 transition group-hover:opacity-100", running ? "bg-danger" : "bg-gradient-accent")}
        aria-label={t("common.play")}
      >
        {running ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <Play className="ml-0.5 h-3.5 w-3.5" fill="currentColor" />}
      </button>
    </div>
  );
});
