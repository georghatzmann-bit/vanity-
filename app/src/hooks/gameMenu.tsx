import { Eye, EyeOff, FolderOpen, Heart, ImageDown, Info, Play, Square, Trash2, Zap } from "lucide-react";
import type { MenuItem } from "@/components/ui/ContextMenu";
import { api, errorText } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { Game } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { confirmDialog, toast, useUI } from "@/store/ui";

/** Einträge des Rechtsklick-Menüs einer Spielkarte */
export function gameMenuItems(game: Game): MenuItem[] {
  const lib = useLibrary.getState();
  const running = lib.running.has(game.id);
  const items: MenuItem[] = [
    running
      ? { label: t("common.stop"), icon: <Square className="h-4 w-4" />, onClick: () => void lib.stop(game.id) }
      : { label: game.kind === "app" ? t("common.start") : t("games.boostAndPlay"), icon: <Zap className="h-4 w-4" />, onClick: () => void lib.launch(game, { boost: game.kind === "game" }) },
  ];
  if (!running && game.kind === "game") items.push({ label: t("common.play"), icon: <Play className="h-4 w-4" />, onClick: () => void lib.launch(game, { boost: false }) });
  items.push(
    { label: t("common.show"), icon: <Info className="h-4 w-4" />, onClick: () => useUI.getState().navigate({ page: "game", id: game.id }) },
    { separator: true, label: "" },
    { label: game.favorite ? t("game.unfavorite") : t("game.favorite"), icon: <Heart className="h-4 w-4" />, checked: game.favorite, onClick: () => lib.updateGame(game.id, { favorite: !game.favorite }) },
  );
  if (game.kind === "game") {
    items.push({ label: t("games.autoBoost"), icon: <Zap className="h-4 w-4" />, checked: game.autoBoost ?? undefined, onClick: () => lib.updateGame(game.id, { autoBoost: !(game.autoBoost ?? true) }) });
  }
  items.push({ separator: true, label: "" });
  if (game.installDir || game.exePath) {
    items.push({
      label: t("game.installDir"),
      icon: <FolderOpen className="h-4 w-4" />,
      onClick: () => void (game.installDir ? api.openPath(game.installDir) : api.revealPath(game.exePath!)).catch((e) => toast({ kind: "error", title: errorText(e) })),
    });
  }
  items.push(
    {
      label: t("game.autoImages"),
      icon: <ImageDown className="h-4 w-4" />,
      onClick: async () => {
        const n = await useLibrary.getState().fetchImages([game], { force: true });
        if (n) toast({ kind: "success", title: t("game.imagesLoaded") });
      },
    },
    { label: game.hidden ? t("game.unhide") : t("game.hide"), icon: game.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />, onClick: () => lib.updateGame(game.id, { hidden: !game.hidden }) },
    {
      label: t("common.remove"),
      icon: <Trash2 className="h-4 w-4" />,
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({ title: t("common.remove"), text: t("game.removeConfirm", { name: game.name }), danger: true, confirmLabel: t("common.remove") });
        if (!ok) return;
        await useLibrary.getState().removeGame(game.id);
        toast({ kind: "info", title: t("game.removed", { name: game.name }) });
        if (useUI.getState().route.id === game.id) useUI.getState().navigate({ page: "games" });
      },
    },
  );
  return items;
}
