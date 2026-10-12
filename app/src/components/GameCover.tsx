import { memo, useState } from "react";
import { imgSrc } from "@/lib/api";
import type { Game } from "@/lib/types";
import { cn } from "@shared/lib/cn";
import { GenCover } from "./GenCover";

/** Cover/Hintergrund eines Spiels mit Skelett beim Laden und Kunst-Cover als Ersatz */
export const GameCover = memo(function GameCover({ game, variant = "cover", className, imgClassName }: { game: Game; variant?: "cover" | "hero"; className?: string; imgClassName?: string }) {
  const path = variant === "hero" ? game.images.hero ?? game.images.cover : game.images.cover;
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const src = path && failed !== path ? imgSrc(path) : undefined;

  if (!src) {
    return <GenCover name={game.name} kind={game.kind} icon={game.images.icon} landscape={variant === "hero"} className={className} />;
  }
  return (
    <div className={cn("relative h-full w-full overflow-hidden", loaded !== path && "skeleton", className)}>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setLoaded(path ?? null)}
        onError={() => setFailed(path ?? null)}
        className={cn("h-full w-full object-cover transition-opacity duration-500", loaded === path ? "opacity-100" : "opacity-0", imgClassName)}
      />
    </div>
  );
});
