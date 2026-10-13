import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Dices, Play } from "lucide-react";
import { useT } from "@/lib/i18n";
import { pickGame } from "@/lib/dice";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { GameCover } from "../GameCover";
import { Widget } from "./Widget";
import { sound } from "@shared/sound/engine";

export function RandomWidget() {
  const t = useT();
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const [spin, setSpin] = useState(0);
  // Der Vorschlag bleibt stehen, bis neu gewürfelt wird – auch wenn sich Daten im Hintergrund ändern
  const [picked, setPicked] = useState<{ id: string; reason: string } | null>(null);
  const rolls = useRef(0);
  const roll = () => {
    rolls.current++;
    const p = pickGame(useLibrary.getState().games, useLibrary.getState().stats, {}, Date.now() + rolls.current);
    setPicked(p ? { id: p.game.id, reason: p.reason } : null);
  };
  useEffect(() => {
    if (!picked || !games.some((g) => g.id === picked.id && !g.hidden)) roll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, stats]);
  const game = picked ? games.find((g) => g.id === picked.id) : undefined;
  const pick = game && picked ? { game, reason: picked.reason } : null;

  return (
    <Widget
      title={t("widgets.random")}
      icon={<Dices className="h-3.5 w-3.5" />}
      action={
        <motion.button
          type="button"
          animate={{ rotate: spin * 360 }}
          transition={{ type: "spring", stiffness: 120, damping: 14 }}
          onClick={() => {
            sound.play("dice");
            setSpin((s) => s + 1);
            roll();
          }}
          className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-surface-2 hover:text-fg"
          aria-label={t("widgets.reroll")}
          title={t("widgets.reroll")}
        >
          <Dices className="h-4 w-4" />
        </motion.button>
      }
    >
      {!pick ? (
        <div className="flex flex-1 items-center text-sm text-muted">{t("widgets.randomEmpty")}</div>
      ) : (
        <AnimatePresence mode="wait">
          <motion.div key={pick.game.id} className="flex flex-1 items-center gap-3" initial={{ opacity: 0, x: 20, rotateY: -30 }} animate={{ opacity: 1, x: 0, rotateY: 0 }} exit={{ opacity: 0, x: -20, rotateY: 30 }} transition={{ duration: 0.35 }}>
            <button type="button" onClick={() => useUI.getState().navigate({ page: "game", id: pick.game.id })} className="h-[104px] w-[70px] shrink-0 overflow-hidden rounded-lg shadow-md transition hover:scale-105">
              <GameCover game={pick.game} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-base font-bold text-fg">{pick.game.name}</div>
              <div className="mt-0.5 text-[12px] text-muted">{t(pick.reason)}</div>
              <motion.button
                type="button"
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => void useLibrary.getState().launch(pick.game)}
                className="mt-3 flex h-8 items-center gap-1.5 rounded-full bg-gradient-accent px-3.5 text-[12px] font-semibold text-white shadow-glow"
              >
                <Play className="h-3.5 w-3.5" fill="currentColor" /> {t("common.play")}
              </motion.button>
            </div>
          </motion.div>
        </AnimatePresence>
      )}
    </Widget>
  );
}
